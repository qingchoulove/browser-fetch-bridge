const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AdapterError, AdapterRegistry } = require('../lib/adapter-registry');

function makeAdapter(overrides = {}) {
  return {
    name: 'fixture.read',
    description: 'Fixture read adapter',
    effect: 'read',
    agentStandard: true,
    risk: {
      readOnly: overrides.effect !== 'mutation',
      destructive: overrides.effect === 'mutation',
      idempotent: overrides.effect !== 'mutation',
      openWorld: false,
    },
    retry: 'never',
    requires: ['fetch.json', 'fetch.started-ack'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: { id: { type: 'integer', minimum: 1 } },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'value'],
      properties: {
        id: { type: 'integer' },
        value: { type: 'string' },
      },
    },
    buildRequest(input) {
      return {
        tabUrl: 'https://example.com/app',
        timeoutMs: 30000,
        request: {
          url: `https://example.com/api/items/${input.id}`,
          method: 'GET',
          responseType: 'json',
        },
      };
    },
    parseResponse(response) {
      return response.json;
    },
    ...overrides,
  };
}

function capabilities() {
  return ['fetch.json', 'fetch.started-ack'];
}

test('registry rejects ungoverned, misleading-risk, and retrying adapters', () => {
  for (const overrides of [
    { agentStandard: false },
    { risk: { readOnly: false, destructive: false, idempotent: true, openWorld: false } },
    { retry: { mode: 'safe', maxAttempts: 2 } },
  ]) {
    assert.throws(() => new AdapterRegistry({ adapters: [makeAdapter(overrides)] }),
      (error) => error.code === 'adapter_invalid');
  }
});

test('registry rejects duplicate adapter names', () => {
  assert.throws(
    () => new AdapterRegistry({ adapters: [makeAdapter(), makeAdapter()] }),
    (error) => error instanceof AdapterError && error.code === 'adapter_duplicate',
  );
});

test('registry validates adapter input before building a request', async () => {
  const registry = new AdapterRegistry({ adapters: [makeAdapter()] });

  await assert.rejects(
    registry.run('fixture.read', { id: 0 }, { capabilities: capabilities() }),
    (error) => error.code === 'input_schema_invalid' && error.errors.length > 0,
  );
});

test('registry rejects missing extension capabilities before dispatch', async () => {
  let dispatched = false;
  const registry = new AdapterRegistry({
    adapters: [makeAdapter()],
    transport: async () => {
      dispatched = true;
    },
  });

  await assert.rejects(
    registry.run('fixture.read', { id: 1 }, { capabilities: ['fetch.json'] }),
    (error) => error.code === 'capability_missing'
      && error.required[0] === 'fetch.started-ack',
  );
  assert.equal(dispatched, false);
});

test('mutation defaults to preparation and requires its token for exactly one dispatch', async (t) => {
  let dispatchCount = 0;
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-authorization-'));
  t.after(() => fs.rmSync(stateDirectory, { recursive: true, force: true }));
  const mutation = makeAdapter({
    name: 'fixture.mutation',
    description: 'Fixture mutation adapter',
    effect: 'mutation',
    retry: 'never',
  });
  const registry = new AdapterRegistry({
    adapters: [mutation],
    stateDirectory,
    transport: async () => {
      dispatchCount += 1;
      return { result: { json: { id: 1, value: 'applied' } } };
    },
  });

  const dryRun = await registry.run('fixture.mutation', { id: 1 });
  assert.equal(dryRun.mode, 'dry-run');
  assert.equal('warnings' in dryRun, false);
  assert.equal(dispatchCount, 0);
  await assert.rejects(registry.run('fixture.mutation', { id: 1 }, {
    apply: true, capabilities: capabilities(),
  }), (error) => error.code === 'authorization_required');
  assert.equal(dispatchCount, 0);

  const applied = await registry.run('fixture.mutation', { id: 1 }, {
    apply: true,
    preparationToken: dryRun.preparationToken,
    capabilities: capabilities(),
  });
  assert.equal(applied.mode, 'apply');
  assert.equal(Object.hasOwn(applied, 'applied'), false);
  assert.equal(applied.dispatchState, 'completed');
  assert.equal('warnings' in applied, false);
  assert.equal(applied.data.value, 'applied');
  assert.equal(dispatchCount, 1);
});

test('read dispatch failures remain one attempt instead of automatically retrying', async () => {
  let dispatchCount = 0;
  const registry = new AdapterRegistry({
    adapters: [makeAdapter()],
    transport: async () => {
      dispatchCount += 1;
      throw Object.assign(new Error('extension disconnected'), {
        code: 'result_unknown', dispatchState: 'dispatched_unacknowledged',
      });
    },
  });
  await assert.rejects(
    registry.run('fixture.read', { id: 1 }, { capabilities: capabilities() }),
    (error) => error.code === 'result_unknown' && error.attempts.length === 1 && error.retryable === false,
  );
  assert.equal(dispatchCount, 1);
});

test('mutation never retries result_unknown', async (t) => {
  let dispatchCount = 0;
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-authorization-'));
  t.after(() => fs.rmSync(stateDirectory, { recursive: true, force: true }));
  const mutation = makeAdapter({
    name: 'fixture.mutation',
    description: 'Fixture mutation adapter',
    effect: 'mutation',
    retry: 'never',
  });
  const registry = new AdapterRegistry({
    adapters: [mutation],
    stateDirectory,
    transport: async () => {
      dispatchCount += 1;
      const error = new Error('result unknown');
      error.code = 'result_unknown';
      error.dispatchState = 'started';
      throw error;
    },
  });
  const prepared = await registry.run('fixture.mutation', { id: 1 });

  await assert.rejects(
    registry.run('fixture.mutation', { id: 1 }, {
      apply: true,
      preparationToken: prepared.preparationToken,
      capabilities: capabilities(),
    }),
    (error) => error.code === 'result_unknown'
      && error.dispatchState === 'started'
      && error.attempts.length === 1,
  );
  assert.equal(dispatchCount, 1);
});

test('registry rejects relative tabUrl as an invalid request plan', async () => {
  const adapter = makeAdapter({
    buildRequest() {
      return {
        tabUrl: '/app',
        timeoutMs: 30000,
        request: { url: '/api/items/1', method: 'GET', responseType: 'json' },
      };
    },
  });
  const registry = new AdapterRegistry({ adapters: [adapter] });

  await assert.rejects(
    registry.run('fixture.read', { id: 1 }, { capabilities: capabilities() }),
    (error) => error.code === 'request_plan_invalid',
  );
});

test('registry infers not_dispatched for connection failures without a dispatch state', async () => {
  const registry = new AdapterRegistry({
    adapters: [makeAdapter()],
    transport: async () => {
      const error = new Error('refused');
      error.code = 'ECONNREFUSED';
      throw error;
    },
  });

  await assert.rejects(
    registry.run('fixture.read', { id: 1 }, { capabilities: capabilities() }),
    (error) => error.code === 'ECONNREFUSED' && error.dispatchState === 'not_dispatched',
  );
});

test('registry rejects non-2xx endpoint responses before adapter parsing', async () => {
  const registry = new AdapterRegistry({
    adapters: [makeAdapter()],
    transport: async () => ({
      result: {
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        json: { id: 1, value: 'must not pass' },
      },
    }),
  });

  await assert.rejects(
    registry.run('fixture.read', { id: 1 }, { capabilities: capabilities() }),
    (error) => error.code === 'http_error'
      && error.status === 503
      && error.dispatchState === 'completed',
  );
});

test('registry fails closed when normalized output violates schema', async () => {
  const registry = new AdapterRegistry({
    adapters: [makeAdapter()],
    transport: async () => ({ result: { json: { id: 1 } } }),
  });

  await assert.rejects(
    registry.run('fixture.read', { id: 1 }, { capabilities: capabilities() }),
    (error) => error.code === 'output_schema_invalid',
  );
});

test('retain-on-failure writes an unredacted 0600 trace', async (t) => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-trace-'));
  t.after(() => fs.rmSync(stateDirectory, { recursive: true, force: true }));
  const registry = new AdapterRegistry({
    adapters: [makeAdapter()],
    stateDirectory,
    transport: async () => ({ result: { json: { id: 1, secret: 'raw-secret' } } }),
  });

  let failure;
  try {
    await registry.run('fixture.read', { id: 1 }, {
      capabilities: capabilities(),
      trace: 'retain-on-failure',
    });
  } catch (error) {
    failure = error;
  }

  assert.equal(failure.code, 'output_schema_invalid');
  assert.equal(fs.statSync(path.dirname(failure.traceFile)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(failure.traceFile).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(failure.traceFile, 'utf8'), /raw-secret/);
});

function governedMutation() {
  return makeAdapter({
    name: 'fixture.governed-mutation',
    agentStandard: true,
    effect: 'mutation',
    retry: 'never',
    risk: { readOnly: false, destructive: true, idempotent: false, openWorld: true },
    buildRequest(input) {
      return {
        tabUrl: 'https://example.com/app',
        timeoutMs: 120000,
        request: {
          url: `https://example.com/api/items/${input.id}`,
          method: 'DELETE',
          responseType: 'json',
        },
      };
    },
  });
}

test('governed authorization binds input and plan across registry instances and expires', async (t) => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-authorization-'));
  t.after(() => fs.rmSync(stateDirectory, { recursive: true, force: true }));
  const adapter = governedMutation();
  let dispatches = 0;
  const transport = async () => {
    dispatches += 1;
    return { json: { id: 1, value: 'acknowledged' } };
  };
  const registry = new AdapterRegistry({ adapters: [adapter], stateDirectory, transport });
  const input = { id: 1 };
  const prepared = await registry.run(adapter.name, input);
  const options = { apply: true, capabilities: capabilities(), preparationToken: prepared.preparationToken };
  await assert.rejects(registry.run(adapter.name, input, { ...options, preparationToken: undefined }),
    (error) => error.code === 'authorization_required' && error.dispatchState === 'not_dispatched');
  await assert.rejects(registry.run(adapter.name, { id: 2 }, options),
    (error) => error.code === 'authorization_mismatch');
  const changed = new AdapterRegistry({
    adapters: [{ ...adapter, buildRequest: (value) => ({
      ...adapter.buildRequest(value), timeoutMs: 1000,
    }) }],
    stateDirectory, transport,
  });
  await assert.rejects(changed.run(adapter.name, input, options),
    (error) => error.code === 'authorization_mismatch');
  assert.equal(dispatches, 0);
  const reopened = new AdapterRegistry({ adapters: [adapter], stateDirectory, transport });
  const result = await reopened.run(adapter.name, input, options);
  assert.equal(result.data.value, 'acknowledged');
  assert.equal(Object.hasOwn(result, 'applied'), false);
  await assert.rejects(registry.run(adapter.name, input, options),
    (error) => error.code === 'authorization_consumed');
  assert.equal(dispatches, 1);

  const expired = await registry.run(adapter.name, input);
  const file = path.join(stateDirectory, 'mutation-authorizations', `${expired.preparationToken}.json`);
  fs.writeFileSync(file, JSON.stringify({ planDigest: expired.planDigest, expiresAt: '2000-01-01T00:00:00.000Z' }));
  await assert.rejects(registry.run(adapter.name, input, { ...options, preparationToken: expired.preparationToken }),
    (error) => error.code === 'authorization_expired');
  assert.equal(dispatches, 1);
});

test('concurrent governed applies consume one authorization even when the dispatched result is unknown', async (t) => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-authorization-'));
  t.after(() => fs.rmSync(stateDirectory, { recursive: true, force: true }));
  const adapter = governedMutation();
  let dispatches = 0;
  const registry = new AdapterRegistry({
    adapters: [adapter], stateDirectory,
    transport: async () => {
      dispatches += 1;
      throw Object.assign(new Error('connection lost'), { code: 'ECONNRESET' });
    },
  });
  const prepared = await registry.run(adapter.name, { id: 1 });
  const options = { apply: true, capabilities: capabilities(), preparationToken: prepared.preparationToken };
  const results = await Promise.allSettled([
    registry.run(adapter.name, { id: 1 }, options),
    registry.run(adapter.name, { id: 1 }, options),
  ]);
  assert.equal(dispatches, 1);
  assert.deepEqual(results.map(({ reason }) => reason.code).sort(), ['authorization_consumed', 'result_unknown']);
  const unknown = results.find(({ reason }) => reason.code === 'result_unknown').reason;
  assert.equal(unknown.mutationStatus, 'result_unknown');
  assert.equal(unknown.dispatchState, 'dispatched_unacknowledged');
  assert.equal(unknown.attempts.length, 1);
  await assert.rejects(registry.run(adapter.name, { id: 1 }, options),
    (error) => error.code === 'authorization_consumed');
});

test('early failures retain evidence and caller request IDs cannot escape the trace directory', async (t) => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-evidence-'));
  t.after(() => fs.rmSync(stateDirectory, { recursive: true, force: true }));
  const registry = new AdapterRegistry({ adapters: [makeAdapter()], stateDirectory });
  await assert.rejects(registry.run('fixture.read', { id: 0 }, {
    requestId: '../escape', trace: 'retain-on-failure',
  }), (error) => {
    assert.equal(error.code, 'input_schema_invalid');
    assert.equal(error.dispatchState, 'not_dispatched');
    assert.deepEqual(error.attempts, []);
    assert.match(error.requestId, /^req_[a-f0-9-]+$/);
    assert.equal(path.dirname(error.traceFile), path.join(stateDirectory, 'traces'));
    return true;
  });
});

test('upstream rejection is not a parse error or an empty successful result', async () => {
  const registry = new AdapterRegistry({
    adapters: [makeAdapter({
      parseResponse() {
        throw Object.assign(new Error('permission denied'), {
          code: 'upstream_business_error', upstreamCode: 403,
        });
      },
    })],
    transport: async () => ({ json: { code: 403 } }),
  });
  await assert.rejects(registry.run('fixture.read', { id: 1 }, { capabilities: capabilities() }),
    (error) => error.code === 'upstream_business_error'
      && error.upstreamCode === 403 && error.dispatchState === 'completed'
      && error.attempts.length === 1);
});

test('failed pre-dispatch capability checks do not consume reviewed authorization', async (t) => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-authorization-'));
  t.after(() => fs.rmSync(stateDirectory, { recursive: true, force: true }));
  const adapter = governedMutation();
  let dispatches = 0;
  const registry = new AdapterRegistry({
    adapters: [adapter], stateDirectory,
    transport: async () => {
      dispatches += 1;
      return { json: { id: 1, value: 'acknowledged' } };
    },
  });
  const prepared = await registry.run(adapter.name, { id: 1 }, {
    resolveCapabilities: () => { throw new Error('Dry-run must stay offline'); },
  });
  const options = { apply: true, preparationToken: prepared.preparationToken };
  await assert.rejects(registry.run(adapter.name, { id: 1 }, {
    ...options, resolveCapabilities: () => { throw new Error('daemon unavailable'); },
  }), (error) => error.code === 'capability_unavailable'
    && error.dispatchState === 'not_dispatched' && error.attempts.length === 0);
  await assert.rejects(registry.run(adapter.name, { id: 1 }, {
    ...options,
    resolveCapabilities: () => {
      throw new AdapterError('extension_disconnected', 'Extension did not reconnect');
    },
  }), (error) => error.code === 'extension_disconnected'
    && error.dispatchState === 'not_dispatched' && error.attempts.length === 0);
  await assert.rejects(registry.run(adapter.name, { id: 1 }, options),
    (error) => error.code === 'capability_missing');
  assert.equal(dispatches, 0);
  await registry.run(adapter.name, { id: 1 }, { ...options, capabilities: capabilities() });
  assert.equal(dispatches, 1);
});

test('diagnostic write failure does not erase the original dispatch evidence', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-trace-error-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateDirectory = path.join(directory, 'not-a-directory');
  fs.writeFileSync(stateDirectory, '');
  const registry = new AdapterRegistry({ adapters: [makeAdapter()], stateDirectory });
  await assert.rejects(registry.run('fixture.read', { id: 0 }, { trace: 'retain-on-failure' }),
    (error) => {
      assert.equal(error.code, 'input_schema_invalid');
      assert.equal(error.dispatchState, 'not_dispatched');
      assert.equal(error.toJSON().traceError.code, 'trace_write_failed');
      assert.equal(error.attempts.length, 0);
      return true;
    });
});

test('an unconfirmed endpoint acknowledgement retains unknown mutation status and consumes authorization', async (t) => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-acknowledgement-'));
  t.after(() => fs.rmSync(stateDirectory, { recursive: true, force: true }));
  const adapter = {
    ...governedMutation(),
    parseResponse() {
      throw Object.assign(new Error('Endpoint did not confirm acceptance'), { code: 'result_unknown' });
    },
  };
  const registry = new AdapterRegistry({
    adapters: [adapter], stateDirectory,
    transport: async () => ({ ok: true, status: 200, text: '' }),
  });
  const prepared = await registry.run(adapter.name, { id: 1 });
  const options = { apply: true, capabilities: capabilities(), preparationToken: prepared.preparationToken };
  await assert.rejects(registry.run(adapter.name, { id: 1 }, options),
    (error) => error.code === 'result_unknown' && error.mutationStatus === 'result_unknown'
      && error.dispatchState === 'completed' && error.retryable === false);
  await assert.rejects(registry.run(adapter.name, { id: 1 }, options),
    (error) => error.code === 'authorization_consumed');
});

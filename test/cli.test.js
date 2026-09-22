const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  executeAdapterCommand,
  parseArgs,
  readAdapterInput,
  runAdapterCommand,
  runDoctor,
  selectResult,
  summarizeResult,
  withRequestSummary,
  writeJsonAtomically,
} = require('../cli/browser-fetch-bridge');

function makeFixtureAdapter(overrides = {}) {
  const effect = overrides.effect || 'read';
  return {
    name: 'fixture.read',
    description: 'Fixture adapter',
    effect,
    agentStandard: true,
    risk: {
      readOnly: effect !== 'mutation',
      destructive: effect === 'mutation',
      idempotent: effect !== 'mutation',
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
        tabUrl: 'https://example.test/app',
        timeoutMs: 30000,
        request: {
          url: `https://example.test/api/items/${input.id}`,
          method: effect === 'mutation' ? 'POST' : 'GET',
          responseType: 'json',
          ...(effect === 'mutation' ? { body: JSON.stringify({ id: input.id }) } : {}),
        },
      };
    },
    parseResponse(response) {
      return response.json;
    },
    ...overrides,
  };
}

test('parseArgs parses status command defaults', () => {
  const options = parseArgs(['status']);

  assert.deepEqual(options, {
    command: 'status',
    host: '127.0.0.1',
    port: 37891,
    token: 'browser-fetch-bridge-dev',
    timeoutMs: 30000,
  });
});

test('parseArgs rejects the removed public raw fetch command', () => {
  assert.throws(
    () => parseArgs(['fetch', '--payload-file', '/tmp/request.json']),
    /status\|daemon\|doctor\|adapter/,
  );
});

test('parseArgs allows CLI timeout override from env', () => {
  const options = parseArgs(['status'], { BROWSER_BRIDGE_TIMEOUT_MS: '45000' });

  assert.equal(options.timeoutMs, 45000);
});

test('parseArgs parses daemon lifecycle commands', () => {
  const options = parseArgs(['daemon', 'restart', '--port', '4000']);

  assert.equal(options.command, 'daemon');
  assert.equal(options.daemonAction, 'restart');
  assert.equal(options.port, 4000);
});

test('parseArgs rejects unknown daemon lifecycle commands', () => {
  assert.throws(
    () => parseArgs(['daemon', 'reload']),
    /daemon <start\|status\|stop\|restart>/,
  );
});

test('parseArgs parses adapter run options', () => {
  const options = parseArgs([
    'adapter',
    'run',
    'fixture.mutate',
    '--input',
    '{"id":123}',
    '--apply',
    '--trace',
    'retain-on-failure',
  ]);

  assert.equal(options.adapterAction, 'run');
  assert.equal(options.adapterName, 'fixture.mutate');
  assert.equal(options.input, '{"id":123}');
  assert.equal(options.apply, true);
  assert.equal(options.trace, 'retain-on-failure');
});

test('parseArgs parses output controls and list filters', () => {
  const options = parseArgs([
    'adapter',
    'list',
    '--prefix',
    'fixture.',
    '--name',
    'fixture.metric-detail',
    '--compact',
  ]);

  assert.equal(options.prefix, 'fixture.');
  assert.equal(options.name, 'fixture.metric-detail');
  assert.equal(options.compact, true);

  const runOptions = parseArgs([
    'adapter',
    'run',
    'fixture.read',
    '--select',
    'data.items[*].id',
    '--output-file',
    '/tmp/fixture-output.json',
    '--summary-only',
    '--request-summary',
  ]);
  assert.deepEqual(runOptions.select, ['data.items[*].id']);
  assert.equal(runOptions.outputFile, '/tmp/fixture-output.json');
  assert.equal(runOptions.summaryOnly, true);
  assert.equal(runOptions.requestSummary, true);
});

test('parseArgs rejects output file collisions with input file', () => {
  assert.throws(
    () => parseArgs([
      'adapter',
      'run',
      'fixture.read',
      '--input-file',
      './fixture.json',
      '--output-file',
      'fixture.json',
    ]),
    /different paths/,
  );
});

test('readAdapterInput reads inline or file JSON and rejects invalid JSON', () => {
  assert.deepEqual(readAdapterInput({ input: '{"id":1}' }), { id: 1 });
  const file = path.join(os.tmpdir(), `browser-fetch-bridge-input-${Date.now()}.json`);
  fs.writeFileSync(file, '{"id":2}');
  assert.deepEqual(readAdapterInput({ inputFile: file }), { id: 2 });
  fs.unlinkSync(file);
  assert.throws(
    () => readAdapterInput({ input: '{' }),
    (error) => error.code === 'input_json_invalid',
  );
});

test('adapter list does not require daemon status', async () => {
  const registry = {
    list() {
      return [{ name: 'fixture.read' }];
    },
  };

  const result = await runAdapterCommand(
    parseArgs(['adapter', 'list']),
    { registry },
  );

  assert.deepEqual(result, { ok: true, adapters: [{ name: 'fixture.read' }] });
});

test('adapter list applies exact name and prefix filters', async () => {
  const registry = {
    list() {
      return [
        { name: 'fixture.metric-detail' },
        { name: 'fixture.metric-list' },
        { name: 'fixture.alert-list' },
      ];
    },
  };

  const result = await runAdapterCommand(
    parseArgs(['adapter', 'list', '--prefix', 'fixture.', '--name', 'fixture.metric-list']),
    { registry },
  );

  assert.deepEqual(result, { ok: true, adapters: [{ name: 'fixture.metric-list' }] });
});

test('selectResult projects dot paths and maps array wildcards', () => {
  const result = {
    ok: true,
    data: {
      items: [{ id: 1, name: 'one' }, { id: 2, name: 'two' }],
      total: 2,
    },
  };

  assert.deepEqual(selectResult(result, ['data.items[*].id']), {
    data: { items: [{ id: 1 }, { id: 2 }] },
  });
  assert.deepEqual(selectResult(result, ['data.total', 'data.items[*].name']), {
    data: {
      total: 2,
      items: [{ name: 'one' }, { name: 'two' }],
    },
  });
  assert.throws(() => selectResult(result, ['data.missing']), /did not match/);
});

test('summary-only output reports envelope and data shape without values', () => {
  const result = summarizeResult({
    ok: true,
    mode: 'read',
    data: { items: [{ id: 1 }], total: 1 },
  });

  assert.deepEqual(result, {
    ok: true,
    summaryOnly: true,
    envelope: {
      type: 'object',
      keyCount: 3,
      keys: ['ok', 'mode', 'data'],
    },
    data: {
      type: 'object',
      keyCount: 2,
      keys: ['items', 'total'],
    },
  });
  assert.equal(JSON.stringify(result).includes('items'), true);
  assert.equal(JSON.stringify(result).includes('id'), false);
});

test('selection is applied before summary-only when both controls are supplied', () => {
  const result = runAdapterCommand(
    {
      adapterAction: 'run',
      adapterName: 'fixture.read',
      select: ['data.items[*].id'],
      summaryOnly: true,
    },
    {
      registry: {
        describe() { return { effect: 'read' }; },
        async run() {
          return {
            ok: true,
            mode: 'read',
            data: { items: [{ id: 1 }, { id: 2 }] },
          };
        },
      },
      status: { status: { extension: { capabilities: [] } } },
    },
  );

  return result.then((summary) => {
    assert.equal(summary.summaryOnly, true);
    assert.deepEqual(summary.data, {
      type: 'object',
      keyCount: 1,
      keys: ['items'],
    });
  });
});

test('request summary flattens dry-run method, URL, and body without transport', () => {
  const result = withRequestSummary({
    ok: true,
    mode: 'dry-run',
    request: {
      tabUrl: 'https://example.test/',
      request: {
        method: 'PUT',
        url: 'https://example.test/api/item/1',
        body: '{"id":1}',
      },
    },
  });

  assert.deepEqual(result, {
    ok: true,
    mode: 'dry-run',
    method: 'PUT',
    url: 'https://example.test/api/item/1',
    body: '{"id":1}',
  });
});

test('output file is written atomically and reports absolute hash and byte count', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-fetch-bridge-output-'));
  const output = path.join(directory, 'result.json');
  const metadata = writeJsonAtomically(output, { ok: true, data: [1, 2] }, true);
  const bytes = fs.readFileSync(output);

  assert.equal(metadata.path, path.resolve(output));
  assert.equal(metadata.bytes, bytes.length);
  assert.equal(metadata.sha256.length, 64);
  assert.deepEqual(JSON.parse(bytes.toString()), { ok: true, data: [1, 2] });
  fs.rmSync(directory, { recursive: true, force: true });
});

test('mutation dry-run does not require daemon status or dispatch', async (t) => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-cli-authorization-'));
  t.after(() => fs.rmSync(stateDirectory, { recursive: true, force: true }));
  const result = await runAdapterCommand(
    parseArgs(['adapter', 'run', 'fixture.mutate', '--input', '{"id":1}']),
    {
      adapters: [makeFixtureAdapter({ name: 'fixture.mutate', effect: 'mutation' })],
      stateDirectory,
      get status() { throw new Error('Dry-run must not contact the daemon'); },
      transport: async () => { throw new Error('Dry-run must not dispatch'); },
    },
  );
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.request.request.method, 'POST');
});

test('malformed CLI JSON fails with pre-dispatch evidence before daemon access', async () => {
  await assert.rejects(runAdapterCommand(
    parseArgs(['adapter', 'run', 'fixture.mutate', '--input', '{', '--apply']),
    {
      get status() { throw new Error('Invalid input must not contact the daemon'); },
      transport: async () => { throw new Error('Invalid input must not dispatch'); },
    },
  ), (error) => error.code === 'input_json_invalid'
    && error.dispatchState === 'not_dispatched'
    && error.attempts.length === 0 && /^req_/.test(error.requestId));
});

test('doctor reports protocol capabilities without warnings', async () => {
  const result = await runDoctor(parseArgs(['doctor']), {
    status: {
      status: {
        pid: 123,
        port: 37891,
        connected: true,
        extension: {
          instanceId: 'ext_test',
          extensionVersion: '0.2.0',
          protocolVersion: 2,
          capabilities: [
            'fetch.text',
            'fetch.json',
            'fetch.base64',
            'fetch.started-ack',
          ],
        },
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.checks.protocol.actual, 2);
  assert.deepEqual(result.checks.capabilities.missing, []);
});

test('doctor reports a disconnected extension through failing checks', async () => {
  const result = await runDoctor(parseArgs(['doctor']), {
    status: {
      status: {
        pid: 123,
        port: 37891,
        connected: false,
        extension: null,
      },
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.checks.extension, { ok: false, connected: false });
  assert.equal(result.checks.protocol.ok, false);
  assert.equal(result.checks.capabilities.ok, false);
  assert.equal(result.extension, null);
});

test('live adapters distinguish disconnected, pre-hello, and incompatible injected status', async () => {
  const options = parseArgs([
    'adapter', 'run', 'fixture.read', '--input', '{"id":11}',
  ]);
  const cases = [
    [{ status: { connected: false, extension: null } }, 'extension_disconnected'],
    [{ status: { connected: true, extension: null } }, 'extension_not_ready'],
    [{
      status: {
        connected: true,
        extension: { protocolVersion: 2, capabilities: [] },
      },
    }, 'capability_missing'],
  ];

  for (const [status, expectedCode] of cases) {
    let dispatched = false;
    await assert.rejects(
      runAdapterCommand(options, {
        adapters: [makeFixtureAdapter()],
        status,
        transport: async () => {
          dispatched = true;
          throw new Error('must not dispatch');
        },
      }),
      (error) => error.code === expectedCode
        && error.dispatchState === 'not_dispatched'
        && error.attempts.length === 0,
    );
    assert.equal(dispatched, false);
  }
});

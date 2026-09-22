const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Ajv = require('ajv');
const { planDigest, prepareMutation, consumeMutation } = require('./mutation-authorization');

const ADAPTER_NAME = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const EFFECTS = new Set(['read', 'mutation']);
const TRACE_MODES = new Set(['off', 'retain-on-failure', 'retain-all']);
const REQUEST_PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tabUrl', 'request', 'timeoutMs'],
  properties: {
    tabUrl: { type: 'string', minLength: 1, pattern: '^https?://' },
    timeoutMs: { type: 'integer', minimum: 1, maximum: 120000 },
    request: {
      type: 'object',
      additionalProperties: false,
      required: ['url', 'method', 'responseType'],
      properties: {
        url: { type: 'string', minLength: 1 },
        method: { type: 'string', minLength: 1 },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
        body: { type: 'string' },
        responseType: { enum: ['text', 'json', 'base64'] },
      },
    },
  },
};

class AdapterError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    Object.assign(this, details);
  }

  toJSON() {
    const output = { code: this.code, message: this.message };
    for (const key of ['adapter', 'requestId', 'dispatchState', 'retryable', 'status', 'statusText', 'errors', 'attempts', 'traceFile', 'traceError', 'required', 'available', 'mutationStatus', 'upstreamCode', 'upstreamTraceId']) {
      if (this[key] !== undefined) output[key] = this[key];
    }
    return output;
  }
}

class AdapterRegistry {
  constructor({ adapters, transport, stateDirectory, ajv } = {}) {
    this.ajv = ajv || new Ajv({ allErrors: true, strict: false });
    this.validateRequestPlan = this.ajv.compile(REQUEST_PLAN_SCHEMA);
    this.transport = transport;
    this.stateDirectory = stateDirectory || path.join(os.homedir(), '.browser-fetch-bridge');
    this.adapters = new Map();
    for (const adapter of adapters || []) this.register(adapter);
  }

  register(adapter) {
    validateAdapterContract(adapter);
    if (this.adapters.has(adapter.name)) {
      throw new AdapterError('adapter_duplicate', `Duplicate adapter name: ${adapter.name}`, { adapter: adapter.name });
    }
    const inputValidator = this.ajv.compile(adapter.inputSchema);
    const outputValidator = this.ajv.compile(adapter.outputSchema);
    this.adapters.set(adapter.name, { adapter, inputValidator, outputValidator });
  }

  list() {
    return [...this.adapters.values()]
      .map(({ adapter }) => ({
        name: adapter.name,
        description: adapter.description,
        effect: adapter.effect,
        retry: normalizeRetry(adapter.retry),
        requires: [...(adapter.requires || [])],
        agentStandard: true,
        risk: adapter.risk,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  describe(name) {
    const { adapter } = this.get(name);
    return {
      name: adapter.name,
      description: adapter.description,
      effect: adapter.effect,
      retry: normalizeRetry(adapter.retry),
      requires: [...(adapter.requires || [])],
      inputSchema: adapter.inputSchema,
      agentStandard: true,
      risk: adapter.risk,
      outputSchema: adapter.outputSchema,
    };
  }

  schema(name) {
    const { adapter } = this.get(name);
    return { input: adapter.inputSchema, output: adapter.outputSchema };
  }

  get(name) {
    const entry = this.adapters.get(name);
    if (!entry) throw new AdapterError('adapter_not_found', `Unknown adapter: ${name}`, { adapter: name });
    return entry;
  }

  async run(name, input, options = {}) {
    const requestId = `req_${crypto.randomUUID()}`;
    const attempts = [];
    let dispatchState = 'not_dispatched';
    let adapter;
    let requestPlan;
    let rawResponse;
    const traceMode = options.trace || 'off';
    try {
      const entry = this.get(name);
      adapter = entry.adapter;
      if (!TRACE_MODES.has(traceMode)) {
        throw new AdapterError('trace_mode_invalid', `Unsupported trace mode: ${traceMode}`);
      }
      if (!entry.inputValidator(input)) {
        throw new AdapterError('input_schema_invalid', `Input does not match schema for ${name}`, {
          errors: entry.inputValidator.errors,
        });
      }
      // Snapshot input across asynchronous construction and dispatch.
      input = JSON.parse(JSON.stringify(input));
      const retry = normalizeRetry(adapter.retry);
      try {
        requestPlan = await adapter.buildRequest(input);
      } catch (error) {
        throw new AdapterError('request_build_failed', error.message || String(error));
      }
      if (!this.validateRequestPlan(requestPlan)) {
        throw new AdapterError('request_plan_invalid', `Adapter ${name} produced an invalid request plan`, {
          errors: this.validateRequestPlan.errors,
        });
      }
      try {
        const tab = new URL(requestPlan.tabUrl);
        if (tab.protocol !== 'http:' && tab.protocol !== 'https:') throw new Error('tabUrl must use HTTP(S)');
        const target = new URL(requestPlan.request.url);
        if (target.origin !== tab.origin || target.username || target.password || tab.username || tab.password) {
          throw new Error('Request target must use the adapter tab origin without embedded credentials');
        }
        requestPlan = JSON.parse(JSON.stringify(requestPlan));
      } catch (error) {
        throw new AdapterError('request_plan_invalid', error.message);
      }
      const governedMutation = adapter.effect === 'mutation';
      const digest = governedMutation ? planDigest(name, input, requestPlan) : undefined;
      if (adapter.effect === 'mutation' && options.apply !== true) {
        return {
          ok: true,
          mode: 'dry-run',
          adapter: name,
          effect: adapter.effect,
          retry,
          requestId,
          dispatchState,
          request: requestPlan,
          ...prepareMutation(this.stateDirectory, digest),
        };
      }
      let capabilityValues = options.capabilities || [];
      if (options.resolveCapabilities) {
        try {
          capabilityValues = await options.resolveCapabilities();
        } catch (error) {
          if (error instanceof AdapterError) throw error;
          throw new AdapterError('capability_unavailable', error.message || String(error));
        }
      }
      const available = new Set(capabilityValues);
      const missing = (adapter.requires || []).filter((capability) => !available.has(capability));
      if (missing.length) {
        throw new AdapterError('capability_missing', `Adapter ${name} requires unavailable capabilities`, {
          required: missing, available: [...available],
        });
      }
      if (typeof this.transport !== 'function') {
        throw new AdapterError('transport_unavailable', 'Adapter Registry transport is not configured');
      }
      if (governedMutation) consumeMutation(this.stateDirectory, options.preparationToken, digest);
      const attemptId = `attempt_${crypto.randomUUID()}`;
      try {
        dispatchState = 'dispatched_unacknowledged';
        const envelope = await this.transport(requestPlan, {
          adapter: name, requestId, attemptId, effect: adapter.effect,
        });
        rawResponse = envelope && envelope.result !== undefined ? envelope.result : envelope;
        dispatchState = 'completed';
        attempts.push({ attemptId, result: 'completed', dispatchState });
      } catch (error) {
        dispatchState = inferDispatchState(error);
        const code = error.code || 'transport_failure';
        attempts.push({ attemptId, result: code, dispatchState });
        throw new AdapterError(
          governedMutation && dispatchState !== 'not_dispatched' ? 'result_unknown' : code,
          error.message || String(error),
          { retryable: false },
        );
      }
      if (rawResponse && (
        rawResponse.ok === false
        || (Number.isFinite(Number(rawResponse.status))
          && (Number(rawResponse.status) < 200 || Number(rawResponse.status) >= 300))
      )) {
        throw new AdapterError('http_error', `Endpoint returned HTTP ${rawResponse.status || 'unknown'}`, {
          status: rawResponse.status, statusText: rawResponse.statusText,
        });
      }
      let data;
      try {
        data = await adapter.parseResponse(rawResponse, input);
      } catch (error) {
        throw new AdapterError(
          ['upstream_business_error', 'result_unknown'].includes(error.code) ? error.code : 'response_parse_failed',
          error.message || String(error),
          { ...(error.upstreamCode !== undefined ? { upstreamCode: error.upstreamCode } : {}) },
        );
      }
      if (!entry.outputValidator(data)) {
        throw new AdapterError('output_schema_invalid', `Output does not match schema for ${name}`, {
          errors: entry.outputValidator.errors,
        });
      }
      const traceFile = this.writeTrace(traceMode, {
        adapter: name, requestId, input, request: requestPlan, response: rawResponse, data, attempts,
      }, false);
      return {
        ok: true,
        mode: adapter.effect === 'mutation' ? 'apply' : 'read',
        adapter: name,
        effect: adapter.effect,
        source: name.split('.')[0],
        observedAt: new Date().toISOString(),
        requestId,
        dispatchState,
        data,
        meta: {
          attemptCount: attempts.length,
          attempts,
          ...(typeof rawResponse?.headers?.['m-traceid'] === 'string'
            ? { upstreamTraceId: rawResponse.headers['m-traceid'] } : {}),
          ...(traceFile ? { traceFile } : {}),
        },
      };
    } catch (error) {
      const failure = error instanceof AdapterError
        ? error
        : new AdapterError(
          /^authorization_/.test(error.code || '') ? error.code : 'runtime_error',
          error.message || String(error),
        );
      Object.assign(failure, { adapter: name, requestId, dispatchState, attempts });
      if (typeof rawResponse?.headers?.['m-traceid'] === 'string') {
        failure.upstreamTraceId = rawResponse.headers['m-traceid'];
      }
      if (adapter?.effect === 'mutation'
        && dispatchState !== 'not_dispatched' && failure.code !== 'upstream_business_error') {
        failure.mutationStatus = 'result_unknown';
        failure.retryable = false;
      }
      if (TRACE_MODES.has(traceMode)) {
        try {
          failure.traceFile = this.writeTrace(traceMode, {
            adapter: name, requestId, input, request: requestPlan,
            response: rawResponse, attempts, error: serializeError(failure),
          }, true);
        } catch (traceError) {
          failure.traceError = { code: 'trace_write_failed', message: traceError.message };
        }
      }
      throw failure;
    }
  }

  writeTrace(mode = 'off', contents, failed) {
    if (!TRACE_MODES.has(mode)) {
      throw new AdapterError('trace_mode_invalid', `Unsupported trace mode: ${mode}`);
    }
    if (mode === 'off' || (mode === 'retain-on-failure' && !failed)) return undefined;
    const traceDirectory = path.join(this.stateDirectory, 'traces');
    fs.mkdirSync(traceDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(traceDirectory, 0o700);
    const traceFile = path.join(traceDirectory, `${contents.requestId}.json`);
    fs.writeFileSync(traceFile, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(traceFile, 0o600);
    return traceFile;
  }
}

function validateAdapterContract(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new AdapterError('adapter_invalid', 'Adapter must be an object');
  if (!ADAPTER_NAME.test(adapter.name || '')) throw new AdapterError('adapter_invalid', `Invalid adapter name: ${adapter.name}`);
  if (!adapter.description || typeof adapter.description !== 'string') throw new AdapterError('adapter_invalid', `Adapter ${adapter.name} requires a description`);
  if (!EFFECTS.has(adapter.effect)) throw new AdapterError('adapter_invalid', `Adapter ${adapter.name} has invalid effect`);
  if (adapter.agentStandard !== true) {
    throw new AdapterError('adapter_invalid', `Adapter ${adapter.name} must use the governed contract`);
  }
  normalizeRetry(adapter.retry);
  if (!adapter.inputSchema || !adapter.outputSchema) throw new AdapterError('adapter_invalid', `Adapter ${adapter.name} requires inputSchema and outputSchema`);
  if (typeof adapter.buildRequest !== 'function' || typeof adapter.parseResponse !== 'function') {
    throw new AdapterError('adapter_invalid', `Adapter ${adapter.name} requires buildRequest and parseResponse`);
  }
  if (adapter.requires && (!Array.isArray(adapter.requires) || adapter.requires.some((item) => typeof item !== 'string'))) {
    throw new AdapterError('adapter_invalid', `Adapter ${adapter.name} requires must be a string array`);
  }
  if (adapter.inputSchema.type !== 'object' || adapter.inputSchema.additionalProperties !== false
    || adapter.outputSchema.type !== 'object' || adapter.outputSchema.additionalProperties !== false) {
    throw new AdapterError('adapter_invalid', `Adapter ${adapter.name} requires closed root schemas`);
  }
  if (!adapter.risk || ['readOnly', 'destructive', 'idempotent', 'openWorld']
    .some((key) => typeof adapter.risk[key] !== 'boolean')
    || adapter.risk.readOnly !== (adapter.effect === 'read')) {
    throw new AdapterError('adapter_invalid', `Adapter ${adapter.name} requires consistent risk metadata`);
  }
}

function normalizeRetry(retry) {
  const value = typeof retry === 'string' ? { mode: retry } : retry;
  if (value?.mode !== 'never' || (value.maxAttempts !== undefined && value.maxAttempts !== 1)) {
    throw new AdapterError('adapter_invalid', 'Adapters require retry: never and at most one dispatch per invocation');
  }
  return { mode: 'never', maxAttempts: 1 };
}


function inferDispatchState(error) {
  if (['not_dispatched', 'dispatched_unacknowledged', 'started', 'completed'].includes(error.dispatchState)) {
    return error.dispatchState;
  }
  if (error.code === 'ECONNREFUSED' || error.code === 'extension_not_ready') return 'not_dispatched';
  return 'dispatched_unacknowledged';
}

function serializeError(error) {
  return {
    name: error.name,
    code: error.code,
    message: error.message || String(error),
    stack: error.stack,
  };
}

module.exports = {
  AdapterError,
  AdapterRegistry,
  REQUEST_PLAN_SCHEMA,
  normalizeRetry,
};

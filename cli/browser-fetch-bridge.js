#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  daemonStatus,
  restartDaemon,
  startDaemon,
  stopDaemon,
} = require('./daemon');
const { AdapterError } = require('../lib/adapter-registry');
const { createRegistry, getBridgeStatus } = require('../lib/adapter-runtime');

const DEFAULT_TIMEOUT_MS = 30000;
const DAEMON_ACTIONS = new Set(['start', 'status', 'stop', 'restart']);
const ADAPTER_ACTIONS = new Set(['list', 'describe', 'schema', 'run']);

function parseArgs(argv, env = process.env) {
  const [command, ...commandRest] = argv;
  if (!['status', 'daemon', 'adapter', 'doctor'].includes(command)) {
    throw new Error('Usage: browser-fetch-bridge <status|daemon|doctor|adapter> [options]');
  }

  const rest = [...commandRest];
  let daemonAction;
  let adapterAction;
  let adapterName;
  if (command === 'daemon') {
    daemonAction = rest.shift();
    if (!DAEMON_ACTIONS.has(daemonAction)) {
      throw new Error('Usage: browser-fetch-bridge daemon <start|status|stop|restart> [options]');
    }
  } else if (command === 'adapter') {
    adapterAction = rest.shift();
    if (!ADAPTER_ACTIONS.has(adapterAction)) {
      throw new Error('Usage: browser-fetch-bridge adapter <list|describe|schema|run> [name] [options]');
    }
    if (adapterAction !== 'list') {
      adapterName = rest.shift();
      if (!adapterName || adapterName.startsWith('--')) {
        throw new Error(`adapter ${adapterAction} requires <name>`);
      }
    }
  }

  const options = {
    command,
    host: env.BROWSER_BRIDGE_HOST || '127.0.0.1',
    port: Number(env.BROWSER_BRIDGE_PORT || 37891),
    token: env.BROWSER_BRIDGE_TOKEN || 'browser-fetch-bridge-dev',
    timeoutMs: Number(env.BROWSER_BRIDGE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  };
  if (daemonAction) options.daemonAction = daemonAction;
  if (adapterAction) options.adapterAction = adapterAction;
  if (adapterName) options.adapterName = adapterName;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const value = rest[i + 1];
    if (arg === '--host') {
      options.host = value;
      i += 1;
    } else if (arg === '--port') {
      options.port = Number(value);
      i += 1;
    } else if (arg === '--token') {
      options.token = value;
      i += 1;
    } else if (arg === '--input') {
      options.input = value;
      i += 1;
    } else if (arg === '--input-file') {
      options.inputFile = value;
      i += 1;
    } else if (arg === '--prefix') {
      options.prefix = value;
      i += 1;
    } else if (arg === '--name') {
      options.name = value;
      i += 1;
    } else if (arg === '--compact') {
      options.compact = true;
    } else if (arg === '--select') {
      if (!options.select) options.select = [];
      options.select.push(value);
      i += 1;
    } else if (arg === '--output-file') {
      options.outputFile = value;
      i += 1;
    } else if (arg === '--summary-only') {
      options.summaryOnly = true;
    } else if (arg === '--request-summary') {
      options.requestSummary = true;
    } else if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--preparation-token') {
      if (!value || value.startsWith('--')) throw new Error('--preparation-token requires a value');
      options.preparationToken = value;
      i += 1;
    } else if (arg === '--trace') {
      options.trace = value;
      i += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (options.input !== undefined && options.inputFile) throw new Error('Use only one of --input or --input-file');
  if (options.inputFile && options.outputFile
    && path.resolve(options.inputFile) === path.resolve(options.outputFile)) {
    throw new Error('Use different paths for --input-file and --output-file');
  }
  if (options.adapterAction !== 'list' && (options.prefix !== undefined || options.name !== undefined)) {
    throw new Error('--prefix and --name are supported only by adapter list');
  }
  if (options.adapterAction !== 'run'
    && (options.select || options.outputFile || options.summaryOnly || options.requestSummary)) {
    throw new Error('--select, --output-file, --summary-only, and --request-summary are supported only by adapter run');
  }
  if (options.preparationToken !== undefined && (options.adapterAction !== 'run' || options.apply !== true)) {
    throw new Error('--preparation-token requires adapter run --apply');
  }
  return options;
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readAdapterInput(options) {
  if (options.inputFile) return readJsonFile(options.inputFile);
  if (options.input === undefined) return {};
  try {
    return JSON.parse(options.input);
  } catch {
    throw new AdapterError('input_json_invalid', 'Adapter input must be valid JSON');
  }
}

function filterAdapters(adapters, options) {
  return adapters.filter((adapter) => (
    (options.prefix === undefined || adapter.name.startsWith(options.prefix))
    && (options.name === undefined || adapter.name === options.name)
  ));
}

function parseSelector(selector) {
  if (typeof selector !== 'string' || selector.length === 0) {
    throw new AdapterError('select_invalid', 'Selection path must be a non-empty string');
  }
  const tokens = [];
  let cursor = 0;
  while (cursor < selector.length) {
    if (selector[cursor] === '.') {
      throw new AdapterError('select_invalid', `Invalid selection path: ${selector}`);
    }
    if (selector.startsWith('[*]', cursor)) {
      tokens.push('*');
      cursor += 3;
    } else {
      const match = /^[^.\[\]]+/.exec(selector.slice(cursor));
      if (!match) throw new AdapterError('select_invalid', `Invalid selection path: ${selector}`);
      tokens.push(match[0]);
      cursor += match[0].length;
    }
    if (cursor === selector.length) break;
    if (selector[cursor] === '.') {
      cursor += 1;
      if (cursor === selector.length) {
        throw new AdapterError('select_invalid', `Invalid selection path: ${selector}`);
      }
    } else if (!selector.startsWith('[*]', cursor)) {
      throw new AdapterError('select_invalid', `Invalid selection path: ${selector}`);
    }
  }
  return tokens;
}

function projectSelection(value, tokens, index) {
  if (index === tokens.length) return { matched: true, value };
  const token = tokens[index];
  if (token === '*') {
    if (!Array.isArray(value)) return { matched: false };
    const projected = [];
    for (const item of value) {
      const result = projectSelection(item, tokens, index + 1);
      if (!result.matched) return { matched: false };
      projected.push(result.value);
    }
    return { matched: true, value: projected };
  }
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, token)) {
    return { matched: false };
  }
  const result = projectSelection(value[token], tokens, index + 1);
  if (!result.matched) return result;
  return { matched: true, value: { [token]: result.value } };
}

function mergeProjection(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (Array.isArray(left) && Array.isArray(right) && left.length === right.length) {
      return left.map((value, index) => mergeProjection(value, right[index]));
    }
    return right;
  }
  if (!left || typeof left !== 'object'
    || !right || typeof right !== 'object') return right;
  const output = { ...left };
  for (const [key, value] of Object.entries(right)) {
    output[key] = Object.hasOwn(output, key)
      ? mergeProjection(output[key], value)
      : value;
  }
  return output;
}

function selectResult(result, selectors) {
  if (!selectors || selectors.length === 0) return result;
  let projected = {};
  for (const selector of selectors) {
    const selection = projectSelection(result, parseSelector(selector), 0);
    if (!selection.matched) {
      throw new AdapterError('select_not_found', `Selection path did not match the result: ${selector}`);
    }
    projected = mergeProjection(projected, selection.value);
  }
  return projected;
}

function describeValue(value) {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      ...(value.length ? { item: describeValue(value[0]) } : {}),
    };
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    return {
      type: 'object',
      keyCount: keys.length,
      keys: keys.slice(0, 100),
      ...(keys.length > 100 ? { truncated: true } : {}),
    };
  }
  if (value === undefined) return { type: 'undefined' };
  if (typeof value === 'string') return { type: 'string', length: value.length };
  return { type: typeof value };
}

function summarizeResult(result) {
  return {
    ok: result?.ok === true,
    summaryOnly: true,
    envelope: describeValue(result),
    data: describeValue(result?.data),
  };
}

function withRequestSummary(result) {
  if (!result || result.mode !== 'dry-run' || !result.request) return result;
  const request = result.request.request || result.request;
  const summarized = { ...result };
  delete summarized.request;
  summarized.method = request.method || 'GET';
  summarized.url = request.url;
  if (request.body !== undefined) summarized.body = request.body;
  return summarized;
}

function applyResultOptions(result, options) {
  let output = options.requestSummary ? withRequestSummary(result) : result;
  if (options.select) output = selectResult(output, options.select);
  if (options.summaryOnly) output = summarizeResult(output);
  return output;
}

function requireReadyExtension(response) {
  if (response?.status?.connected !== true) {
    throw new AdapterError(
      'extension_disconnected',
      'Chrome extension is not connected to the bridge',
      { dispatchState: 'not_dispatched' },
    );
  }
  if (!response.status.extension) {
    throw new AdapterError(
      'extension_not_ready',
      'Chrome extension has not completed hello',
      { dispatchState: 'not_dispatched' },
    );
  }
  return response.status.extension;
}

async function executeAdapterCommand(options, dependencies = {}) {
  const registry = dependencies.registry || createRegistry(options, dependencies);
  if (options.adapterAction === 'list') {
    return { ok: true, adapters: filterAdapters(registry.list(), options) };
  }
  if (options.adapterAction === 'describe') {
    return { ok: true, adapter: registry.describe(options.adapterName) };
  }
  if (options.adapterAction === 'schema') {
    return { ok: true, adapter: options.adapterName, schema: registry.schema(options.adapterName) };
  }

  let input;
  try {
    input = readAdapterInput(options);
  } catch (error) {
    const failure = error instanceof AdapterError ? error : new AdapterError(
      error instanceof SyntaxError ? 'input_json_invalid' : 'input_file_unavailable',
      error.message,
    );
    Object.assign(failure, {
      adapter: options.adapterName,
      requestId: `req_${crypto.randomUUID()}`,
      dispatchState: 'not_dispatched',
      attempts: [],
    });
    throw failure;
  }
  return registry.run(options.adapterName, input, {
    apply: options.apply === true,
    ...(options.preparationToken !== undefined ? { preparationToken: options.preparationToken } : {}),
    trace: options.trace || 'off',
    resolveCapabilities: async () => {
      const status = dependencies.status || await getBridgeStatus(options, { waitForExtension: true });
      return requireReadyExtension(status).capabilities || [];
    },
  });
}

async function runAdapterCommand(options, dependencies = {}) {
  const result = await executeAdapterCommand(options, dependencies);
  return applyResultOptions(result, options);
}

function serializeOutput(value, compact) {
  return `${JSON.stringify(value, null, compact ? 0 : 2)}\n`;
}

function writeJsonAtomically(file, value, compact) {
  const absolutePath = path.resolve(file);
  const payload = Buffer.from(serializeOutput(value, compact), 'utf8');
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporaryPath, payload, { mode: 0o600 });
    fs.renameSync(temporaryPath, absolutePath);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch { /* best effort cleanup */ }
    throw error;
  }
  return {
    path: absolutePath,
    sha256: crypto.createHash('sha256').update(payload).digest('hex'),
    bytes: payload.length,
  };
}

function writeCliJson(value, compact) {
  process.stdout.write(serializeOutput(value, compact));
}

async function runDoctor(options, dependencies = {}) {
  const response = dependencies.status || await getBridgeStatus(options, { waitForExtension: true });
  const extension = response.status?.extension;
  const extensionReady = response.status?.connected === true && Boolean(extension);
  const expectedCapabilities = [
    'fetch.text',
    'fetch.json',
    'fetch.base64',
    'fetch.started-ack',
  ];
  const availableCapabilities = extension?.capabilities || [];
  const missingCapabilities = expectedCapabilities.filter(
    (capability) => !availableCapabilities.includes(capability),
  );
  const checks = {
    daemon: { ok: true, pid: response.status?.pid, port: response.status?.port },
    extension: {
      ok: extensionReady,
      connected: response.status?.connected === true,
    },
    protocol: {
      ok: extension?.protocolVersion === 2,
      expected: 2,
      actual: extension?.protocolVersion,
    },
    capabilities: {
      ok: Array.isArray(extension?.capabilities) && missingCapabilities.length === 0,
      expected: expectedCapabilities,
      available: availableCapabilities,
      missing: missingCapabilities,
    },
  };
  return {
    ok: Object.values(checks).every((check) => check.ok),
    checks,
    extension: extension || null,
  };
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv);
  if (options.command === 'daemon') {
    let result;
    if (options.daemonAction === 'start') result = await startDaemon(options);
    else if (options.daemonAction === 'status') result = await daemonStatus(options);
    else if (options.daemonAction === 'stop') result = await stopDaemon(options);
    else result = await restartDaemon(options);
    writeCliJson({ ok: true, daemon: result }, options.compact === true);
    return;
  }
  if (options.command === 'adapter') {
    if (options.outputFile) {
      const result = await executeAdapterCommand(options, dependencies);
      const outputFile = writeJsonAtomically(options.outputFile, result, options.compact === true);
      writeCliJson({ ok: true, outputFile }, options.compact === true);
    } else {
      const result = await runAdapterCommand(options, dependencies);
      writeCliJson(result, options.compact === true);
    }
    return;
  }
  if (options.command === 'doctor') {
    const result = await runDoctor(options, dependencies);
    writeCliJson(result, options.compact === true);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const result = await getBridgeStatus(options);
  writeCliJson(result, options.compact === true);
}

if (require.main === module) {
  main().catch((error) => {
    if (error instanceof AdapterError) {
      process.stderr.write(`${JSON.stringify({ ok: false, error: error.toJSON() }, null, 2)}\n`);
    } else {
      process.stderr.write(`${error.message || String(error)}\n`);
    }
    process.exit(1);
  });
}

module.exports = {
  main,
  parseArgs,
  readAdapterInput,
  selectResult,
  summarizeResult,
  withRequestSummary,
  writeJsonAtomically,
  executeAdapterCommand,
  runAdapterCommand,
  runDoctor,
};

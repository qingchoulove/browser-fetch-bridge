const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { startDaemon } = require('../cli/daemon');
const { AdapterRegistry } = require('./adapter-registry');

const DEFAULT_TIMEOUT_MS = 30000;
const STATUS_POLL_INTERVAL_MS = 50;
const DEFAULT_ADAPTERS_DIRECTORY = path.join(__dirname, '..', 'adapters');

/**
 * Endpoint adapters are an optional local tree. The tree is absent from a
 * generic checkout, so an unregistered directory yields an empty registry
 * instead of failing bridge startup.
 */
function loadAdapters(directory = process.env.BROWSER_BRIDGE_ADAPTERS_DIR || DEFAULT_ADAPTERS_DIRECTORY) {
  const entry = path.join(directory, 'index.js');
  if (!fs.existsSync(entry)) return [];
  return require(entry);
}

function requestOptions(options, operation) {
  const isFetch = operation === 'fetch';
  return {
    hostname: options.host,
    port: options.port,
    path: isFetch ? '/fetch' : '/status',
    method: isFetch ? 'POST' : 'GET',
    headers: {
      'x-browser-bridge-token': options.token,
      ...(isFetch ? { 'content-type': 'application/json' } : {}),
    },
    timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
  };
}

function requestDaemonOnce(options, operation, payload, readiness) {
  const httpOptions = requestOptions(options, operation);
  const body = payload == null ? '' : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    let deadlineTimer;
    const req = http.request(httpOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        clearTimeout(deadlineTimer);
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try {
          parsed = text ? JSON.parse(text) : {};
        } catch {
          reject(new Error(`Invalid JSON response: ${text}`));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const errorBody = parsed.error;
          const error = new Error(
            typeof errorBody === 'string'
              ? errorBody
              : errorBody?.message || `HTTP ${res.statusCode}`,
          );
          if (errorBody && typeof errorBody === 'object') {
            error.code = errorBody.code;
            error.dispatchState = errorBody.dispatchState;
          }
          reject(error);
          return;
        }
        resolve(parsed);
      });
    });
    req.on('error', (error) => {
      clearTimeout(deadlineTimer);
      reject(error);
    });
    req.setTimeout(httpOptions.timeout, () => {
      const error = new Error(`Request timed out after ${httpOptions.timeout}ms`);
      error.code = 'daemon_timeout';
      error.dispatchState = operation === 'fetch' ? 'unknown' : 'not_dispatched';
      req.destroy(error);
    });
    if (readiness) {
      deadlineTimer = setTimeout(() => {
        const error = deadlineError(readiness.timeoutMs);
        req.destroy(error);
      }, Math.max(1, readiness.deadline - Date.now()));
    }
    if (body) req.write(body);
    req.end();
  });
}

function readinessTimeout(options) {
  const configured = Number(options.timeoutMs);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_MS;
}

function deadlineError(timeoutMs) {
  const error = new Error(`Bridge readiness timed out after ${timeoutMs}ms`);
  error.code = 'daemon_timeout';
  error.dispatchState = 'not_dispatched';
  return error;
}

function remainingOptions(options, deadline, timeoutMs) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw deadlineError(timeoutMs);
  return { ...options, timeoutMs: Math.max(1, remaining) };
}

function waitBeforeDeadline(promise, deadline, timeoutMs) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(deadlineError(timeoutMs));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(deadlineError(timeoutMs)), remaining);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function requestDaemon(options, operation, payload, readiness) {
  const attemptOptions = readiness
    ? remainingOptions(options, readiness.deadline, readiness.timeoutMs)
    : options;
  try {
    return await requestDaemonOnce(attemptOptions, operation, payload, readiness);
  } catch (error) {
    if (error?.code !== 'ECONNREFUSED'
      || options.autoStart === false
      || process.env.BROWSER_BRIDGE_AUTOSTART === '0') {
      throw error;
    }
    const startup = startDaemon(options);
    if (readiness) {
      await waitBeforeDeadline(startup, readiness.deadline, readiness.timeoutMs);
      return requestDaemonOnce(
        remainingOptions(options, readiness.deadline, readiness.timeoutMs),
        operation,
        payload,
        readiness,
      );
    }
    await startup;
    return requestDaemonOnce(options, operation, payload);
  }
}

function createRegistry(options, dependencies = {}) {
  const transport = dependencies.transport || (async (requestPlan, invocation) => {
    const timeoutMs = requestPlan.timeoutMs;
    return requestDaemonOnce(
      { ...options, timeoutMs },
      'fetch',
      { ...requestPlan, timeoutMs, requestId: invocation.requestId, attemptId: invocation.attemptId },
    );
  });
  return new AdapterRegistry({
    adapters: dependencies.adapters || loadAdapters(),
    transport,
    stateDirectory: dependencies.stateDirectory || process.env.BROWSER_BRIDGE_STATE_DIR,
  });
}

async function getBridgeStatus(options, { waitForExtension = false } = {}) {
  if (!waitForExtension) return requestDaemon(options, 'status');

  const timeoutMs = readinessTimeout(options);
  const readiness = { deadline: Date.now() + timeoutMs, timeoutMs };
  let lastResponse;
  while (Date.now() < readiness.deadline) {
    try {
      lastResponse = await requestDaemon(options, 'status', undefined, readiness);
    } catch (error) {
      if (lastResponse && error?.code === 'daemon_timeout') {
        return lastResponse;
      }
      throw error;
    }
    if (lastResponse.status?.connected === true && lastResponse.status.extension) {
      return lastResponse;
    }
    const remaining = readiness.deadline - Date.now();
    if (remaining <= 0) return lastResponse;
    await new Promise((resolve) => setTimeout(
      resolve,
      Math.min(STATUS_POLL_INTERVAL_MS, remaining),
    ));
  }
  if (!lastResponse) throw deadlineError(timeoutMs);
  return lastResponse;
}

module.exports = {
  createRegistry,
  getBridgeStatus,
};

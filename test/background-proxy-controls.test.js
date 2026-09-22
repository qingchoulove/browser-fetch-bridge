const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();

  function findNext(limit = Infinity) {
    let next = null;
    for (const entry of pending.values()) {
      if (entry.at > limit) continue;
      if (!next || entry.at < next.at || (entry.at === next.at && entry.id < next.id)) next = entry;
    }
    return next;
  }

  function setTimeoutImpl(callback, delay) {
    const entry = {
      at: now + delay,
      callback,
      id: nextId,
    };
    nextId += 1;
    pending.set(entry.id, entry);
    return {
      id: entry.id,
      unref() {},
    };
  }

  function clearTimeoutImpl(timer) {
    if (timer) pending.delete(timer.id);
  }

  function advanceBy(duration) {
    const target = now + duration;
    let next = findNext(target);
    while (next) {
      pending.delete(next.id);
      now = next.at;
      next.callback();
      next = findNext(target);
    }
    now = target;
  }

  function runNext() {
    const next = findNext();
    if (!next) return false;
    pending.delete(next.id);
    now = next.at;
    next.callback();
    return true;
  }

  return {
    advanceBy,
    clearAll() {
      pending.clear();
    },
    clearTimeout: clearTimeoutImpl,
    peekNextCallback() {
      return findNext()?.callback;
    },
    runNext,
    setTimeout: setTimeoutImpl,
  };
}

function loadBackground({
  queryTabs = [{ id: 42, url: 'https://example.com/app' }],
  timers = createFakeTimers(),
  executeScriptImpl,
} = {}) {
  const listeners = {};
  const executedScripts = [];
  const queriedTabs = [];
  const createdTabs = [];
  const reloadedTabs = [];
  const reloadListenerCounts = [];
  const activeAlarms = new Map();
  const storageValues = {};
  const tabUpdatedListeners = new Set();
  const extensionDir = path.join(__dirname, '..', 'extension');

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.closed = false;
      this.sent = [];
      FakeWebSocket.instances.push(this);
    }

    send(message) {
      this.sent.push(JSON.parse(message));
    }

    close() {
      this.closed = true;
      this.readyState = FakeWebSocket.CLOSED;
      if (this.onclose) this.onclose({ type: 'close' });
    }

    open() {
      this.readyState = FakeWebSocket.OPEN;
      if (this.onopen) return this.onopen({ type: 'open' });
      return undefined;
    }

    message(value) {
      if (!this.onmessage) return undefined;
      return this.onmessage({ data: JSON.stringify(value) });
    }

    error() {
      if (this.onerror) return this.onerror({ type: 'error' });
      return undefined;
    }
  }
  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSED = 3;
  FakeWebSocket.instances = [];

  const context = vm.createContext({
    btoa,
    console,
    crypto: { randomUUID: () => 'test-instance-id' },
    location: { href: 'https://example.com/app' },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    URL,
    WebSocket: FakeWebSocket,
    chrome: {
      alarms: {
        create(name, alarmInfo) {
          activeAlarms.set(name, alarmInfo);
        },
        clear(name) {
          return activeAlarms.delete(name);
        },
        onAlarm: {
          addListener(listener) {
            listeners.alarm = listener;
          },
        },
      },
      runtime: {
        getManifest() {
          return { version: '0.2.0' };
        },
        onStartup: {
          addListener(listener) {
            listeners.startup = listener;
          },
        },
        onInstalled: {
          addListener(listener) {
            listeners.installed = listener;
          },
        },
        onMessage: {
          addListener(listener) {
            listeners.message = listener;
          },
        },
      },
      storage: {
        local: {
          async get(key) {
            return { [key]: storageValues[key] };
          },
          async set(values) {
            Object.assign(storageValues, values);
          },
        },
      },
      scripting: {
        async executeScript(details) {
          executedScripts.push(details);
          if (executeScriptImpl) return executeScriptImpl(details);
          return [{ result: { status: 200, ok: true, headers: { 'content-type': 'application/json' }, text: '{"ok":true}' } }];
        },
      },
      tabs: {
        async query(queryInfo) {
          queriedTabs.push(queryInfo);
          return queryTabs;
        },
        async create(createProperties) {
          createdTabs.push(createProperties);
          return { id: 84, url: createProperties.url, status: 'complete' };
        },
        async reload(tabId) {
          reloadedTabs.push(tabId);
          reloadListenerCounts.push(tabUpdatedListeners.size);
        },
        onUpdated: {
          addListener(listener) {
            tabUpdatedListeners.add(listener);
          },
          removeListener(listener) {
            tabUpdatedListeners.delete(listener);
          },
        },
      },
    },
  });

  context.importScripts = (...files) => {
    for (const file of files) {
      const source = fs.readFileSync(path.join(extensionDir, file), 'utf8');
      vm.runInContext(source, context, { filename: file });
    }
  };

  const source = fs.readFileSync(path.join(extensionDir, 'background.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'background.js' });

  return {
    context,
    FakeWebSocket,
    createdTabs,
    executedScripts,
    fireAlarm(name = 'browser-fetch-bridge-reconnect') {
      const alarmInfo = activeAlarms.get(name);
      if (!alarmInfo) return false;
      if (!alarmInfo.periodInMinutes) activeAlarms.delete(name);
      listeners.alarm({ name, ...alarmInfo });
      return true;
    },
    listeners,
    queriedTabs,
    reloadListenerCounts,
    reloadedTabs,
    timers,
    completeTabLoad(tabId) {
      for (const listener of tabUpdatedListeners) {
        listener(tabId, { status: 'complete' }, { id: tabId, status: 'complete' });
      }
    },
  };
}

function responseHeaders(values) {
  return {
    forEach(callback) {
      for (const [key, value] of Object.entries(values)) callback(value, key);
    },
  };
}

test('background exposes proxy status for the popup', () => {
  const { listeners } = loadBackground();

  let response;
  listeners.message({ type: 'getProxyStatus' }, {}, (value) => {
    response = value;
  });

  assert.equal(response.state, 'connecting');
  assert.equal(response.bridgeUrl, 'ws://127.0.0.1:37891/?token=browser-fetch-bridge-dev');
});

test('background reconnect message closes the current socket and starts a new one', () => {
  const { FakeWebSocket, listeners } = loadBackground();
  const firstSocket = FakeWebSocket.instances[0];
  firstSocket.open();

  let response;
  listeners.message({ type: 'reconnectProxy' }, {}, (value) => {
    response = value;
  });

  assert.equal(firstSocket.closed, true);
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(response.state, 'connecting');
});

test('background announces protocol capabilities after connecting', async () => {
  const { FakeWebSocket } = loadBackground();
  const ws = FakeWebSocket.instances[0];
  ws.open();
  await new Promise((resolve) => setImmediate(resolve));

  const hello = ws.sent.find((message) => message.type === 'hello');
  assert.equal(hello.instanceId, 'ext_test-instance-id');
  assert.equal(hello.extensionVersion, '0.2.0');
  assert.equal(hello.protocolVersion, 2);
  assert.deepEqual(hello.capabilities, [
    'fetch.text',
    'fetch.json',
    'fetch.base64',
    'fetch.started-ack',
  ]);
});

test('background automatically reconnects and keeps trying while the daemon is absent', () => {
  const { FakeWebSocket, timers } = loadBackground();
  const firstSocket = FakeWebSocket.instances[0];

  firstSocket.error();
  timers.advanceBy(1499);
  assert.equal(FakeWebSocket.instances.length, 1);

  timers.advanceBy(1);
  const secondSocket = FakeWebSocket.instances[1];
  assert.ok(secondSocket);

  secondSocket.error();
  timers.advanceBy(1500);
  assert.equal(FakeWebSocket.instances.length, 3);
});

test('background deduplicates error and close recovery', () => {
  const { FakeWebSocket, timers } = loadBackground();
  const firstSocket = FakeWebSocket.instances[0];
  const staleClose = firstSocket.onclose;

  firstSocket.error();
  staleClose({ type: 'close' });
  timers.runNext();

  const secondSocket = FakeWebSocket.instances[1];
  secondSocket.error();
  timers.advanceBy(1499);
  assert.equal(FakeWebSocket.instances.length, 2);

  timers.advanceBy(1);
  assert.equal(FakeWebSocket.instances.length, 3);
});

test('background ignores retired socket callbacks and connection timers', () => {
  const {
    FakeWebSocket,
    listeners,
    timers,
  } = loadBackground();
  const firstSocket = FakeWebSocket.instances[0];
  const staleConnectionTimeout = timers.peekNextCallback();
  const staleOpen = firstSocket.onopen;
  const staleMessage = firstSocket.onmessage;
  const staleError = firstSocket.onerror;
  const staleClose = firstSocket.onclose;
  firstSocket.open();

  listeners.message({ type: 'reconnectProxy' }, {}, () => {});
  const recoveredSocket = FakeWebSocket.instances[1];
  recoveredSocket.open();

  staleConnectionTimeout();
  staleOpen({ type: 'open' });
  staleMessage({ data: JSON.stringify({ type: 'pong' }) });
  staleError({ type: 'error' });
  staleClose({ type: 'close' });

  let status;
  listeners.message({ type: 'getProxyStatus' }, {}, (value) => {
    status = value;
  });
  assert.equal(status.state, 'connected');

  timers.advanceBy(20000);
  assert.equal(firstSocket.sent.some((message) => message.type === 'ping'), false);
  assert.equal(recoveredSocket.sent.filter((message) => message.type === 'ping').length, 1);
  assert.equal(FakeWebSocket.instances.length, 2);
});

test('background retires a hanging connection attempt and retries', () => {
  const { FakeWebSocket, listeners, timers } = loadBackground();
  const hangingSocket = FakeWebSocket.instances[0];

  timers.advanceBy(10000);

  let status;
  listeners.message({ type: 'getProxyStatus' }, {}, (value) => {
    status = value;
  });
  assert.equal(hangingSocket.closed, true);
  assert.equal(status.state, 'disconnected');
  assert.match(status.lastError, /connection timed out/);

  timers.advanceBy(1500);
  assert.equal(FakeWebSocket.instances.length, 2);
});

test('background durable alarm recovers after worker timers are lost', () => {
  const { FakeWebSocket, fireAlarm, timers } = loadBackground();
  const firstSocket = FakeWebSocket.instances[0];
  firstSocket.error();
  timers.clearAll();

  assert.equal(fireAlarm(), true);
  const secondSocket = FakeWebSocket.instances[1];
  assert.ok(secondSocket);

  secondSocket.error();
  timers.clearAll();
  assert.equal(fireAlarm(), true);
  assert.equal(FakeWebSocket.instances.length, 3);

  FakeWebSocket.instances[2].open();
  assert.equal(fireAlarm(), false);
});

test('background successful recovery cancels pending retries and its connection deadline', () => {
  const { FakeWebSocket, listeners, timers } = loadBackground();
  const firstSocket = FakeWebSocket.instances[0];
  firstSocket.error();

  listeners.startup();
  const recoveredSocket = FakeWebSocket.instances[1];
  recoveredSocket.open();
  timers.advanceBy(9999);

  assert.equal(recoveredSocket.closed, false);
  assert.equal(FakeWebSocket.instances.length, 2);
});

test('background sends heartbeat pings while connected', () => {
  const { FakeWebSocket, timers } = loadBackground();
  const ws = FakeWebSocket.instances[0];
  ws.open();

  timers.advanceBy(20000);

  assert.deepEqual(ws.sent.find((message) => message.type === 'ping'), { type: 'ping' });
});

test('background heartbeat timeout retires the socket and reconnects', () => {
  const { FakeWebSocket, timers } = loadBackground();
  const ws = FakeWebSocket.instances[0];
  ws.open();

  timers.advanceBy(20000);
  timers.advanceBy(20000);
  assert.equal(ws.closed, true);

  timers.advanceBy(1500);
  assert.equal(FakeWebSocket.instances.length, 2);
});

test('background heartbeat pong keeps the socket open', async () => {
  const { FakeWebSocket, timers } = loadBackground();
  const ws = FakeWebSocket.instances[0];
  ws.open();

  timers.advanceBy(20000);
  await ws.message({ type: 'pong' });
  timers.advanceBy(20000);

  assert.equal(ws.closed, false);
  assert.equal(ws.sent.filter((message) => message.type === 'ping').length, 2);
});

test('background drops stale async request results and errors after reconnecting', async () => {
  const pendingExecutions = [];
  const {
    executedScripts,
    FakeWebSocket,
    timers,
  } = loadBackground({
    executeScriptImpl() {
      return new Promise((resolve, reject) => {
        pendingExecutions.push({ reject, resolve });
      });
    },
  });
  const firstSocket = FakeWebSocket.instances[0];
  firstSocket.open();

  const resultRequest = firstSocket.message({
    id: 'stale-result',
    action: 'fetch',
    payload: { tabUrl: 'https://example.com/app', request: { url: '/api/result' } },
  });
  const errorRequest = firstSocket.message({
    id: 'stale-error',
    action: 'fetch',
    payload: { tabUrl: 'https://example.com/app', request: { url: '/api/error' } },
  });
  await new Promise((resolve) => setImmediate(resolve));

  firstSocket.error();
  timers.advanceBy(1500);
  const recoveredSocket = FakeWebSocket.instances[1];
  recoveredSocket.open();

  pendingExecutions[0].resolve([{ result: { status: 200, ok: true } }]);
  pendingExecutions[1].reject(new Error('stale execution failed'));
  await Promise.all([resultRequest, errorRequest]);

  const staleIds = new Set(['stale-result', 'stale-error']);
  assert.equal(executedScripts.length, 2);
  assert.equal(firstSocket.sent.some((message) => staleIds.has(message.id) && (message.result || message.error)), false);
  assert.equal(recoveredSocket.sent.some((message) => staleIds.has(message.id)), false);
});

test('background injects fetch into a tab matched by caller-provided URL pattern', async () => {
  const { FakeWebSocket, createdTabs, executedScripts, queriedTabs } = loadBackground({
    queryTabs: [{ id: 42, url: 'https://example.com/app' }],
  });
  const ws = FakeWebSocket.instances[0];
  ws.readyState = FakeWebSocket.OPEN;
  ws.onopen();

  await ws.onmessage({
    data: JSON.stringify({
      id: 'fetch-1',
      action: 'fetch',
      payload: {
        tabUrl: 'https://example.com/app',
        request: {
          url: '/api/example',
          method: 'POST',
          headers: { accept: 'application/json' },
          body: '{"id":1}',
        },
      },
    }),
  });

  assert.equal(JSON.stringify(queriedTabs), JSON.stringify([{ url: 'https://example.com/*' }]));
  assert.deepEqual(createdTabs, []);
  assert.equal(executedScripts.length, 1);
  assert.equal(JSON.stringify(executedScripts[0].target), JSON.stringify({ tabId: 42 }));
  assert.equal(executedScripts[0].world, 'MAIN');
  assert.equal(JSON.stringify(executedScripts[0].args[0]), JSON.stringify({
    url: '/api/example',
    method: 'POST',
    headers: { accept: 'application/json' },
    body: '{"id":1}',
  }));
  assert.deepEqual(ws.sent.find((message) => message.type === 'started'), {
    id: 'fetch-1',
    type: 'started',
  });
  assert.deepEqual(ws.sent.find((message) => message.result), {
    id: 'fetch-1',
    result: { status: 200, ok: true, headers: { 'content-type': 'application/json' }, text: '{"ok":true}' },
  });
});

test('background creates the caller-provided tab URL when URL pattern has no match', async () => {
  const { FakeWebSocket, createdTabs, executedScripts, queriedTabs } = loadBackground({ queryTabs: [] });
  const ws = FakeWebSocket.instances[0];
  ws.readyState = FakeWebSocket.OPEN;
  ws.onopen();

  await ws.onmessage({
    data: JSON.stringify({
      id: 'fetch-2',
      action: 'fetch',
      payload: {
        tabUrl: 'https://docs.example.test/start',
        request: { url: '/api/docs' },
      },
    }),
  });

  assert.equal(JSON.stringify(queriedTabs), JSON.stringify([{ url: 'https://docs.example.test/*' }]));
  assert.equal(JSON.stringify(createdTabs), JSON.stringify([{ url: 'https://docs.example.test/start', active: false }]));
  assert.equal(JSON.stringify(executedScripts[0].target), JSON.stringify({ tabId: 84 }));
  assert.equal(JSON.stringify(executedScripts[0].args[0]), JSON.stringify({ url: '/api/docs' }));
});

test('background reloads a discarded matched tab before injecting fetch', async () => {
  const {
    FakeWebSocket,
    completeTabLoad,
    createdTabs,
    executedScripts,
    reloadListenerCounts,
    reloadedTabs,
  } = loadBackground({
    queryTabs: [{
      id: 42,
      url: 'https://example.com/app',
      status: 'unloaded',
      discarded: true,
    }],
  });
  const ws = FakeWebSocket.instances[0];
  ws.readyState = FakeWebSocket.OPEN;
  ws.onopen();

  const request = ws.onmessage({
    data: JSON.stringify({
      id: 'fetch-discarded',
      action: 'fetch',
      payload: {
        tabUrl: 'https://example.com/app',
        request: { url: '/api/example' },
      },
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(reloadedTabs, [42]);
  assert.deepEqual(reloadListenerCounts, [1]);
  assert.deepEqual(createdTabs, []);
  assert.deepEqual(executedScripts, []);
  assert.equal(ws.sent.some((message) => message.type === 'started'), false);

  completeTabLoad(42);
  await request;

  assert.equal(JSON.stringify(executedScripts[0].target), JSON.stringify({ tabId: 42 }));
  assert.equal(ws.sent.some((message) => message.type === 'started'), true);
});

test('fetch defaults to a text response for backward compatibility', async () => {
  const { context } = loadBackground();
  let receivedInit;
  context.fetch = async (_url, init) => {
    receivedInit = init;
    return {
      url: 'https://example.com/api/data',
      status: 200,
      statusText: 'OK',
      ok: true,
      headers: responseHeaders({ 'content-type': 'text/plain' }),
      async text() {
        return 'plain text';
      },
    };
  };

  const result = await context.fetchInPage({
    url: '/api/data',
    responseType: 'text',
  });

  assert.equal(result.text, 'plain text');
  assert.equal(Object.hasOwn(result, 'json'), false);
  assert.equal(Object.hasOwn(receivedInit, 'responseType'), false);
});

test('fetch returns parsed JSON when the caller requests json', async () => {
  const { context } = loadBackground();
  context.fetch = async () => ({
    url: 'https://example.com/api/data',
    status: 200,
    statusText: 'OK',
    ok: true,
    headers: responseHeaders({ 'content-type': 'application/json' }),
    async json() {
      return { items: [1, 2] };
    },
  });

  const result = await context.fetchInPage({
    url: '/api/data',
    responseType: 'json',
  });

  assert.equal(JSON.stringify(result.json), JSON.stringify({ items: [1, 2] }));
  assert.equal(Object.hasOwn(result, 'text'), false);
});

test('fetch returns binary responses as base64 when requested', async () => {
  const { context } = loadBackground();
  context.fetch = async () => ({
    url: 'https://example.com/file.bin',
    status: 200,
    statusText: 'OK',
    ok: true,
    headers: responseHeaders({ 'content-type': 'application/octet-stream' }),
    async arrayBuffer() {
      return Uint8Array.from([0, 255, 1]).buffer;
    },
  });

  const result = await context.fetchInPage({
    url: '/file.bin',
    responseType: 'base64',
  });

  assert.equal(result.base64, 'AP8B');
  assert.equal(result.contentType, 'application/octet-stream');
  assert.equal(result.byteLength, 3);
  assert.equal(Object.hasOwn(result, 'text'), false);
});

test('fetch rejects unsupported response types', async () => {
  const { context } = loadBackground();

  const result = await context.fetchInPage({
    url: '/api/data',
    responseType: 'blob',
  });

  assert.match(result.error, /Unsupported responseType: blob/);
});

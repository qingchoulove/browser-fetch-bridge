const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

const { BrowserBridgeServer } = require('../server/ws-bridge');

function makeRequest({ method = 'GET', url = '/', token = 'test-token', body } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = token ? { 'x-browser-bridge-token': token } : {};
  req.emitBody = () => {
    if (body != null) req.emit('data', Buffer.from(body));
    req.emit('end');
  };
  return req;
}

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(chunk = '') {
      this.body += chunk;
      if (this.resolve) this.resolve(this);
    },
    done() {
      return new Promise((resolve) => {
        this.resolve = resolve;
      });
    },
  };
}

async function handle(bridge, options) {
  const req = makeRequest(options);
  const res = makeResponse();
  const done = res.done();
  bridge.handleHttpRequest(req, res);
  req.emitBody();
  await done;
  return { statusCode: res.statusCode, headers: res.headers, body: JSON.parse(res.body) };
}

function makeAcceptedSocket() {
  const socket = new EventEmitter();
  socket.readyState = WebSocket.OPEN;
  socket.sent = [];
  socket.send = (chunk) => {
    socket.sent.push(String(chunk));
  };
  socket.ping = () => {
    socket.pings = (socket.pings || 0) + 1;
  };
  socket.terminate = () => {
    socket.readyState = WebSocket.CLOSED;
    socket.emit('close');
  };
  return socket;
}

function emitHello(socket) {
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'hello',
    instanceId: 'ext_test',
    extensionVersion: '0.2.0',
    protocolVersion: 2,
    capabilities: ['fetch.json', 'fetch.started-ack'],
  })));
}

function connectReady(bridge) {
  const socket = makeAcceptedSocket();
  bridge.acceptSocket(socket);
  emitHello(socket);
  return socket;
}

test('GET /status returns service and extension connection status', async () => {
  const bridge = new BrowserBridgeServer({ token: 'test-token' });

  const response = await handle(bridge, { method: 'GET', url: '/status' });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.deepEqual(response.body.status, {
    pid: process.pid,
    port: 37891,
    connected: false,
    extension: null,
  });
});

test('server host defaults to localhost and can be configured for containers', () => {
  assert.equal(new BrowserBridgeServer().host, '127.0.0.1');
  assert.equal(new BrowserBridgeServer({ host: '0.0.0.0' }).host, '0.0.0.0');
});

test('POST /fetch forwards payload to connected extension request path', async () => {
  const bridge = new BrowserBridgeServer({ token: 'test-token' });
  let forwarded;
  bridge.request = async (action, payload, timeoutMs) => {
    forwarded = { action, payload, timeoutMs };
    return { ok: true, status: 200, text: '{"ok":true}' };
  };

  const payload = {
    tabUrl: 'https://example.com/app',
    request: { url: '/api/items', method: 'GET' },
    timeoutMs: 1234,
  };
  const response = await handle(bridge, {
    method: 'POST',
    url: '/fetch',
    body: JSON.stringify(payload),
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true, result: { ok: true, status: 200, text: '{"ok":true}' } });
  assert.deepEqual(forwarded, {
    action: 'fetch',
    payload: {
      tabUrl: 'https://example.com/app',
      request: { url: '/api/items', method: 'GET' },
    },
    timeoutMs: 1234,
  });
});

test('fetch is refused until the extension hello completes', async () => {
  const bridge = new BrowserBridgeServer({ token: 'test-token' });
  const socket = makeAcceptedSocket();
  bridge.acceptSocket(socket);

  await assert.rejects(
    bridge.request('fetch', { request: { url: '/api' } }, 1000),
    (error) => error.code === 'extension_not_ready' && error.dispatchState === 'not_dispatched',
  );
});

test('connected socket close rejects pending extension requests', async () => {
  const bridge = new BrowserBridgeServer({ token: 'test-token' });
  const socket = connectReady(bridge);

  const request = bridge.request('fetch', { request: { url: '/api' } }, 1000);
  socket.terminate();

  await assert.rejects(request, /Chrome extension disconnected/);
});

test('keepalive ping closes connected socket after a missed pong', () => {
  const bridge = new BrowserBridgeServer({ token: 'test-token' });
  const socket = {
    readyState: WebSocket.OPEN,
    isAlive: false,
    terminate() {
      this.readyState = WebSocket.CLOSED;
    },
  };
  bridge.socket = socket;

  bridge.checkSocketHealth(socket);

  assert.equal(socket.readyState, WebSocket.CLOSED);
  assert.equal(bridge.status().connected, false);
});

test('keepalive pong keeps connected socket alive', () => {
  const bridge = new BrowserBridgeServer({ token: 'test-token' });
  const socket = {
    readyState: WebSocket.OPEN,
    isAlive: true,
    pings: 0,
    ping() {
      this.pings += 1;
    },
    terminate() {
      this.readyState = WebSocket.CLOSED;
    },
  };

  bridge.checkSocketHealth(socket);
  socket.isAlive = true;
  bridge.checkSocketHealth(socket);

  assert.equal(socket.readyState, WebSocket.OPEN);
  assert.equal(socket.pings, 2);
});

test('accepted WebSocket handles extension ping and fetch roundtrip', async () => {
  const bridge = new BrowserBridgeServer({ token: 'test-token' });
  const socket = connectReady(bridge);

  socket.emit('message', Buffer.from(JSON.stringify({ type: 'ping' })));
  assert.deepEqual(JSON.parse(socket.sent.at(-1)), { type: 'pong' });

  const request = bridge.request('fetch', { request: { url: '/api' } }, 1000);
  const forwarded = JSON.parse(socket.sent.at(-1));
  socket.emit('message', Buffer.from(JSON.stringify({
    id: forwarded.id,
    result: {
      action: forwarded.action,
      payload: forwarded.payload,
    },
  })));

  assert.deepEqual(await request, {
    action: 'fetch',
    payload: { request: { url: '/api' } },
  });
});

test('extension hello exposes protocol capabilities in status', () => {
  const bridge = new BrowserBridgeServer({ token: 'test-token' });
  const socket = makeAcceptedSocket();
  bridge.acceptSocket(socket);
  emitHello(socket);

  assert.deepEqual(bridge.status().extension, {
    instanceId: 'ext_test',
    extensionVersion: '0.2.0',
    protocolVersion: 2,
    capabilities: ['fetch.json', 'fetch.started-ack'],
  });
});

test('started request disconnect reports result_unknown without retrying', async () => {
  const bridge = new BrowserBridgeServer({ token: 'test-token' });
  const socket = connectReady(bridge);

  const request = bridge.request('fetch', { request: { url: '/mutation' } }, 1000);
  const forwarded = JSON.parse(socket.sent.at(-1));
  socket.emit('message', Buffer.from(JSON.stringify({ id: forwarded.id, type: 'started' })));
  socket.terminate();

  await assert.rejects(
    request,
    (error) => error.code === 'result_unknown' && error.dispatchState === 'started',
  );
});

test('extension failure preserves the started dispatch state', async () => {
  const bridge = new BrowserBridgeServer({ token: 'test-token' });
  const socket = connectReady(bridge);

  const request = bridge.request('fetch', { request: { url: '/mutation' } }, 1000);
  const forwarded = JSON.parse(socket.sent.at(-1));
  socket.emit('message', Buffer.from(JSON.stringify({ id: forwarded.id, type: 'started' })));
  socket.emit('message', Buffer.from(JSON.stringify({
    id: forwarded.id,
    error: { code: 'fetch_failed', message: 'response parsing failed' },
  })));

  await assert.rejects(
    request,
    (error) => error.code === 'fetch_failed' && error.dispatchState === 'started',
  );
});

test('unacknowledged request disconnect remains result_unknown', async () => {
  const bridge = new BrowserBridgeServer({ token: 'test-token' });
  const socket = connectReady(bridge);

  const request = bridge.request('fetch', { request: { url: '/api' } }, 1000);
  socket.terminate();

  await assert.rejects(
    request,
    (error) => error.code === 'result_unknown'
      && error.dispatchState === 'dispatched_unacknowledged',
  );
});

test('HTTP routes reject missing token', async () => {
  const bridge = new BrowserBridgeServer({ token: 'test-token' });

  const response = await handle(bridge, { method: 'GET', url: '/status', token: '' });

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.ok, false);
  assert.match(response.body.error, /Unauthorized/);
});

test('POST /fetch rejects invalid JSON', async () => {
  const bridge = new BrowserBridgeServer({ token: 'test-token' });

  const response = await handle(bridge, { method: 'POST', url: '/fetch', body: '{' });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.ok, false);
  assert.match(response.body.error.message, /Invalid JSON/);
});

test('HTTP routes return 404 for unknown paths', async () => {
  const bridge = new BrowserBridgeServer({ token: 'test-token' });

  const response = await handle(bridge, { method: 'GET', url: '/missing' });

  assert.equal(response.statusCode, 404);
  assert.equal(response.body.ok, false);
});

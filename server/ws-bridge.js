const http = require('node:http');
const { WebSocket, WebSocketServer } = require('ws');

class BrowserBridgeServer {
  constructor({ host = '127.0.0.1', port = 37891, token = 'browser-fetch-bridge-dev', keepAliveIntervalMs = 30000 } = {}) {
    this.host = host;
    this.port = Number(port);
    this.token = token;
    this.keepAliveIntervalMs = Number(keepAliveIntervalMs);
    this.server = null;
    this.wss = new WebSocketServer({ noServer: true });
    this.socket = null;
    this.pending = new Map();
    this.nextId = 1;
    this.extension = null;
  }

  start() {
    if (this.server) return Promise.resolve();
    this.server = http.createServer((req, res) => this.handleHttpRequest(req, res));

    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
  }

  close() {
    this.rejectPending(new Error('Bridge server closed'));
    if (this.socket) {
      this.clearSocketKeepAlive(this.socket);
      this.socket.terminate();
    }
    if (this.wss) this.wss.close();
    if (this.server) this.server.close();
    this.socket = null;
    this.extension = null;
    this.server = null;
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      const { reject, timer } = pending;
      clearTimeout(timer);
      const failure = new Error(error.message || String(error));
      failure.code = pending.dispatchState === 'queued' ? 'extension_disconnected' : 'result_unknown';
      failure.dispatchState = pending.dispatchState === 'queued' ? 'not_dispatched' : pending.dispatchState;
      reject(failure);
    }
    this.pending.clear();
  }

  status() {
    return {
      pid: process.pid,
      port: this.port,
      connected: this.isSocketOpen(this.socket),
      extension: this.extension,
    };
  }

  handleHttpRequest(req, res) {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { ok: false, error: 'Unauthorized' });
      return;
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/') {
      this.writeJson(res, 200, { ok: true, name: 'browser-fetch-bridge' });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      this.writeJson(res, 200, { ok: true, status: this.status() });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/fetch') {
      this.readJson(req)
        .then((payload) => this.handleFetch(payload))
        .then((result) => this.writeJson(res, 200, { ok: true, result }))
        .catch((error) => {
          const message = error.message || String(error);
          this.writeJson(res, /Invalid JSON/.test(message) ? 400 : 500, {
            ok: false,
            error: {
              code: error.code || 'bridge_failure',
              message,
              ...(error.dispatchState ? { dispatchState: error.dispatchState } : {}),
            },
          });
        });
      return;
    }

    this.writeJson(res, 404, { ok: false, error: 'Not found' });
  }

  isAuthorized(req) {
    return req.headers['x-browser-bridge-token'] === this.token;
  }

  readJson(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(text ? JSON.parse(text) : {});
        } catch (error) {
          reject(new Error('Invalid JSON request body'));
        }
      });
      req.on('error', reject);
    });
  }

  handleFetch(payload) {
    const { timeoutMs, ...bridgePayload } = payload || {};
    return this.request('fetch', bridgePayload, timeoutMs ?? 60000);
  }

  writeJson(res, statusCode, payload) {
    res.writeHead(statusCode, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  }

  handleUpgrade(req, socket, head = Buffer.alloc(0)) {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    if (url.searchParams.get('token') !== this.token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => this.acceptSocket(ws));
  }

  acceptSocket(socket) {
    if (this.isSocketOpen(this.socket)) {
      this.rejectPending(new Error('Chrome extension disconnected from the bridge'));
      this.clearSocketKeepAlive(this.socket);
      this.socket.terminate();
    }
    this.socket = socket;
    this.extension = null;
    this.startSocketKeepAlive(socket);
    socket.on('pong', () => {
      socket.isAlive = true;
    });
    socket.on('message', (message) => this.handleMessage(message, socket));
    socket.on('close', () => {
      this.clearSocketKeepAlive(socket);
      if (this.socket === socket) {
        this.socket = null;
        this.extension = null;
        this.rejectPending(new Error('Chrome extension disconnected from the bridge'));
      }
    });
    socket.on('error', () => {
      this.clearSocketKeepAlive(socket);
      if (this.socket === socket) {
        this.socket = null;
        this.extension = null;
        this.rejectPending(new Error('Chrome extension disconnected from the bridge'));
      }
    });
  }

  isSocketOpen(socket) {
    return Boolean(socket && socket.readyState === WebSocket.OPEN);
  }

  startSocketKeepAlive(socket) {
    socket.isAlive = true;
    socket.keepAliveTimer = setInterval(() => this.checkSocketHealth(socket), this.keepAliveIntervalMs);
    if (socket.keepAliveTimer.unref) socket.keepAliveTimer.unref();
  }

  clearSocketKeepAlive(socket) {
    if (!socket.keepAliveTimer) return;
    clearInterval(socket.keepAliveTimer);
    socket.keepAliveTimer = null;
  }

  checkSocketHealth(socket) {
    if (!this.isSocketOpen(socket)) return;
    if (!socket.isAlive) {
      socket.terminate();
      return;
    }
    socket.isAlive = false;
    socket.ping();
  }

  handleMessage(message, socket = this.socket) {
    let parsed;
    try {
      parsed = JSON.parse(message.toString('utf8'));
    } catch (error) {
      return;
    }
    if (parsed && parsed.type === 'ping') {
      if (this.isSocketOpen(socket)) socket.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    if (parsed && parsed.type === 'hello') {
      if (socket === this.socket) {
        this.extension = {
          instanceId: parsed.instanceId,
          extensionVersion: parsed.extensionVersion,
          protocolVersion: parsed.protocolVersion,
          capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities : [],
        };
      }
      return;
    }
    if (!parsed || !parsed.id || !this.pending.has(parsed.id)) return;
    const pending = this.pending.get(parsed.id);
    if (parsed.type === 'started') {
      pending.dispatchState = 'started';
      return;
    }
    this.pending.delete(parsed.id);
    clearTimeout(pending.timer);
    if (parsed.error) {
      const error = new Error(parsed.error.message || parsed.error);
      error.code = parsed.error.code || 'extension_failure';
      error.dispatchState = pending.dispatchState;
      pending.reject(error);
    } else {
      pending.resolve(parsed.result);
    }
  }

  request(action, payload = {}, timeoutMs = 60000) {
    if (!this.isSocketOpen(this.socket) || !this.extension) {
      const error = new Error(
        this.isSocketOpen(this.socket)
          ? 'Chrome extension has not completed hello'
          : 'Chrome extension is not connected to the bridge',
      );
      error.code = this.isSocketOpen(this.socket) ? 'extension_not_ready' : 'extension_disconnected';
      error.dispatchState = 'not_dispatched';
      return Promise.reject(error);
    }
    const id = String(this.nextId++);
    const body = JSON.stringify({ id, action, payload });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Bridge request timed out: ${action}`);
        error.code = 'bridge_timeout';
        error.dispatchState = pending.dispatchState;
        reject(error);
      }, timeoutMs);
      const pending = {
        resolve,
        reject,
        timer,
        dispatchState: 'queued',
      };
      this.pending.set(id, pending);
      try {
        this.socket.send(body);
        pending.dispatchState = 'dispatched_unacknowledged';
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        error.code = error.code || 'extension_disconnected';
        error.dispatchState = 'not_dispatched';
        reject(error);
      }
    });
  }
}

module.exports = { BrowserBridgeServer };

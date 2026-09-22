importScripts('proxy-connection-state.js');

const BRIDGE_URL = 'ws://127.0.0.1:37891/?token=browser-fetch-bridge-dev';
const RECONNECT_ALARM_NAME = 'browser-fetch-bridge-reconnect';
const ACTIVE_RECONNECT_DELAY_MS = 1500;
const RECONNECT_WATCHDOG_PERIOD_MINUTES = 0.5;
const CONNECT_TIMEOUT_MS = 10000;
const HEARTBEAT_INTERVAL_MS = 20000;
const PROTOCOL_VERSION = 2;
const CAPABILITIES = [
  'fetch.text',
  'fetch.json',
  'fetch.base64',
  'fetch.started-ack',
];
const INSTANCE_ID_KEY = 'browser_fetch_bridge_instance_id';
let socket = null;
let reconnectTimer = null;
let durableReconnectScheduled = false;
let connectionAttempt = null;
let heartbeat = null;
let instanceIdPromise = null;
const proxyConnectionState = createProxyConnectionState({ bridgeUrl: BRIDGE_URL });

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  proxyConnectionState.markConnecting();

  const ws = new WebSocket(BRIDGE_URL);
  socket = ws;
  startConnectionTimeout(ws);
  ws.onopen = () => {
    if (socket !== ws) return;
    clearConnectionTimeout(ws);
    clearRecoverySchedule();
    proxyConnectionState.markConnected();
    startHeartbeat(ws);
    sendHello(ws);
  };
  ws.onmessage = async (event) => {
    if (socket !== ws || ws.readyState !== WebSocket.OPEN) return;
    const request = JSON.parse(event.data);
    if (request.type === 'pong') {
      if (heartbeat && heartbeat.ws === ws) heartbeat.waitingForPong = false;
      return;
    }
    try {
      const result = await handleBridgeRequest(request, () => {
        sendOnCurrentSocket(ws, { id: request.id, type: 'started' });
      });
      sendOnCurrentSocket(ws, { id: request.id, result });
    } catch (error) {
      sendOnCurrentSocket(ws, { id: request.id, error: { message: error.message || String(error) } });
    }
  };
  ws.onclose = (event) => {
    failConnection(ws, event, false);
  };
  ws.onerror = (event) => {
    failConnection(ws, event, true);
  };
}

function startConnectionTimeout(ws) {
  clearConnectionTimeout();
  const attempt = { ws, timer: null };
  connectionAttempt = attempt;
  attempt.timer = setTimeout(() => {
    if (connectionAttempt !== attempt || socket !== ws) return;
    connectionAttempt = null;
    failConnection(ws, new Error('Bridge connection timed out'), true);
  }, CONNECT_TIMEOUT_MS);
  unrefTimer(attempt.timer);
}

function clearConnectionTimeout(ws) {
  if (!connectionAttempt || (ws && connectionAttempt.ws !== ws)) return;
  clearTimeout(connectionAttempt.timer);
  connectionAttempt = null;
}

function failConnection(ws, error, closeSocket) {
  if (socket !== ws) return;
  socket = null;
  clearConnectionTimeout(ws);
  stopHeartbeat(ws);
  proxyConnectionState.markDisconnected(error);
  scheduleReconnect();
  if (closeSocket && ws.readyState !== WebSocket.CLOSED) ws.close();
}

function sendOnCurrentSocket(ws, message) {
  if (socket !== ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(message));
  return true;
}

function unrefTimer(timer) {
  if (timer && timer.unref) timer.unref();
}

function sendHello(ws) {
  getInstanceId().then((instanceId) => {
    if (socket !== ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: 'hello',
      instanceId,
      extensionVersion: chrome.runtime.getManifest().version,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: CAPABILITIES,
    }));
  });
}

function getInstanceId() {
  if (instanceIdPromise) return instanceIdPromise;
  instanceIdPromise = (async () => {
    const existing = await chrome.storage.local.get(INSTANCE_ID_KEY);
    if (typeof existing[INSTANCE_ID_KEY] === 'string' && existing[INSTANCE_ID_KEY]) {
      return existing[INSTANCE_ID_KEY];
    }
    const instanceId = `ext_${crypto.randomUUID()}`;
    await chrome.storage.local.set({ [INSTANCE_ID_KEY]: instanceId });
    return instanceId;
  })();
  return instanceIdPromise;
}

function scheduleReconnect() {
  if (!reconnectTimer) {
    const timer = setTimeout(() => {
      if (reconnectTimer !== timer) return;
      reconnectTimer = null;
      connect();
    }, ACTIVE_RECONNECT_DELAY_MS);
    reconnectTimer = timer;
    unrefTimer(timer);
  }

  if (!durableReconnectScheduled) {
    durableReconnectScheduled = true;
    chrome.alarms.create(RECONNECT_ALARM_NAME, {
      periodInMinutes: RECONNECT_WATCHDOG_PERIOD_MINUTES,
    });
  }
}

function clearReconnectTimer() {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function clearRecoverySchedule() {
  clearReconnectTimer();
  durableReconnectScheduled = false;
  chrome.alarms.clear(RECONNECT_ALARM_NAME);
}

function getProxyStatus() {
  return proxyConnectionState.snapshot(socket);
}

function reconnectProxy() {
  clearRecoverySchedule();

  const currentSocket = socket;
  socket = null;
  clearConnectionTimeout();
  stopHeartbeat();
  if (currentSocket) {
    proxyConnectionState.markDisconnected();
    if (currentSocket.readyState !== WebSocket.CLOSED) currentSocket.close();
  }

  proxyConnectionState.clearError();
  connect();
  return getProxyStatus();
}

function startHeartbeat(ws) {
  stopHeartbeat();
  const state = { ws, timer: null, waitingForPong: false };
  heartbeat = state;
  scheduleHeartbeat(state);
}

function scheduleHeartbeat(state) {
  state.timer = setTimeout(() => runHeartbeat(state), HEARTBEAT_INTERVAL_MS);
  unrefTimer(state.timer);
}

function stopHeartbeat(ws) {
  if (!heartbeat || (ws && heartbeat.ws !== ws)) return;
  clearTimeout(heartbeat.timer);
  heartbeat = null;
}

function runHeartbeat(state) {
  if (heartbeat !== state || socket !== state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.timer = null;
  if (state.waitingForPong) {
    failConnection(state.ws, new Error('Bridge heartbeat timed out'), true);
    return;
  }
  state.waitingForPong = true;
  sendOnCurrentSocket(state.ws, { type: 'ping' });
  scheduleHeartbeat(state);
}

function handleRuntimeMessage(message, _sender, sendResponse) {
  if (!message || message.type === 'getProxyStatus') {
    sendResponse(getProxyStatus());
    return false;
  }
  if (message.type === 'reconnectProxy') {
    sendResponse(reconnectProxy());
    return false;
  }
  return false;
}

async function handleBridgeRequest(request, onStarted = () => {}) {
  if (request.action !== 'fetch') throw new Error(`Unsupported action: ${request.action}`);
  const payload = request.payload || {};
  const tab = await findTargetTab(payload);
  onStarted();
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: fetchInPage,
    args: [payload.request || {}],
  });
  if (!execution) throw new Error('No execution result from target tab');
  if (execution.result && execution.result.error) throw new Error(execution.result.error);
  return execution.result;
}

async function findTargetTab(payload) {
  const tabUrl = String(payload.tabUrl || '').trim();
  if (!tabUrl) throw new Error('tabUrl is required');
  const tab = new URL(tabUrl);
  if (tab.protocol !== 'http:' && tab.protocol !== 'https:') {
    throw new Error(`tabUrl must be an absolute http(s) URL: ${tabUrl}`);
  }
  const tabUrlPattern = `${tab.origin}/*`;

  const tabs = await chrome.tabs.query({ url: tabUrlPattern });
  const existing = tabs.find((candidate) => candidate && candidate.id);
  if (existing) {
    if (existing.discarded || existing.status === 'unloaded') {
      return waitForTabComplete(existing, () => chrome.tabs.reload(existing.id));
    }
    return existing;
  }

  const created = await chrome.tabs.create({ url: tabUrl, active: false });
  if (!created || !created.id) throw new Error(`Could not create tab for ${tabUrl}`);
  return waitForTabComplete(created);
}

function waitForTabComplete(tab, startLoading) {
  if (!startLoading && tab.status === 'complete') return Promise.resolve(tab);
  return new Promise((resolve, reject) => {
    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
    }

    function fail(error) {
      cleanup();
      reject(error);
    }

    function listener(tabId, changeInfo, updatedTab) {
      if (tabId !== tab.id || changeInfo.status !== 'complete') return;
      cleanup();
      resolve(updatedTab || tab);
    }

    const timer = setTimeout(() => {
      fail(new Error(`Timed out waiting for tab to load: ${tab.url || tab.id}`));
    }, 30000);
    chrome.tabs.onUpdated.addListener(listener);
    if (startLoading) startLoading().catch(fail);
  });
}

async function fetchInPage(request) {
  try {
    if (!request.url) throw new Error('request.url is required');
    const responseType = request.responseType || 'text';
    if (!['text', 'json', 'base64'].includes(responseType)) {
      throw new Error(`Unsupported responseType: ${responseType}`);
    }
    const target = new URL(request.url, location.href);

    const init = {
      method: request.method || 'GET',
      credentials: 'include',
      headers: request.headers || {},
    };
    if (request.body != null) init.body = String(request.body);

    const response = await fetch(target.toString(), init);
    const headers = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const result = {
      url: response.url,
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      headers,
    };
    if (responseType === 'json') {
      result.json = await response.json();
    } else if (responseType === 'base64') {
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      result.base64 = btoa(binary);
      result.contentType = headers['content-type'] || '';
      result.byteLength = bytes.byteLength;
    } else {
      result.text = await response.text();
    }
    return result;
  } catch (error) {
    return { error: error.stack || error.message || String(error) };
  }
}

connect();
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RECONNECT_ALARM_NAME) return;
  if (socket && socket.readyState === WebSocket.OPEN) {
    clearRecoverySchedule();
    return;
  }
  durableReconnectScheduled = true;
  clearReconnectTimer();
  connect();
});
chrome.runtime.onMessage.addListener(handleRuntimeMessage);

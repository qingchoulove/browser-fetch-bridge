const statusDot = document.getElementById('status-dot');
const statusPill = document.getElementById('status-pill');
const statusLabel = document.getElementById('status-label');
const bridgeUrl = document.getElementById('bridge-url');
const lastConnected = document.getElementById('last-connected');
const lastDisconnected = document.getElementById('last-disconnected');
const errorMessage = document.getElementById('error-message');
const reconnectButton = document.getElementById('reconnect-button');
const reconnectLabel = document.getElementById('reconnect-label');

const STATUS_LABELS = {
  connected: 'Connected',
  connecting: 'Connecting',
  disconnected: 'Disconnected',
};

function formatTime(value) {
  if (!value) return 'Never';
  return new Date(value).toLocaleString();
}

function sendRuntimeMessage(type) {
  if (!globalThis.chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
    return Promise.resolve({
      state: 'disconnected',
      bridgeUrl: 'ws://127.0.0.1:37891',
    });
  }

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function renderStatus(status) {
  const state = status && status.state ? status.state : 'disconnected';
  statusDot.className = `status-dot ${state}`;
  statusPill.className = `status-pill ${state}`;
  statusLabel.textContent = STATUS_LABELS[state] || 'Disconnected';
  bridgeUrl.textContent = status && status.bridgeUrl ? status.bridgeUrl : 'ws://127.0.0.1:37891';
  lastConnected.textContent = formatTime(status && status.lastConnectedAt);
  lastDisconnected.textContent = formatTime(status && status.lastDisconnectedAt);

  const error = status && status.lastError ? status.lastError : '';
  errorMessage.hidden = !error;
  errorMessage.textContent = error;
}

async function refreshStatus() {
  try {
    renderStatus(await sendRuntimeMessage('getProxyStatus'));
  } catch (error) {
    renderStatus({
      state: 'disconnected',
      bridgeUrl: 'ws://127.0.0.1:37891',
      lastError: error.message || String(error),
    });
  }
}

async function reconnect() {
  reconnectButton.disabled = true;
  reconnectButton.setAttribute('aria-label', 'Reconnecting bridge');
  reconnectLabel.textContent = 'Reconnecting';
  try {
    renderStatus(await sendRuntimeMessage('reconnectProxy'));
  } catch (error) {
    renderStatus({
      state: 'disconnected',
      bridgeUrl: 'ws://127.0.0.1:37891',
      lastError: error.message || String(error),
    });
  } finally {
    reconnectButton.disabled = false;
    reconnectButton.setAttribute('aria-label', 'Reconnect bridge');
    reconnectLabel.textContent = 'Reconnect';
  }
}

reconnectButton.addEventListener('click', reconnect);
refreshStatus();
setInterval(refreshStatus, 1000);

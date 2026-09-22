(function (root) {
  const SOCKET_CONNECTING = 0;
  const SOCKET_OPEN = 1;

  function messageOf(error) {
    if (!error) return '';
    if (error.message) return String(error.message);
    if (error.type) return String(error.type);
    return String(error);
  }

  function stateOf(socket, fallbackState) {
    if (socket && socket.readyState === SOCKET_OPEN) return 'connected';
    if (socket && socket.readyState === SOCKET_CONNECTING) return 'connecting';
    return fallbackState === 'connecting' ? 'connecting' : 'disconnected';
  }

  function createProxyConnectionState({ bridgeUrl, now = Date.now }) {
    let fallbackState = 'disconnected';
    let lastConnectedAt = 0;
    let lastDisconnectedAt = 0;
    let lastError = '';

    return {
      markConnecting() {
        fallbackState = 'connecting';
      },

      markConnected() {
        fallbackState = 'connected';
        lastConnectedAt = now();
        lastError = '';
      },

      markDisconnected(error) {
        fallbackState = 'disconnected';
        lastDisconnectedAt = now();
        if (error) lastError = messageOf(error);
      },

      clearError() {
        lastError = '';
      },

      snapshot(socket) {
        return {
          bridgeUrl,
          state: stateOf(socket, fallbackState),
          lastConnectedAt,
          lastDisconnectedAt,
          lastError,
        };
      },
    };
  }

  root.createProxyConnectionState = createProxyConnectionState;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createProxyConnectionState };
  }
})(typeof self !== 'undefined' ? self : globalThis);

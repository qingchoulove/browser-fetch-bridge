const test = require('node:test');
const assert = require('node:assert/strict');

const { createProxyConnectionState } = require('../extension/proxy-connection-state');

const BRIDGE_URL = 'ws://127.0.0.1:37891/?token=browser-fetch-bridge-dev';

test('proxy connection state reports connected socket metadata', () => {
  let tick = 1000;
  const state = createProxyConnectionState({
    bridgeUrl: BRIDGE_URL,
    now: () => tick,
  });

  state.markConnecting();
  tick = 2000;
  state.markConnected();

  const snapshot = state.snapshot({ readyState: 1 });

  assert.equal(snapshot.state, 'connected');
  assert.equal(snapshot.bridgeUrl, BRIDGE_URL);
  assert.equal(snapshot.lastConnectedAt, 2000);
  assert.equal(snapshot.lastError, '');
});

test('proxy connection state preserves last error for disconnected sockets', () => {
  const state = createProxyConnectionState({
    bridgeUrl: BRIDGE_URL,
    now: () => 3000,
  });

  state.markDisconnected(new Error('connect failed'));

  const snapshot = state.snapshot(null);

  assert.equal(snapshot.state, 'disconnected');
  assert.equal(snapshot.lastDisconnectedAt, 3000);
  assert.equal(snapshot.lastError, 'connect failed');
});

test('proxy connection state reports connecting sockets without clearing previous timestamps', () => {
  let tick = 4000;
  const state = createProxyConnectionState({
    bridgeUrl: BRIDGE_URL,
    now: () => tick,
  });

  state.markConnected();
  tick = 5000;
  state.markConnecting();

  const snapshot = state.snapshot({ readyState: 0 });

  assert.equal(snapshot.state, 'connecting');
  assert.equal(snapshot.lastConnectedAt, 4000);
  assert.equal(snapshot.lastDisconnectedAt, 0);
});

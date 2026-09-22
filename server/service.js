#!/usr/bin/env node
const { BrowserBridgeServer } = require('./ws-bridge');

const bridge = new BrowserBridgeServer({
  host: process.env.BROWSER_BRIDGE_HOST || '127.0.0.1',
  port: process.env.BROWSER_BRIDGE_PORT || 37891,
  token: process.env.BROWSER_BRIDGE_TOKEN || 'browser-fetch-bridge-dev',
});

process.on('SIGINT', () => { bridge.close(); process.exit(0); });
process.on('SIGTERM', () => { bridge.close(); process.exit(0); });

bridge.start().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});

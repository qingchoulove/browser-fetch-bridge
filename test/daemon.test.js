const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { daemonStatus, stopDaemon } = require('../cli/daemon');
const { getBridgeStatus } = require('../lib/adapter-runtime');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

test('adapter runtime status auto-starts a detached daemon that can be stopped', async (t) => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-fetch-bridge-daemon-'));
  const previousStateDirectory = process.env.BROWSER_BRIDGE_STATE_DIR;
  process.env.BROWSER_BRIDGE_STATE_DIR = stateDirectory;
  const options = {
    host: '127.0.0.1',
    port: await reservePort(),
    token: 'daemon-test-token',
    timeoutMs: 3000,
  };

  t.after(async () => {
    try {
      const status = await daemonStatus(options);
      if (status.running && status.managed) await stopDaemon(options);
    } finally {
      if (previousStateDirectory === undefined) delete process.env.BROWSER_BRIDGE_STATE_DIR;
      else process.env.BROWSER_BRIDGE_STATE_DIR = previousStateDirectory;
      fs.rmSync(stateDirectory, { recursive: true, force: true });
    }
  });

  const response = await getBridgeStatus(options);
  assert.equal(response.ok, true);
  assert.equal(response.status.port, options.port);
  assert.equal(response.status.connected, false);

  const running = await daemonStatus(options);
  assert.equal(running.running, true);
  assert.equal(running.managed, true);
  assert.equal(running.pid, response.status.pid);

  const stopped = await stopDaemon(options);
  assert.equal(stopped.stopped, true);
  assert.equal((await daemonStatus(options)).running, false);
});

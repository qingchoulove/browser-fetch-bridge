const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const START_TIMEOUT_MS = 5000;
const STOP_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 50;

function daemonPaths(options, env = process.env) {
  const stateDirectory = env.BROWSER_BRIDGE_STATE_DIR
    || path.join(os.homedir(), '.browser-fetch-bridge');
  const suffix = String(options.port || 37891);
  return {
    stateDirectory,
    pidFile: path.join(stateDirectory, `daemon-${suffix}.pid`),
    logFile: path.join(stateDirectory, `daemon-${suffix}.log`),
  };
}

function probeDaemon(options, timeoutMs = 500) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: options.host,
      port: options.port,
      path: '/status',
      headers: { 'x-browser-bridge-token': options.token },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Daemon status failed: HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(text ? JSON.parse(text) : {});
        } catch {
          reject(new Error(`Invalid daemon status response: ${text}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`Daemon status timed out after ${timeoutMs}ms`)));
  });
}

function isLocalHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForDaemon(options, expectedPid, timeoutMs = START_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await probeDaemon(options);
      if (!expectedPid || response.status?.pid === expectedPid) return response;
    } catch (error) {
      lastError = error;
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Daemon did not start within ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ''}`);
}

async function startDaemon(options, dependencies = {}) {
  if (!isLocalHost(options.host)) {
    throw new Error(`Cannot auto-start daemon for non-local host: ${options.host}`);
  }

  try {
    const response = await probeDaemon(options);
    return {
      running: true,
      alreadyRunning: true,
      pid: response.status?.pid,
      connected: response.status?.connected === true,
      ...daemonPaths(options),
    };
  } catch {
    // Start a local daemon below.
  }

  const paths = daemonPaths(options);
  fs.mkdirSync(paths.stateDirectory, { recursive: true, mode: 0o700 });
  const logFd = fs.openSync(paths.logFile, 'a');
  const servicePath = path.join(__dirname, '..', 'server', 'service.js');
  const spawnProcess = dependencies.spawn || spawn;
  const child = spawnProcess(process.execPath, [servicePath], {
    detached: true,
    env: {
      ...process.env,
      BROWSER_BRIDGE_HOST: options.host,
      BROWSER_BRIDGE_PORT: String(options.port),
      BROWSER_BRIDGE_TOKEN: options.token,
    },
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);
  child.unref();
  fs.writeFileSync(paths.pidFile, `${child.pid}\n`, { mode: 0o600 });

  try {
    const response = await waitForDaemon(options, child.pid);
    return {
      running: true,
      alreadyRunning: false,
      pid: child.pid,
      connected: response.status?.connected === true,
      ...paths,
    };
  } catch (error) {
    fs.rmSync(paths.pidFile, { force: true });
    throw new Error(`${error.message}. See ${paths.logFile}`);
  }
}

async function daemonStatus(options) {
  const paths = daemonPaths(options);
  try {
    const response = await probeDaemon(options);
    return {
      running: true,
      managed: readPid(paths.pidFile) === response.status?.pid,
      pid: response.status?.pid,
      connected: response.status?.connected === true,
      ...paths,
    };
  } catch {
    return { running: false, managed: false, ...paths };
  }
}

function readPid(pidFile) {
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function stopDaemon(options, dependencies = {}) {
  const paths = daemonPaths(options);
  const managedPid = readPid(paths.pidFile);
  let response;
  try {
    response = await probeDaemon(options);
  } catch {
    fs.rmSync(paths.pidFile, { force: true });
    return { running: false, stopped: false, ...paths };
  }

  const actualPid = response.status?.pid;
  if (!managedPid || managedPid !== actualPid) {
    throw new Error(`Daemon on port ${options.port} was not started by this CLI; refusing to stop PID ${actualPid || 'unknown'}`);
  }

  const killProcess = dependencies.kill || process.kill.bind(process);
  killProcess(managedPid, 'SIGTERM');
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline && isProcessAlive(managedPid)) {
    await delay(POLL_INTERVAL_MS);
  }
  if (isProcessAlive(managedPid)) {
    throw new Error(`Daemon PID ${managedPid} did not stop within ${STOP_TIMEOUT_MS}ms`);
  }
  fs.rmSync(paths.pidFile, { force: true });
  return { running: false, stopped: true, pid: managedPid, ...paths };
}

async function restartDaemon(options) {
  const status = await daemonStatus(options);
  if (status.running) await stopDaemon(options);
  return startDaemon(options);
}

module.exports = {
  daemonPaths,
  daemonStatus,
  isLocalHost,
  probeDaemon,
  restartDaemon,
  startDaemon,
  stopDaemon,
  waitForDaemon,
};

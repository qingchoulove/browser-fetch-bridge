const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const extensionDir = path.join(__dirname, '..', 'extension');

test('extension action opens the proxy status popup', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));

  assert.equal(manifest.action.default_popup, 'popup.html');
});

test('extension manifest enables durable MV3 reconnect alarms', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));

  assert.equal(manifest.minimum_chrome_version, '120');
  assert.ok(manifest.permissions.includes('alarms'));
});

test('popup files use the background proxy status message contract', () => {
  const html = fs.readFileSync(path.join(extensionDir, 'popup.html'), 'utf8');
  const js = fs.readFileSync(path.join(extensionDir, 'popup.js'), 'utf8');

  assert.match(html, /popup\.css/);
  assert.match(html, /popup\.js/);
  assert.match(js, /getProxyStatus/);
  assert.match(js, /reconnectProxy/);
});

test('popup uses Browser Bridge status card layout', () => {
  const html = fs.readFileSync(path.join(extensionDir, 'popup.html'), 'utf8');
  const css = fs.readFileSync(path.join(extensionDir, 'popup.css'), 'utf8');

  assert.match(html, /<h1>Browser Bridge<\/h1>/);
  assert.match(html, /class="codex-mark"/);
  assert.match(html, /id="status-pill"/);
  assert.match(html, /class="refresh-icon"/);
  assert.match(html, /id="reconnect-button"[^>]+aria-label="Reconnect bridge"/);
  assert.doesNotMatch(html, /Control Chrome with Codex/);
  assert.doesNotMatch(html, /Learn more/);
  assert.match(html, /Version v0\.1\.0/);
  assert.match(css, /\.status-card/);
  assert.match(css, /\.status-pill/);
  assert.match(css, /\.icon-button/);
});

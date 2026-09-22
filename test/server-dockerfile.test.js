const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dockerfilePath = path.join(__dirname, '..', 'server', 'Dockerfile');

test('server Dockerfile runs only the bridge service and exposes health checks', () => {
  const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');

  assert.match(dockerfile, /^FROM node:22-alpine/m);
  assert.match(dockerfile, /^WORKDIR \/app/m);
  assert.match(dockerfile, /^COPY package\.json package-lock\.json \.\/$/m);
  assert.match(dockerfile, /^RUN npm ci --omit=dev$/m);
  assert.match(dockerfile, /^ENV NODE_ENV=production/m);
  assert.match(dockerfile, /^ENV BROWSER_BRIDGE_HOST=0\.0\.0\.0/m);
  assert.match(dockerfile, /^EXPOSE 37891/m);
  assert.match(dockerfile, /^HEALTHCHECK /m);
  assert.match(dockerfile, /^CMD \["node", "server\/service\.js"\]/m);
});

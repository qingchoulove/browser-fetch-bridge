const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const VALIDITY_MS = 15 * 60 * 1000;
const TOKEN = /^[a-f0-9]{64}$/;

function authorizationError(code, message) {
  return Object.assign(new Error(message), { code });
}

function planDigest(adapter, input, requestPlan) {
  const serialized = JSON.stringify({ version: 1, adapter, input, requestPlan }, (_key, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
  });
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

function prepareMutation(stateDirectory, digest) {
  // ponytail: retain small authorization records; purge expired records if volume warrants it.
  const directory = path.join(stateDirectory, 'mutation-authorizations');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const preparationToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + VALIDITY_MS).toISOString();
  const fd = fs.openSync(path.join(directory, `${preparationToken}.json`), 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ planDigest: digest, expiresAt }));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return { preparationToken, expiresAt, planDigest: digest };
}

function consumeMutation(stateDirectory, preparationToken, digest) {
  if (typeof preparationToken !== 'string' || !TOKEN.test(preparationToken)) {
    throw authorizationError('authorization_required', 'Apply requires a valid dry-run preparationToken');
  }
  const directory = path.join(stateDirectory, 'mutation-authorizations');
  let prepared;
  try {
    prepared = JSON.parse(fs.readFileSync(path.join(directory, `${preparationToken}.json`), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw authorizationError('authorization_unknown', 'Preparation token is not available in this state directory');
  }
  if (!Number.isFinite(Date.parse(prepared.expiresAt)) || Date.now() >= Date.parse(prepared.expiresAt)) {
    throw authorizationError('authorization_expired', 'Preparation token expired; review a new dry-run');
  }
  if (prepared.planDigest !== digest) {
    throw authorizationError('authorization_mismatch', 'Tool, input or request plan differs from the reviewed dry-run');
  }
  let fd;
  try {
    // Exclusive creation is the cross-process claim. Never restore a consumed authorization.
    fd = fs.openSync(path.join(directory, `${preparationToken}.used`), 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw authorizationError('authorization_consumed', 'Authorization already consumed; read back before preparing another mutation');
  }
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { planDigest, prepareMutation, consumeMutation };

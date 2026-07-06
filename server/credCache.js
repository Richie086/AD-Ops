const crypto = require('crypto');

// Random per-process key. Credentials are encrypted at rest in memory and
// automatically expire; they are never written to disk or logged.
const KEY = crypto.randomBytes(32);
const TTL_MS = 30 * 60 * 1000; // 30 minutes

const store = new Map(); // sessionId -> { domainId, iv, tag, data, expires }

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv, tag, data: enc };
}

function decrypt(rec) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, rec.iv);
  decipher.setAuthTag(rec.tag);
  const dec = Buffer.concat([decipher.update(rec.data), decipher.final()]);
  return dec.toString('utf8');
}

function setCreds(sessionId, domainId, username, password) {
  const payload = JSON.stringify({ username, password });
  const enc = encrypt(payload);
  store.set(sessionId, { domainId, ...enc, expires: Date.now() + TTL_MS });
}

function getCreds(sessionId, domainId) {
  const rec = store.get(sessionId);
  if (!rec) return null;
  if (rec.domainId !== domainId) return null;
  if (Date.now() > rec.expires) {
    store.delete(sessionId);
    return null;
  }
  rec.expires = Date.now() + TTL_MS; // sliding expiry
  return JSON.parse(decrypt(rec));
}

function clearCreds(sessionId) {
  store.delete(sessionId);
}

// Periodic sweep of expired entries.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store.entries()) {
    if (now > v.expires) store.delete(k);
  }
}, 60 * 1000);

module.exports = { setCreds, getCreds, clearCreds };

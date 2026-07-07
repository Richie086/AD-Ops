const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEY_PATH = path.join(__dirname, '..', 'data', '.vault_key');

function getVaultKey() {
  if (process.env.CRED_VAULT_KEY) {
    return crypto.createHash('sha256').update(process.env.CRED_VAULT_KEY).digest();
  }
  if (fs.existsSync(KEY_PATH)) {
    return fs.readFileSync(KEY_PATH);
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true });
  fs.writeFileSync(KEY_PATH, key, { mode: 0o600 });
  return key;
}

const VAULT_KEY = getVaultKey();

function encryptSecret(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', VAULT_KEY, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: enc.toString('base64'),
  };
}

function decryptSecret(rec) {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    VAULT_KEY,
    Buffer.from(rec.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(rec.tag, 'base64'));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(rec.data, 'base64')),
    decipher.final(),
  ]);
  return dec.toString('utf8');
}

module.exports = { encryptSecret, decryptSecret };

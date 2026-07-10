const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, '..', 'data', 'debug-db110a.ndjson');
const MAX_ENTRIES = 200;
const entries = [];

function append(entry) {
  const row = {
    sessionId: 'db110a',
    timestamp: Date.now(),
    ...entry,
  };
  entries.push(row);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify(row) + '\n');
  } catch {
    // ignore disk errors during debug
  }
  return row;
}

function list() {
  return entries.slice();
}

function clear() {
  entries.length = 0;
  try {
    fs.writeFileSync(LOG_PATH, '');
  } catch {
    // ignore
  }
}

module.exports = { append, list, clear, LOG_PATH };

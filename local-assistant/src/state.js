'use strict';
// Local state files (git-ignored local-assistant/.state/): the Telegram polling offset and the Google
// OAuth token. Written atomically (temp file + rename) and readable only by the current user where the
// OS supports it. No conversation text is ever stored.

const fs = require('fs');
const path = require('path');

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

/** Telegram offset store. load() -> number >= 0, or null when missing or unreadable. */
function createOffsetStore(file) {
  return {
    file,
    load() {
      const j = readJson(file);
      return j && Number.isInteger(j.offset) && j.offset >= 0 ? j.offset : null;
    },
    save(offset) { writeJsonAtomic(file, { offset, savedAt: new Date().toISOString() }); }
  };
}

module.exports = { createOffsetStore, writeJsonAtomic, readJson };

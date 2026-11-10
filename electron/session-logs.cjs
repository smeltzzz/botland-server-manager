const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { profileFor } = require('./profiles.cjs');

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_SESSIONS = 10;
const MARKER = '[truncated]';
// A malformed opening quote consumes the rest of the line rather than exposing
// the second half of a secret with spaces.
const value = String.raw`(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|"[^\r\n]*|'[^\r\n]*|[^\s;,]+)`;
const name = String.raw`[a-z0-9_.-]*(?:guid|token|key|secret|passwd|password|auth|rcon)[a-z0-9_.-]*`;
// A header may have a scheme followed by a credential, so redact to end of line.
const authorization = /(\b(?:Proxy-)?Authorization[ \t]*:[ \t]*)[^\r\n]*/gi;
const assignment = new RegExp(String.raw`(\b${name}[ \t]*(?:=|:)[ \t]*)${value}`, 'gi');
const setCommand = new RegExp(String.raw`(\bset(?:a|s|u)?[ \t]+${name}[ \t]+)${value}`, 'gi');
// A quoted console command can be echoed without `set` (e.g. `rcon_password "x"`).
const bareCommand = new RegExp(String.raw`(\b${name}[ \t]+)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|"[^\r\n]*|'[^\r\n]*)`, 'gi');
const sessionName = /^session-\d{8}T\d{9}Z-[a-f0-9-]{36}\.jsonl$/;
// games_mp.log event lines (join, quit, kill, damage, weapon, say) carry player
// GUIDs as semicolon-separated fields, e.g. `0:12 J;0123abcd...;3;Name`.
const gameEvent = /^\s*(?:\d+:\d{2}\s+)?(?:J|Q|K|D|W|L|say|sayteam|tell);/i;
const eventGuid = /;[0-9a-f]{8,32}(?=;|$)/gi;

// The complete server line must be supplied by the caller; no unredacted chunk is written.
function redactLog(text, key = '') {
  try {
    let safe = String(text);
    safe = safe.replace(authorization, '$1[REDACTED]').replace(assignment, '$1[REDACTED]').replace(setCommand, '$1[REDACTED]').replace(bareCommand, '$1[REDACTED]');
    if (gameEvent.test(safe)) safe = safe.replace(eventGuid, ';[REDACTED]');
    return typeof key === 'string' && key ? safe.replaceAll(key, '[REDACTED]') : safe;
  } catch { throw new Error('Could not redact log.'); }
}

function encodeEntry(entry, key, maxBytes) {
  const at = typeof entry?.at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(entry.at)
    ? entry.at : new Date().toISOString();
  const level = ['info', 'error', 'warning'].includes(entry?.level) ? entry.level : 'info';
  const message = redactLog(entry?.message ?? '', key);
  const encode = text => Buffer.from(JSON.stringify({ at, level, message: text }) + '\n', 'utf8');
  let line = encode(message);
  if (line.length <= maxBytes) return line;
  const characters = Array.from(message);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (encode(characters.slice(0, mid).join('') + MARKER).length <= maxBytes) low = mid;
    else high = mid - 1;
  }
  line = encode(characters.slice(0, low).join('') + MARKER);
  return line;
}

class SessionLogs {
  // Pass app.getPath('userData'), not a game folder. Files live in userData/session-logs/<game>/.
  constructor({ userData, maxBytes = DEFAULT_MAX_BYTES, maxSessions = DEFAULT_MAX_SESSIONS } = {}) {
    if (typeof userData !== 'string' || !path.isAbsolute(userData)) throw new Error('An absolute app userData path is required.');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 128 || maxBytes > 16 * 1024 * 1024) throw new Error('Invalid session log size limit.');
    if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 100) throw new Error('Invalid session log retention limit.');
    this.directory = path.join(userData, 'session-logs');
    this.maxBytes = maxBytes;
    this.maxSessions = maxSessions;
    this.sessions = new Map();
    this.queues = new Map();
  }

  enqueue(id, action) {
    profileFor(id); // Reject unknown IDs before they can become directory names.
    const pending = (this.queues.get(id) || Promise.resolve()).then(action);
    this.queues.set(id, pending.catch(() => {}));
    return pending;
  }

  async open(id, key) {
    const directory = path.join(this.directory, id);
    await fs.mkdir(directory, { recursive: true });
    let file;
    let handle;
    // UUIDs and exclusive creation prevent an existing session from being overwritten.
    for (let attempt = 0; attempt < 3; attempt++) {
      const stamp = new Date().toISOString().replace(/[-:.]/g, '');
      file = path.join(directory, `session-${stamp}-${crypto.randomUUID()}.jsonl`);
      try { handle = await fs.open(file, 'wx'); break; }
      catch (error) { if (error.code !== 'EEXIST' || attempt === 2) throw error; }
    }
    try {
      // Only files with our exact name shape are eligible; leave unrelated user files alone.
      const files = (await fs.readdir(directory, { withFileTypes: true }))
        .filter(item => item.isFile() && sessionName.test(item.name))
        .map(item => item.name).sort();
      const old = files.filter(name => name !== path.basename(file));
      // Retention is best effort: a locked old file (open in an editor) must
      // not disable logging for the new session.
      for (const name of old.slice(0, Math.max(0, files.length - this.maxSessions))) {
        await fs.rm(path.join(directory, name)).catch(() => {});
      }
    } catch { /* Listing failed; keep the new session and retry pruning next time. */ }
    const session = { file, handle, size: 0, key };
    this.sessions.set(id, session);
    return file;
  }

  async end(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    session.key = ''; // Strings cannot be securely zeroed in JavaScript, but stop referencing it.
    await session.handle.close();
  }

  // A new start closes the previous file. Pass the Plutonium key only in memory.
  start(id, options = {}) {
    let key;
    try { key = options.key ?? ''; }
    catch { throw new Error('Invalid session log key.'); }
    if (typeof key !== 'string') throw new Error('Invalid session log key.');
    return this.enqueue(id, async () => {
      try { await this.end(id); return await this.open(id, key); }
      catch { throw new Error('Could not start session log.'); }
    });
  }

  // Rotation retains the current in-memory key, unless a replacement is supplied.
  rotate(id, options = {}) {
    let replacement;
    try { replacement = options.key; }
    catch { throw new Error('Invalid session log key.'); }
    if (replacement !== undefined && typeof replacement !== 'string') throw new Error('Invalid session log key.');
    return this.enqueue(id, async () => {
      const key = replacement ?? this.sessions.get(id)?.key ?? '';
      try { await this.end(id); return await this.open(id, key); }
      catch { throw new Error('Could not rotate session log.'); }
    });
  }

  // Append the same { at, level, message } shape manager.addLog creates.
  append(id, entry) {
    return this.enqueue(id, async () => {
      let session = this.sessions.get(id);
      if (!session) throw new Error('No active session log.');
      try {
        const line = encodeEntry(entry, session.key, this.maxBytes);
        if (session.size && session.size + line.length > this.maxBytes) {
          const key = session.key;
          await this.end(id);
          await this.open(id, key);
          session = this.sessions.get(id);
        }
        // FileHandle.writeFile writes from the handle's current position, never a path
        // that another process might replace between validation and append.
        await session.handle.writeFile(line);
        session.size += line.length;
        return session.file;
      } catch {
        await this.end(id).catch(() => {}); // Do not continue after a partial write.
        throw new Error('Could not append session log.');
      }
    });
  }

  close(id) {
    return this.enqueue(id, async () => {
      try { await this.end(id); }
      catch { throw new Error('Could not close session log.'); }
    });
  }
}

module.exports = { redactLog, SessionLogs };

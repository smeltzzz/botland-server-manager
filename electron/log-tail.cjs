const fs = require('node:fs/promises');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { profileFor } = require('./profiles.cjs');

// Fixed engine-specific paths only. No launcher, config, directory discovery, or
// user-supplied log filename is ever consulted. Earlier entries win mtime ties.
const LOGS = Object.freeze({
  cod4: [
    ['game', 'mods/mp_bots/console_mp.log'], ['game', 'main/console_mp.log'],
    ['game', 'main/console.log'], ['game', 'mods/mp_bots/games_mp.log'], ['game', 'main/games_mp.log'],
  ],
  waw: [
    ['storage', 't4/mods/mp_bots/console_mp.log'], ['storage', 't4/main/console_mp.log'],
    ['storage', 't4/mods/mp_bots/games_mp.log'], ['storage', 't4/main/games_mp.log'],
    ['game', 'mods/mp_bots/console_mp.log'], ['game', 'main/console_mp.log'],
    ['game', 'mods/mp_bots/games_mp.log'], ['game', 'main/games_mp.log'],
  ],
  mw2: [
    ['game', 'userraw/console_mp.log'], ['game', 'main/console_mp.log'],
    ['game', 'userraw/console.log'], ['game', 'userraw/games_mp.log'], ['game', 'main/games_mp.log'],
  ],
  bo1: [
    ['storage', 't5/mods/mp_bots/console_mp.log'], ['storage', 't5/main/console_mp.log'],
    ['storage', 't5/mods/mp_bots/games_mp.log'], ['storage', 't5/mods/mp_bots/logs/games_mp.log'],
    ['storage', 't5/main/games_mp.log'], ['game', 'main/console_mp.log'], ['game', 'main/games_mp.log'],
  ],
  mw3: [
    ['storage', 'iw5/console_mp.log'], ['storage', 'iw5/logs/games_mp.log'],
    ['storage', 'iw5/games_mp.log'], ['game', 'main/console_mp.log'], ['game', 'main/games_mp.log'],
  ],
  bo2: [
    ['storage', 't6/main/console_mp.log'], ['storage', 't6/main/logs/games_mp.log'],
    ['storage', 't6/main/games_mp.log'], ['game', 'main/console_mp.log'], ['game', 'main/games_mp.log'],
  ],
});

const CHUNK_BYTES = 16 * 1024;
const MAX_BYTES_PER_POLL = 256 * 1024;
const MAX_LINES_PER_POLL = 200;
const MAX_LINE_CHARS = 8192;
const DEFAULT_INTERVAL_MS = 1000;

function absoluteDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) ||
      /[\x00-\x1f\x7f]/.test(directory) || directory.split(/[\\/]/).includes('..')) {
    throw new Error('A valid absolute log root is required.');
  }
  return path.resolve(directory);
}

/** Return the finite allowlist for one profile; a missing game root is allowed. */
function logCandidates({ id, gamePath, localAppData }) {
  profileFor(id);
  const game = gamePath ? absoluteDirectory(gamePath) : null;
  const storage = localAppData ? path.join(absoluteDirectory(localAppData), 'Plutonium', 'storage') : null;
  return LOGS[id].flatMap(([base, relative]) => {
    const root = base === 'game' ? game : storage;
    return root ? [{ root, relative, file: path.join(root, ...relative.split('/')) }] : [];
  });
}

// Reject reparse points/symlinks in every component beneath the game or storage
// root, including the file. In particular a mod directory must not redirect
// reads into private config data. The root itself is resolved once, because a
// game moved to another drive is commonly reached through a junction.
async function regularLog(candidate) {
  let anchor;
  try { anchor = await fs.realpath(candidate.root); } catch { return null; }
  const parts = path.relative(candidate.root, candidate.file).split(path.sep);
  let name = anchor;
  for (let i = 0; i < parts.length; i++) {
    name = path.join(name, parts[i]);
    let stat;
    try { stat = await fs.lstat(name); } catch { return null; }
    if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory())) return null;
    if (i === parts.length - 1) return stat.isFile() ? stat : null;
  }
  return null;
}

const HEAD_BYTES = 64;
// A bounded sample catches ordinary same-size rewrites (including changes past
// the head) without scanning an unbounded log on every timestamp-only touch.
// Changes solely in the unsampled middle of a large file cannot be detected.
const TAIL_SAMPLE_BYTES = CHUNK_BYTES;
function identity(stat) { return `${stat.dev}:${stat.ino}`; }

async function fingerprint(candidate, stat, budget) {
  const tailLength = Math.min(stat.size, TAIL_SAMPLE_BYTES);
  const headLength = stat.size > TAIL_SAMPLE_BYTES ? HEAD_BYTES : 0;
  if (headLength + tailLength > budget.remaining) return null;
  let handle;
  try {
    const allowed = await regularLog(candidate);
    if (!allowed || identity(allowed) !== identity(stat)) return null;
    handle = await fs.open(candidate.file, 'r');
    const opened = await handle.stat();
    if (!opened.isFile() || identity(opened) !== identity(stat) ||
        opened.size !== stat.size || opened.mtimeMs !== stat.mtimeMs) return null;
    // Do not read through a path swapped to a symlink or junction during open.
    const stillAllowed = await regularLog(candidate);
    if (!stillAllowed || identity(stillAllowed) !== identity(opened)) return null;
    const result = Buffer.alloc(headLength + tailLength);
    for (const [start, length, position] of [[0, headLength, 0], [headLength, tailLength, stat.size - tailLength]]) {
      let read = 0;
      while (read < length) {
        const { bytesRead } = await handle.read(result, start + read, length - read, position + read);
        if (!bytesRead) return null;
        read += bytesRead;
        budget.remaining -= bytesRead;
      }
    }
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) return null;
    return result;
  } catch { return null; } finally { await handle?.close().catch(() => {}); }
}

function freshState(stat, offset = 0) {
  return { identity: identity(stat), offset, mtimeMs: stat.mtimeMs, fingerprint: null, pending: '', partial: '', dropping: false, decoder: new StringDecoder('utf8') };
}

class ServerLogTail {
  constructor({ id, gamePath, localAppData = process.env.LOCALAPPDATA, onLine, redact, intervalMs = DEFAULT_INTERVAL_MS }) {
    this.candidates = logCandidates({ id, gamePath, localAppData });
    if (typeof onLine !== 'function' || (redact !== undefined && typeof redact !== 'function')) {
      throw new TypeError('A line callback and optional redactor are required.');
    }
    if (!Number.isInteger(intervalMs) || intervalMs < 10 || intervalMs > 60_000) throw new RangeError('Invalid polling interval.');
    this.onLine = onLine;
    this.redact = redact || (line => line);
    this.intervalMs = intervalMs;
    this.states = new Map();
    this.active = null;
    this.timer = null;
    this.running = false;
    this.inFlight = null;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    // Existing logs begin at EOF, avoiding disclosure of previous sessions.
    await this.poll(true);
    if (this.running) {
      this.timer = setInterval(() => { void this.poll().catch(() => {}); }, this.intervalMs);
      this.timer.unref?.();
    }
  }

  async stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.inFlight) await this.inFlight.catch(() => {});
    this.states.clear();
    this.active = null;
  }

  async poll(initial = false) {
    if (!this.running) return;
    if (this.inFlight) return this.inFlight;
    const work = this.scan(initial);
    this.inFlight = work;
    try { await work; } finally { if (this.inFlight === work) this.inFlight = null; }
  }

  async scan(initial) {
    const present = [];
    const byteBudget = { remaining: MAX_BYTES_PER_POLL };
    for (const candidate of this.candidates) {
      if (!this.running) return;
      const stat = await regularLog(candidate);
      if (!stat) { this.states.delete(candidate.file); continue; }
      let state = this.states.get(candidate.file);
      if (!state) {
        state = freshState(stat, initial ? stat.size : 0);
        this.states.set(candidate.file, state);
      } else if (state.identity !== identity(stat) || stat.size < state.offset) {
        state = freshState(stat);
        this.states.set(candidate.file, state);
      } else if (stat.size === state.offset && stat.mtimeMs !== state.mtimeMs && state.fingerprint) {
        // NTFS may update mtime after the last read without changing bytes.
        const current = await fingerprint(candidate, stat, byteBudget);
        if (current && !current.equals(state.fingerprint)) {
          state = freshState(stat);
          this.states.set(candidate.file, state);
        } else if (!current) {
          // A transient read failure or exhausted budget is not proof of a rewrite.
          // Keep the old mtime so the comparison can be retried next poll.
          present.push({ candidate, stat, state });
          continue;
        }
      }
      if (state.offset === stat.size && !state.fingerprint) {
        state.fingerprint = await fingerprint(candidate, stat, byteBudget);
      }
      state.mtimeMs = stat.mtimeMs;
      present.push({ candidate, stat, state });
    }
    if (!present.length) { this.active = null; return; }
    // Prefer the most recently written log. A newly active file retains its own
    // offset so switching away and back neither replays nor loses unread data.
    present.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    const selected = present[0];
    this.active = selected.candidate.file;
    if (!initial && this.running) await this.readSelected(selected, byteBudget);
  }

  drain(state, budget) {
    while (this.running && state.pending && budget.count < MAX_LINES_PER_POLL) {
      const end = state.pending.indexOf('\n');
      if (end < 0) {
        if (!state.dropping && state.partial.length + state.pending.length > MAX_LINE_CHARS) {
          state.dropping = true;
          state.partial = '';
        } else if (!state.dropping) state.partial += state.pending;
        state.pending = '';
        break;
      }
      const segment = state.pending.slice(0, end);
      state.pending = state.pending.slice(end + 1);
      if (!state.dropping && state.partial.length + segment.length <= MAX_LINE_CHARS) {
        const line = (state.partial + segment).replace(/\r$/, '');
        // Neither exceptions nor raw bytes are logged; caller controls redaction.
        try { this.onLine(this.redact(line)); } catch { /* A consumer cannot stop the tail. */ }
        budget.count++;
      }
      state.partial = '';
      state.dropping = false;
    }
  }

  async readSelected({ candidate, stat, state }, byteBudget) {
    const budget = { count: 0 };
    this.drain(state, budget);
    if (budget.count >= MAX_LINES_PER_POLL || !this.running || state.offset >= stat.size) return;
    let handle;
    try {
      // Verify again after opening; refuse a path replaced between stat/open.
      const allowed = await regularLog(candidate);
      if (!allowed || identity(allowed) !== state.identity) return;
      handle = await fs.open(candidate.file, 'r');
      const opened = await handle.stat();
      if (!opened.isFile() || identity(opened) !== state.identity) return;
      const stillAllowed = await regularLog(candidate);
      if (!stillAllowed || identity(stillAllowed) !== state.identity) return;
      // Reserve enough for a fresh fingerprint if this read reaches EOF.
      let remaining = Math.min(Math.max(0, byteBudget.remaining - TAIL_SAMPLE_BYTES - HEAD_BYTES), stat.size - state.offset);
      while (this.running && remaining > 0 && budget.count < MAX_LINES_PER_POLL) {
        const block = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, remaining));
        const { bytesRead } = await handle.read(block, 0, block.length, state.offset);
        if (!bytesRead) break;
        state.offset += bytesRead;
        state.fingerprint = null;
        remaining -= bytesRead;
        byteBudget.remaining -= bytesRead;
        state.pending += state.decoder.write(block.subarray(0, bytesRead));
        this.drain(state, budget);
      }
    } catch { /* Missing, locked, or replaced logs are retried on the next poll. */ }
    finally { await handle?.close().catch(() => {}); }
    if (this.running && state.offset === stat.size && !state.fingerprint) {
      state.fingerprint = await fingerprint(candidate, stat, byteBudget);
    }
  }
}

module.exports = { ServerLogTail, logCandidates };

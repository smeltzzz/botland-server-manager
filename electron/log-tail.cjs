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
async function readHead(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } catch { return null; } finally { await handle?.close().catch(() => {}); }
}
// Compares the shared prefix, since a short file may have grown since it was sampled.
async function sameHead(file, state) {
  const head = await readHead(file);
  if (!head || !state.head) return false;
  const length = Math.min(head.length, state.head.length);
  if (!head.subarray(0, length).equals(state.head.subarray(0, length))) return false;
  if (head.length > state.head.length) state.head = head;
  return true;
}

function identity(stat) { return `${stat.dev}:${stat.ino}`; }
function freshState(stat, offset = 0) {
  return { identity: identity(stat), offset, mtimeMs: stat.mtimeMs, pending: '', partial: '', dropping: false, decoder: new StringDecoder('utf8') };
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
    for (const candidate of this.candidates) {
      if (!this.running) return;
      const stat = await regularLog(candidate);
      if (!stat) { this.states.delete(candidate.file); continue; }
      let state = this.states.get(candidate.file);
      if (!state) {
        state = freshState(stat, initial ? stat.size : 0);
        state.head = await readHead(candidate.file);
        this.states.set(candidate.file, state);
      } else if (state.identity !== identity(stat) || stat.size < state.offset ||
                 (stat.size === state.offset && stat.mtimeMs !== state.mtimeMs && !await sameHead(candidate.file, state))) {
        // NTFS can update the write time after the last bytes were read, with
        // no size change. Only a changed beginning means the file was rewritten.
        state = freshState(stat);
        state.head = await readHead(candidate.file);
        this.states.set(candidate.file, state);
      } else if ((!state.head || state.head.length < HEAD_BYTES) && stat.size > (state.head?.length ?? 0)) {
        state.head = await readHead(candidate.file);
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
    if (!initial && this.running) await this.readSelected(selected);
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

  async readSelected({ candidate, stat, state }) {
    const budget = { count: 0 };
    this.drain(state, budget);
    if (budget.count >= MAX_LINES_PER_POLL || !this.running || state.offset >= stat.size) return;
    let handle;
    try {
      // Verify again after opening; refuse a path replaced between stat/open.
      if (!await regularLog(candidate)) return;
      handle = await fs.open(candidate.file, 'r');
      const opened = await handle.stat();
      if (!opened.isFile() || identity(opened) !== state.identity) return;
      let remaining = Math.min(MAX_BYTES_PER_POLL, stat.size - state.offset);
      while (this.running && remaining > 0 && budget.count < MAX_LINES_PER_POLL) {
        const block = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, remaining));
        const { bytesRead } = await handle.read(block, 0, block.length, state.offset);
        if (!bytesRead) break;
        state.offset += bytesRead;
        remaining -= bytesRead;
        state.pending += state.decoder.write(block.subarray(0, bytesRead));
        this.drain(state, budget);
      }
    } catch { /* Missing, locked, or replaced logs are retried on the next poll. */ }
    finally { await handle?.close().catch(() => {}); }
  }
}

module.exports = { ServerLogTail, logCandidates };

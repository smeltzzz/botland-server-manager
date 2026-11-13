const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { readModArchive } = require('./mod-archive.cjs');

const PINS = Object.freeze({
  cod4: Object.freeze({ version: 'Cod4R-DedRun', base: 'iw3mp.exe', target: 'Cod4R-DedRun.exe',
    url: 'https://iw3x.com/files/dedi/Cod4R-DedRun.exe', size: 5741742,
    sha256: '1aa421ee94f9ed742b52412e27235e800b5c242fad5768483f3b308d20832de6' }),
  mw2: Object.freeze({ version: 'v1.1.9-a.4', base: 'iw4mp.exe', target: 'iw4x-launcher.exe',
    url: 'https://github.com/iw4x/launcher/releases/download/v1.1.9-a.4/launcher-1.1.9-a.4-x86_64-windows.zip',
    size: 13012652, sha256: '4116ad1f75319174c96c1fe1f1a87bbf687e1f37dff42feebef74d81a89ad68f',
    unpacked: 44504061 }),
});
const ARGS = Object.freeze(['--skip-launch', '--no-self-update', '--no-shortcuts', '--no-connect-protocol']);
const HASH = /^[a-f0-9]{64}$/u;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const STAGE = '.botland-engine-stage-';
const IDLE_MS = 30_000;
const TOTAL_MS = 5 * 60_000;
// IW4x may update clients, assets and DLC on a slow connection. Avoid killing
// a healthy multi-gigabyte update after a short fixed deadline.
const RUN_MS = 2 * 60 * 60_000;

function permittedUrl(raw, pin, redirected) {
  if (typeof raw !== 'string' || raw !== raw.trim() || raw.includes('\\')) throw new Error('Unapproved engine download redirect.');
  const authority = /^https:\/\/([^/?#]+)(?:[/?#]|$)/u.exec(raw)?.[1];
  let url;
  try { url = new URL(raw); } catch { throw new Error('Unapproved engine download redirect.'); }
  if (!authority || authority !== url.hostname || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) {
    throw new Error('Unapproved engine download redirect.');
  }
  if (!redirected) {
    if (raw !== pin.url) throw new Error('Unapproved engine download URL.');
  } else if (pin === PINS.cod4 || pin.target === 'Cod4R-DedRun.exe') {
    if (url.hostname !== 'iw3x.com' || url.search || raw !== url.href || !url.pathname.startsWith('/files/dedi/') ||
        url.pathname.includes('%') || url.pathname.includes('//') || url.pathname.split('/').includes('..')) {
      throw new Error('Unapproved engine download redirect.');
    }
  } else if (url.hostname !== 'release-assets.githubusercontent.com' || url.pathname === '/' ||
      raw !== url.href || url.pathname.includes('..') || url.pathname.includes('%') || !url.search) {
    throw new Error('Unapproved engine download redirect.');
  }
  return raw;
}

function redirect(location, current) {
  if (!location || location.includes('\\')) throw new Error('Invalid engine download redirect.');
  if (/^https?:\/\//iu.test(location)) return location;
  if (location.startsWith('//')) return `https:${location}`;
  try { return new URL(location, current).href; }
  catch { throw new Error('Invalid engine download redirect.'); }
}

async function download(pin, fetcher) {
  let url = permittedUrl(pin.url, pin, false);
  const controller = new AbortController();
  let reader;
  let idle;
  let expired = false;
  const expire = () => {
    expired = true;
    controller.abort();
    try { if (reader) Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* Reader already closed. */ }
  };
  const touch = () => { clearTimeout(idle); idle = setTimeout(expire, IDLE_MS); };
  const total = setTimeout(expire, TOTAL_MS);
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Engine download timed out.')), TOTAL_MS);
    controller.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Engine download timed out.')); }, { once: true });
  });
  const work = (async () => {
    for (let hops = 0; hops <= 3; hops++) {
      touch();
      let response;
      try { response = await fetcher(url, { method: 'GET', redirect: 'manual', signal: controller.signal }); }
      catch { throw new Error(expired ? 'Engine download timed out.' : 'Engine download unavailable.'); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (hops === 3) throw new Error('Too many engine download redirects.');
        const next = redirect(response.headers.get('location'), url);
        // A signed CDN address can never redirect again to a different origin.
        if (url.startsWith('https://release-assets.githubusercontent.com/')) throw new Error('Unapproved engine download redirect.');
        url = permittedUrl(next, pin, true);
        continue;
      }
      if (response.status !== 200 || !response.body || typeof response.body.getReader !== 'function') {
        throw new Error('Engine download unavailable.');
      }
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) !== pin.size)) {
        throw new Error('Engine download size mismatch.');
      }
      reader = response.body.getReader();
      let size = 0;
      const chunks = [];
      try {
        while (true) {
          let part;
          try { part = await reader.read(); } catch { throw new Error(expired ? 'Engine download timed out.' : 'Unreadable engine download.'); }
          if (expired) throw new Error('Engine download timed out.');
          if (part.done) break;
          if (!(part.value instanceof Uint8Array)) throw new Error('Unreadable engine download.');
          touch();
          size += part.value.length;
          if (size > pin.size) throw new Error('Engine download size mismatch.');
          chunks.push(Buffer.from(part.value));
        }
      } finally {
        const current = reader;
        reader = undefined;
        try { current.releaseLock(); } catch { /* A cancelled read may hold the lock. */ }
      }
      if (size !== pin.size) throw new Error('Engine download size mismatch.');
      const bytes = Buffer.concat(chunks, size);
      if (digest(bytes) !== pin.sha256) throw new Error('Engine download SHA-256 mismatch; nothing was installed.');
      return bytes;
    }
    throw new Error('Too many engine download redirects.');
  })();
  try { return await Promise.race([work, timeout]); }
  finally { clearTimeout(idle); clearTimeout(total); controller.abort(); }
}

function runLauncher(file, args, { cwd, timeout }) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, windowsHide: false, stdio: 'ignore', shell: false });
    let timedOut = false;
    let spawned = false;
    let processError = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* The process may already have exited. */ }
      // Keep the manager's busy reservation until the owned updater actually
      // closes. Releasing it after an arbitrary grace period would let another
      // file change or app quit overlap a process still writing engine files.
    }, timeout);
    child.once('spawn', () => { spawned = true; });
    child.once('error', error => {
      if (spawned) { processError = true; return; }
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) reject(new Error('IW4x launcher timed out.'));
      else if (code === 0) resolve();
      else if (processError && (code === null || code === undefined)) reject(new Error('IW4x launcher process reported an error.'));
      else reject(new Error(`IW4x launcher exited with code ${code ?? 'unknown'}.`));
    });
  });
}

// Do not resolve a selected junction first: every existing ancestor and leaf
// must be a real directory/file, including Windows reparse points (lstat).
async function noLinks(file) {
  const absolute = path.resolve(file);
  const root = path.parse(absolute).root;
  let at = root;
  for (const component of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    at = path.join(at, component);
    let stat;
    try { stat = await fs.lstat(at); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) throw new Error('Engine target contains a symlink or junction.');
  }
}
async function regular(file) {
  await noLinks(file);
  let stat;
  try { stat = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.size > 128 * 1024 * 1024) throw new Error('Engine target is not a bounded regular file.');
  return fs.readFile(file);
}
async function durable(file, bytes) {
  await noLinks(file);
  const handle = await fs.open(file, 'wx');
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function replace(file, bytes, stage) {
  await noLinks(file);
  const temp = path.join(stage, `publish-${randomUUID()}`);
  await durable(temp, bytes);
  // Windows does not reliably replace a live destination with rename. Move the
  // existing file to a journaled stage first; recover() can undo either move.
  const previous = path.join(stage, `moved-${path.basename(file)}`);
  if (await regular(file) !== null) await fs.rename(file, previous);
  await fs.rename(temp, file);
}
async function gameFolder(gamePath, pin) {
  if (typeof gamePath !== 'string' || !path.isAbsolute(gamePath)) throw new Error('Absolute game folder required.');
  const folder = path.resolve(gamePath);
  await noLinks(folder);
  if (!(await fs.stat(folder).catch(() => null))?.isDirectory()) throw new Error('Existing game folder required.');
  if (await regular(path.join(folder, pin.base)) === null) throw new Error(`Expected ${pin.base} in the game folder.`);
  // Store a canonical folder identity in recovery journals. The same Windows
  // directory may later be selected with different casing or a trailing slash.
  return fs.realpath(folder);
}

class EngineUpdater {
  // `pins` is a fixture seam for offline tests only; production callers must not
  // override the hard-coded release digests. `confirmOverwrite` must obtain user
  // consent for EACH unknown existing executable before any files are changed.
  constructor({ fetch: fetcher = globalThis.fetch, run = runLauncher, userData, confirmOverwrite = () => false, pins = PINS } = {}) {
    if (typeof fetcher !== 'function' || typeof run !== 'function' || typeof confirmOverwrite !== 'function') throw new TypeError('Invalid engine updater hooks.');
    if (userData !== undefined && (typeof userData !== 'string' || !path.isAbsolute(userData))) throw new Error('Absolute app data folder required.');
    this.fetch = fetcher;
    this.run = run;
    this.confirmOverwrite = confirmOverwrite;
    this.pins = pins;
    this.busy = new Set();
  }
  async recover(id, folder, pin) {
    const names = (await fs.readdir(folder)).filter(name => name.startsWith(`${STAGE}${id}-`));
    for (const name of names) {
      if (!new RegExp(`^${STAGE}${id}-[a-zA-Z0-9]{6}$`, 'u').test(name)) throw new Error('Invalid engine stage directory; manual inspection required.');
      const stage = path.join(folder, name);
      await noLinks(stage);
      if (!(await fs.lstat(stage)).isDirectory()) throw new Error('Invalid engine stage directory.');
      if (await regular(path.join(stage, 'process-unknown')) !== null) {
        throw new Error('IW4x launcher may still be running; journal retained for manual inspection.');
      }
      const raw = await regular(path.join(stage, 'journal.json'));
      if (!raw) {
        // No game file is touched before the durable journal exists. A crash
        // during preparation may leave only disposable before-* snapshots.
        const contents = await fs.readdir(stage);
        if (!contents.every(item => /^before-[01]$/u.test(item))) throw new Error('Unprepared engine stage; manual inspection required.');
        for (const item of contents) if (await regular(path.join(stage, item)) === null) throw new Error('Invalid engine stage.');
        await fs.rm(stage, { recursive: true });
        continue;
      }
      if (raw.length > 4096) throw new Error('Invalid engine journal.');
      let journal;
      try { journal = JSON.parse(raw.toString('utf8')); } catch { throw new Error('Invalid engine journal.'); }
      const expected = id === 'mw2' ? [pin.target, 'iw4x.exe'] : [pin.target];
      if (journal.version !== 1 || journal.id !== id || journal.folder !== folder ||
          !Array.isArray(journal.files) || journal.files.length !== expected.length ||
          journal.files.some((entry, i) => entry.name !== expected[i] ||
            (entry.before !== null && !HASH.test(entry.before)) ||
            (entry.after !== null && !HASH.test(entry.after)))) throw new Error('Invalid engine journal.');
      const allowed = new Set(['journal.json', 'committed', 'output.sha256', 'external-started', 'process-unknown',
        'before-0', 'before-1', ...expected.map(file => `moved-${file}`)]);
      for (const item of await fs.readdir(stage)) {
        if (!allowed.has(item) && !/^publish-[a-f0-9-]{36}$/u.test(item)) throw new Error('Unexpected engine stage contents; journal retained for manual inspection.');
        const candidate = path.join(stage, item);
        await noLinks(candidate);
        if (!(await fs.lstat(candidate)).isFile()) throw new Error('Invalid engine stage contents.');
      }
      for (const [i, entry] of journal.files.entries()) {
        const before = await regular(path.join(stage, `before-${i}`));
        if ((before === null ? null : digest(before)) !== entry.before) throw new Error('Engine recovery backup mismatch; journal retained.');
      }
      const outputMarker = await regular(path.join(stage, 'output.sha256'));
      if (outputMarker !== null) {
        if (id !== 'mw2' || !/^(?:none|[a-f0-9]{64})$/u.test(outputMarker.toString('utf8'))) throw new Error('Invalid engine output marker.');
        journal.files[1].after = outputMarker.toString('utf8') === 'none' ? null : outputMarker.toString('utf8');
      }
      const committed = await regular(path.join(stage, 'committed'));
      if (committed && (!committed.equals(Buffer.from(digest(raw))) || (id === 'mw2' && outputMarker === null))) {
        throw new Error('Invalid engine commit marker.');
      }
      // Once an external launcher starts, it can change more than iw4x.exe.
      // An interrupted or failed run cannot safely be rolled back by restoring
      // only the two files in this journal. Keep its original bytes for review.
      if (id === 'mw2' && !committed && await regular(path.join(stage, 'external-started')) !== null) {
        throw new Error('IW4x launcher may have changed other files; engine journal retained for manual inspection.');
      }
      // An interrupted external launcher can have produced an unknown iw4x.exe;
      // do not delete/overwrite it without proof of ownership. Preserve backups.
      const actions = [];
      for (const [i, entry] of journal.files.entries()) {
        const file = path.join(folder, entry.name);
        const current = await regular(file);
        const hash = current === null ? null : digest(current);
        const moved = await regular(path.join(stage, `moved-${entry.name}`));
        if (moved !== null && digest(moved) !== entry.before) throw new Error('Engine recovery moved backup mismatch.');
        if (committed ? hash !== entry.after :
          hash !== entry.before && hash !== entry.after && !(hash === null && moved !== null)) {
          throw new Error(`Engine recovery conflict at ${entry.name}; journal retained for manual inspection.`);
        }
        actions.push({ i, entry, file, hash, moved });
      }
      if (!committed) for (const { i, entry, file, hash, moved } of actions.reverse()) {
        if (hash === entry.before) continue;
        if (hash !== null) await fs.unlink(file);
        if (moved !== null) await fs.rename(path.join(stage, `moved-${entry.name}`), file);
        else if (entry.before !== null) await replace(file, await regular(path.join(stage, `before-${i}`)), stage);
      }
      await fs.rm(stage, { recursive: true });
    }
  }
  async prepareLaunch(id, gamePath) {
    if (!Object.hasOwn(PINS, id)) return;
    // A crashed or timed-out updater must not race a new engine start. Recovery
    // belongs to an explicit update action; an IW4x external run may need manual
    // inspection rather than automatic rollback of partially updated assets.
    const files = await fs.readdir(gamePath);
    if (files.some(name => name.startsWith(`${STAGE}${id}-`))) {
      throw new Error(id === 'mw2'
        ? 'An IW4x update journal remains in the game folder. The external launcher may have changed other files; inspect and repair the installation manually before starting or updating again.'
        : 'An interrupted Cod4R DedRun update needs recovery. Use Update Cod4R in Server engines at the bottom left to restore the previous executable and retry.');
    }
  }
  update(id, gamePath) {
    if (!Object.hasOwn(PINS, id)) return Promise.reject(new Error('Only CoD4 and MW2 engine updates are supported.'));
    if (this.busy.has(id)) return Promise.reject(new Error('Engine update already in progress.'));
    this.busy.add(id);
    const work = this.perform(id, gamePath);
    work.finally(() => this.busy.delete(id)).catch(() => {});
    return work;
  }
  async perform(id, gamePath) {
    const pin = this.pins[id];
    if (!pin || !HASH.test(pin.sha256) || !Number.isSafeInteger(pin.size) || pin.size < 1 || pin.size > 32 * 1024 * 1024 ||
        pin.target !== PINS[id].target || pin.base !== PINS[id].base || pin.url !== PINS[id].url) throw new Error('Invalid pinned engine release.');
    const folder = await gameFolder(gamePath, pin);
    await this.recover(id, folder, pin);
    const archive = await download(pin, this.fetch);
    let body = archive;
    if (id === 'mw2') {
      if (!Number.isSafeInteger(pin.unpacked) || pin.unpacked < 1 || pin.unpacked > 50 * 1024 * 1024) throw new Error('Invalid launcher size pin.');
      const entries = readModArchive(archive, { maxInputBytes: pin.size, maxEntries: 1,
        maxEntryBytes: pin.unpacked, maxExtractedBytes: pin.unpacked });
      if (entries.size !== 1 || !entries.has(pin.target) || entries.get(pin.target).length !== pin.unpacked) {
        throw new Error('Unexpected IW4x launcher ZIP contents.');
      }
      body = entries.get(pin.target);
    }
    const files = id === 'mw2' ? [pin.target, 'iw4x.exe'] : [pin.target];
    const originals = [];
    for (const name of files) {
      const current = await regular(path.join(folder, name));
      if (current !== null && !(id === 'cod4' && digest(current) === pin.sha256) &&
          !(id === 'mw2' && name === pin.target && current.equals(body)) &&
          !await this.confirmOverwrite(id, path.join(folder, name), digest(current))) {
        throw new Error(`Refused to overwrite unknown ${name} without explicit consent.`);
      }
      originals.push(current);
    }
    const stage = await fs.mkdtemp(path.join(folder, `${STAGE}${id}-`));
    let journalWritten = false;
    try {
      for (const [i, bytes] of originals.entries()) if (bytes !== null) await durable(path.join(stage, `before-${i}`), bytes);
      const journal = { version: 1, id, folder, files: files.map((name, i) => ({ name,
        before: originals[i] === null ? null : digest(originals[i]),
        after: i === 0 ? digest(body) : null })) };
      const raw = Buffer.from(JSON.stringify(journal));
      await durable(path.join(stage, 'journal.json'), raw);
      journalWritten = true;
      for (const [i, name] of files.entries()) {
        const current = await regular(path.join(folder, name));
        if ((current === null ? null : digest(current)) !== journal.files[i].before) throw new Error('Engine target changed during staging.');
      }
      if (!originals[0]?.equals(body)) await replace(path.join(folder, pin.target), body, stage);
      if (id === 'mw2') {
        // The launcher is verified before execution; its own downloaded output is
        // NOT pinned. Never claim it is a verified artifact.
        await durable(path.join(stage, 'external-started'), Buffer.from('IW4x launcher was invoked.'));
        let runError;
        try { await this.run(path.join(folder, pin.target), ARGS.slice(), { cwd: folder, timeout: RUN_MS }); }
        catch (error) { runError = error; }
        if (runError?.processUnknown) throw runError;
        // An immutable marker identifies the output for recovery. If the process
        // crashes during the external run, no marker exists and any new output
        // is preserved as a conflict, never silently discarded.
        const output = await regular(path.join(folder, 'iw4x.exe'));
        await durable(path.join(stage, 'output.sha256'), Buffer.from(output === null ? 'none' : digest(output)));
        if (runError) throw runError;
        if (output === null) throw new Error('IW4x launcher finished without creating iw4x.exe.');
      }
      const finalJournal = await regular(path.join(stage, 'journal.json'));
      await durable(path.join(stage, 'committed'), Buffer.from(digest(finalJournal)));
      await this.recover(id, folder, pin);
      return { id, version: pin.version };
    } catch (error) {
      if (!journalWritten) await fs.rm(stage, { recursive: true }).catch(() => {});
      else if (error?.processUnknown) {
        await durable(path.join(stage, 'process-unknown'), Buffer.from('IW4x launcher exit was not observed.'));
        throw error;
      }
      else if (id === 'mw2' && await regular(path.join(stage, 'external-started')) !== null) {
        throw new Error(`IW4x launcher did not complete safely: ${error.message} Its journal was retained for manual inspection. Do not start the server until the installation is repaired.`, { cause: error });
      }
      else {
        try { await this.recover(id, folder, pin); }
        catch (rollback) { throw new AggregateError([error, rollback], `Engine rollback failed; journal retained in ${stage}: ${rollback.message}`); }
      }
      throw error;
    }
  }
}

module.exports = { EngineUpdater, PINS, runLauncher };

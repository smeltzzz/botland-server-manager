const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { downloadArchive } = require('./botwarfare-download.cjs');
const { readModArchive } = require('./mod-archive.cjs');
const { recipeFor } = require('./botwarfare-recipes.cjs');

const MANIFEST = 'botland-install.json';
const TARGETS = Object.freeze({
  cod4: ['game', null, 'mods/mp_bots'], mw2: ['game', null, 'userraw'],
  mw3: ['plutonium', 'iw5', 'mods/bots'], waw: ['plutonium', 't4', 'mods/mp_bots'],
  bo1: ['plutonium', 't5', 'mods/mp_bots'], bo2: ['plutonium', 't6', 'scripts/mp'],
});
const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[a-f0-9-]{36}$/u;
const MAX_VERSIONS = 3;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function safeName(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.startsWith('/') ||
      name.split('/').some(part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/u.test(part) ||
        /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
    throw new Error('Unsafe Bot Warfare managed path.');
  }
  return name;
}
function allowed(id, name) {
  safeName(name);
  const waypoint = /^scriptdata\/waypoints\/[^/]+\.csv$/iu.test(name);
  if (id === 'cod4') return name === 'z_svr_bots.iwd' || name === 'maps/mp/gametypes/_callbacksetup.gsx' || waypoint;
  if (id === 'mw2') return name === 'z_svr_bots.iwd' || waypoint;
  if (id === 'mw3' || id === 'waw') return name === 'z_svr_bots.iwd';
  if (id === 'bo1') return ['description.txt', 'mod.ff', 'mp_bots.iwd'].includes(name);
  return id === 'bo2' && ['bots.gsc', 'bots_adapter_pt6.gsc'].includes(name);
}
function records(id, raw) {
  if (!Array.isArray(raw) || raw.length > 10000) throw new Error('Invalid Bot Warfare manifest files.');
  const seen = new Set();
  return raw.map(file => {
    if (!file || typeof file !== 'object' || !allowed(id, file.path) || !HASH.test(file.sha256)) {
      throw new Error('Invalid Bot Warfare managed file.');
    }
    const key = file.path.toLowerCase();
    if (seen.has(key)) throw new Error('Duplicate Bot Warfare managed file.');
    seen.add(key);
    return { path: file.path, sha256: file.sha256 };
  });
}
function validateManifest(raw, id) {
  if (!raw || raw.version !== 1 || raw.id !== id || raw.base !== TARGETS[id][2] ||
      raw.target !== TARGETS[id][0] || raw.storageCode !== TARGETS[id][1] ||
      !['stable', 'development'].includes(raw.channel) || !['tag', 'commit'].includes(raw.refType) ||
      typeof raw.ref !== 'string' || !raw.ref || typeof raw.repo !== 'string' ||
      !/^https:\/\/github\.com\/ineedbots\/[a-z0-9_]+$/u.test(raw.repo) ||
      !HASH.test(raw.sha256) || !Number.isFinite(Date.parse(raw.date)) ||
      !Array.isArray(raw.patches) || raw.patches.some(p => typeof p !== 'string' || p.length > 256)) {
    throw new Error('Invalid Bot Warfare manifest.');
  }
  return { ...raw, files: records(id, raw.files) };
}
function within(root, relative) {
  const result = path.resolve(root, ...relative.split('/'));
  if (!result.startsWith(root + path.sep)) throw new Error('Bot Warfare path escapes target.');
  return result;
}
// Check every component, including existing leaf entries, before reading or mutating.
// This also rejects Windows junctions (lstat reports them as symbolic links).
async function noLinks(file) {
  const resolved = path.resolve(file);
  const { root } = path.parse(resolved);
  let cursor = root;
  for (const part of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error('Bot Warfare target contains a symlink or junction.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
async function regular(file) {
  await noLinks(file);
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile()) throw new Error('Bot Warfare target is not a regular file.');
    return await fs.readFile(file);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function mkdirSafe(dir) { await noLinks(dir); await fs.mkdir(dir, { recursive: true }); await noLinks(dir); }
async function put(file, bytes, stage) {
  await mkdirSafe(path.dirname(file));
  await noLinks(file);
  const staged = path.join(stage, 'publish-' + randomUUID());
  await fs.writeFile(staged, bytes, { flag: 'wx' });
  await fs.rename(staged, file);
}
async function readManifest(base, id) {
  const bytes = await regular(path.join(base, MANIFEST));
  if (!bytes) return null;
  if (bytes.length > 1024 * 1024) throw new Error('Bot Warfare manifest too large.');
  try { return validateManifest(JSON.parse(bytes.toString('utf8')), id); }
  catch { throw new Error('Invalid Bot Warfare manifest; refusing to touch files.'); }
}

class BotWarfareInstaller {
  constructor({ source, download = downloadArchive, localAppData, isRunning = () => false,
    now = () => new Date(), fault = () => {} } = {}) {
    if (!source || typeof source.resolveSource !== 'function' || typeof download !== 'function' ||
        typeof isRunning !== 'function' || typeof now !== 'function' || typeof fault !== 'function') {
      throw new TypeError('Bot Warfare installer requires source, download and callable hooks.');
    }
    this.source = source;
    this.download = download;
    this.localAppData = localAppData;
    this.isRunning = isRunning;
    this.now = now;
    this.fault = fault; // Injectable fault after each published file; tests use this for rollback.
    this.pending = new Map();
  }
  queued(id, task) {
    if (!Object.hasOwn(TARGETS, id)) throw new Error('Unknown Bot Warfare game.');
    const previous = this.pending.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    this.pending.set(id, current);
    current.finally(() => { if (this.pending.get(id) === current) this.pending.delete(id); }).catch(() => {});
    return current;
  }
  async paths(id, gamePath) {
    if (typeof gamePath !== 'string' || !path.isAbsolute(gamePath)) throw new Error('Absolute game folder required.');
    await noLinks(gamePath);
    if (!(await fs.stat(gamePath).catch(() => null))?.isDirectory()) throw new Error('Existing game folder required.');
    const [target, code, base] = TARGETS[id];
    let root = gamePath;
    if (target === 'plutonium') {
      if (typeof this.localAppData !== 'string' || !path.isAbsolute(this.localAppData)) {
        throw new Error('Absolute localAppData required for Plutonium.');
      }
      root = this.localAppData;
      await noLinks(root);
      if (!(await fs.stat(root).catch(() => null))?.isDirectory()) throw new Error('Existing localAppData folder required.');
    }
    const folder = target === 'game' ? path.resolve(root, ...base.split('/')) :
      path.resolve(root, 'Plutonium', 'storage', code, ...base.split('/'));
    const parent = path.dirname(folder);
    const history = path.join(parent, `.botland-versions-${id}-${path.basename(folder)}`);
    await noLinks(folder);
    await noLinks(history);
    return { folder, parent, history, target, code, base };
  }
  async checkRunning(id) {
    const state = await this.isRunning(id);
    if (state === true || state === 'running' || state === 'starting' ||
        (state && typeof state === 'object' && (state.running || state.starting || ['running', 'starting'].includes(state.status)))) {
      throw new Error('Stop the starting or running game before changing Bot Warfare.');
    }
  }
  async versions(paths, id) {
    await noLinks(paths.history);
    let names;
    try { names = await fs.readdir(paths.history); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const result = [];
    for (const name of names) {
      if (!ID.test(name)) throw new Error('Invalid Bot Warfare version history.');
      const dir = path.join(paths.history, name);
      await noLinks(dir);
      if (!(await fs.lstat(dir)).isDirectory()) throw new Error('Invalid Bot Warfare version history.');
      const bytes = await regular(path.join(dir, 'version.json'));
      if (!bytes || bytes.length > 1024 * 1024) throw new Error('Invalid Bot Warfare version history.');
      let entry;
      try { entry = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Invalid Bot Warfare version history.'); }
      if (entry.version !== 1 || entry.versionId !== name || entry.id !== id ||
          !Number.isFinite(Date.parse(entry.date)) ||
          (entry.manifest !== null && !entry.manifest) || !Array.isArray(entry.files)) {
        throw new Error('Invalid Bot Warfare version history.');
      }
      if (entry.manifest) validateManifest(entry.manifest, id);
      entry.files = records(id, entry.files);
      result.push({ ...entry, dir });
    }
    return result.sort((a, b) => b.date.localeCompare(a.date) || b.versionId.localeCompare(a.versionId));
  }
  async status(id, gamePath) {
    return this.queued(id, async () => {
      const paths = await this.paths(id, gamePath);
      const manifest = await readManifest(paths.folder, id);
      const versions = await this.versions(paths, id);
      const markers = id === 'bo1' ? ['mod.ff', 'mp_bots.iwd'] :
        id === 'bo2' ? ['bots.gsc', 'bots_adapter_pt6.gsc'] : ['z_svr_bots.iwd'];
      const unknown = !manifest && (await Promise.all(markers.map(name => regular(within(paths.folder, name)))))
        .some(bytes => bytes !== null);
      return { state: manifest ? 'installed' : unknown ? 'unknown' : 'not-installed',
        targetPath: paths.folder, manifest, versions: versions.map(({ dir, ...entry }) => entry) };
    });
  }
  async listVersions(id, gamePath) {
    return this.queued(id, async () => {
      const paths = await this.paths(id, gamePath);
      return (await this.versions(paths, id)).map(({ dir, ...entry }) => entry);
    });
  }
  async snapshot(paths, id, previous, capture, stage) {
    const versionId = randomUUID();
    const dir = path.join(stage, 'version');
    await mkdirSafe(dir);
    const files = [];
    for (const name of capture) {
      const bytes = await regular(within(paths.folder, name));
      if (bytes === null) continue;
      files.push({ path: name, sha256: digest(bytes) });
      const dest = within(dir, name);
      await mkdirSafe(path.dirname(dest));
      await fs.writeFile(dest, bytes, { flag: 'wx' });
    }
    const record = { version: 1, versionId, id, date: new Date(this.now()).toISOString(),
      manifest: previous, files };
    await fs.writeFile(path.join(dir, 'version.json'), JSON.stringify(record), { flag: 'wx' });
    return { dir, record };
  }
  async transition(id, paths, desired, nextManifest, capture, snapshot = true) {
    await this.checkRunning(id);
    await noLinks(paths.folder);
    const previous = await readManifest(paths.folder, id);
    const owned = new Map((previous?.files || []).map(file => [file.path, file.sha256]));
    const changes = new Map();
    const names = new Set([...owned.keys(), ...desired.keys()]);
    for (const name of names) {
      if (!allowed(id, name)) throw new Error('Invalid Bot Warfare managed path.');
      const current = await regular(within(paths.folder, name));
      const hash = current && digest(current);
      // Never replace or delete a user-modified owned file. A new unowned name
      // can be overwritten only by an explicit install, and is snapshotted.
      if (owned.has(name) && current && hash !== owned.get(name)) continue;
      if (!desired.has(name) && !owned.has(name)) continue;
      const wanted = desired.get(name);
      if (wanted && !Buffer.isBuffer(wanted)) throw new Error('Invalid Bot Warfare payload.');
      if (wanted && current && current.equals(wanted)) continue;
      if (wanted || current) changes.set(name, wanted || null);
    }
    const manifestFile = path.join(paths.folder, MANIFEST);
    const oldManifest = await regular(manifestFile);
    const newManifest = nextManifest ? Buffer.from(JSON.stringify(nextManifest, null, 2) + '\n') : null;
    if (oldManifest || newManifest) changes.set(MANIFEST, newManifest);
    await mkdirSafe(paths.parent);
    const stage = await fs.mkdtemp(path.join(paths.parent, `.botland-stage-${id}-`));
    const originals = new Map();
    let published = false;
    try {
      let hasPrior = Boolean(previous);
      if (snapshot && !hasPrior) {
        for (const name of capture) {
          if (await regular(within(paths.folder, name))) { hasPrior = true; break; }
        }
      }
      const prior = snapshot && hasPrior ? await this.snapshot(paths, id, previous, capture, stage) : null;
      for (const name of changes.keys()) originals.set(name, await regular(name === MANIFEST ? manifestFile : within(paths.folder, name)));
      await this.checkRunning(id);
      let count = 0;
      for (const [name, bytes] of changes) {
        const dest = name === MANIFEST ? manifestFile : within(paths.folder, name);
        await noLinks(dest);
        if (bytes) await put(dest, bytes, stage);
        else await fs.rm(dest, { force: true });
        published = true;
        await this.fault(++count, name);
      }
      if (prior) {
        await mkdirSafe(paths.history);
        await noLinks(path.join(paths.history, prior.record.versionId));
        await fs.rename(prior.dir, path.join(paths.history, prior.record.versionId));
      }
    } catch (error) {
      if (published) {
        const failures = [];
        for (const [name, bytes] of [...originals].reverse()) {
          const dest = name === MANIFEST ? manifestFile : within(paths.folder, name);
          try {
            await noLinks(dest);
            if (bytes) await put(dest, bytes, stage);
            else await fs.rm(dest, { force: true });
          } catch (failure) { failures.push(failure); }
        }
        if (failures.length) throw new AggregateError([error, ...failures], 'Bot Warfare rollback failed; inspect installation.');
      }
      throw error;
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
    // Pruning is housekeeping, not part of the transaction. Never let it undo
    // a successful publish. Do not follow links even in old history entries.
    try {
      const versions = await this.versions(paths, id);
      for (const old of versions.slice(MAX_VERSIONS)) { await noLinks(old.dir); await fs.rm(old.dir, { recursive: true }); }
    } catch { /* A later status call will report damaged history. */ }
    return { state: nextManifest ? 'installed' : 'not-installed', targetPath: paths.folder, manifest: nextManifest };
  }
  async install(id, gamePath, channel = 'stable') {
    return this.queued(id, async () => {
      if (!['stable', 'development'].includes(channel)) throw new Error('Unknown Bot Warfare channel.');
      const paths = await this.paths(id, gamePath);
      await this.checkRunning(id);
      const source = await this.source.resolveSource(id, channel);
      if (!source?.supported || !source.assetUrl || !['tag', 'commit'].includes(source.refType) || !source.ref) {
        throw new Error('Bot Warfare source is not supported for installation.');
      }
      const { bytes, sha256 } = await this.download(source.assetUrl, source.expectedHash ? { expectedHash: source.expectedHash } : {});
      if (!(bytes instanceof Uint8Array) || !HASH.test(sha256) || digest(bytes) !== sha256) {
        throw new Error('Bot Warfare download SHA-256 mismatch.');
      }
      const plan = recipeFor(id, channel, readModArchive(bytes));
      if (plan.target !== paths.target || (plan.storageCode || null) !== paths.code || plan.base !== paths.base ||
          !(plan.files instanceof Map) || !plan.files.size) throw new Error('Unexpected Bot Warfare install target.');
      const files = new Map();
      for (const [name, body] of plan.files) {
        if (!allowed(id, name) || !Buffer.isBuffer(body)) throw new Error('Invalid Bot Warfare recipe payload.');
        files.set(name, body);
      }
      const previous = await readManifest(paths.folder, id);
      const existing = new Map((previous?.files || []).map(item => [item.path, item.sha256]));
      const managed = new Map();
      for (const [name, body] of files) {
        const current = await regular(within(paths.folder, name));
        // Existing unowned waypoints are user data, even if they predate the
        // first manifest. Do not adopt or overwrite them on explicit install.
        if (current && !existing.has(name) && name.startsWith('scriptdata/waypoints/')) {
          files.delete(name);
          continue;
        }
        // A changed waypoint (or any other owned file) remains untouched and
        // retains its original recorded hash, so Remove never deletes it.
        managed.set(name, existing.has(name) && current && digest(current) !== existing.get(name) ?
          existing.get(name) : digest(body));
      }
      for (const [name, hash] of existing) {
        if (!managed.has(name)) {
          const current = await regular(within(paths.folder, name));
          if (current && digest(current) !== hash) managed.set(name, hash);
        }
      }
      const manifest = { version: 1, id, target: paths.target, storageCode: paths.code, base: paths.base,
        repo: source.repo, refType: source.refType, ref: source.ref, channel, sha256,
        date: new Date(this.now()).toISOString(), patches: plan.patches,
        files: [...managed].map(([name, hash]) => ({ path: name, sha256: hash })) };
      validateManifest(manifest, id);
      return this.transition(id, paths, files, manifest, new Set([...existing.keys(), ...files.keys()]));
    });
  }
  async remove(id, gamePath) {
    return this.queued(id, async () => {
      const paths = await this.paths(id, gamePath);
      await this.checkRunning(id);
      const manifest = await readManifest(paths.folder, id);
      if (!manifest) throw new Error('Unknown Bot Warfare installation; nothing owned to remove.');
      return this.transition(id, paths, new Map(), null, new Set(manifest.files.map(file => file.path)));
    });
  }
  async restore(id, gamePath, versionId) {
    return this.queued(id, async () => {
      const paths = await this.paths(id, gamePath);
      await this.checkRunning(id);
      const version = (await this.versions(paths, id)).find(item => item.versionId === versionId);
      if (!version) throw new Error('Unknown Bot Warfare version.');
      const desired = new Map();
      for (const file of version.files) {
        const bytes = await regular(within(version.dir, file.path));
        if (!bytes || digest(bytes) !== file.sha256) throw new Error('Bot Warfare version snapshot SHA-256 mismatch.');
        desired.set(file.path, bytes);
      }
      const previous = await readManifest(paths.folder, id);
      const owned = new Map((previous?.files || []).map(file => [file.path, file.sha256]));
      const manifest = version.manifest ? structuredClone(version.manifest) : null;
      // Never overwrite a newly created unowned file or a user-modified owned
      // file during Restore. Preserve old ownership for any such conflict.
      for (const [name] of desired) {
        const current = await regular(within(paths.folder, name));
        if (current && (!owned.has(name) || digest(current) !== owned.get(name))) {
          desired.delete(name);
          if (manifest) {
            manifest.files = manifest.files.filter(file => file.path !== name);
            if (owned.has(name)) manifest.files.push({ path: name, sha256: owned.get(name) });
          }
        }
      }
      if (manifest) validateManifest(manifest, id);
      return this.transition(id, paths, desired, manifest, new Set([...owned.keys(), ...desired.keys()]));
    });
  }
}

module.exports = { BotWarfareInstaller };

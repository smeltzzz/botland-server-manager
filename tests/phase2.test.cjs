const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { ServerManager } = require('../electron/manager.cjs');
const { KeyStore } = require('../electron/key-store.cjs');
const { order, profiles, launcherPath } = require('../electron/profiles.cjs');

// All paths, including the Plutonium bootstrapper/storage checks, stay in this
// sandbox. Detection is injected: these tests never query Steam or the registry.
async function fixture(work) {
  const base = path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'botland-phase2-'));
  const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = path.join(root, 'local-app-data');
  try {
    await fs.mkdir(process.env.LOCALAPPDATA, { recursive: true });
    return await work(root);
  } finally {
    process.env.LOCALAPPDATA = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function put(file, body = '') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body);
}
async function cod4(root, name) {
  const folder = path.join(root, name);
  await put(path.join(folder, 'iw3mp.exe'));
  await put(path.join(folder, 'Cod4R-DedRun.exe'));
  await put(path.join(folder, 'main', 'botserver.cfg'), 'set sv_hostname "Synthetic CoD4"\n');
  await put(path.join(folder, 'mods', 'mp_bots', 'z_svr_bots.iwd'));
  return folder;
}
function detection(games = {}) {
  return { steamPath: '', libraries: [], games };
}
function found(gamePath) {
  return { gamePath, installed: true, enginePath: '', engineInstalled: true };
}
function game(snapshot, id) {
  return snapshot.games.find(item => item.id === id);
}
function dialog(folder) {
  return { showOpenDialog: async () => ({ canceled: !folder, filePaths: folder ? [folder] : [] }) };
}
function fakeSafeStorage() {
  const secret = crypto.randomBytes(32);
  let available = true;
  return {
    setAvailable(value) { available = value; },
    isEncryptionAvailable() { return available; },
    encryptString(value) {
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', secret, nonce);
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), body]);
    },
    decryptString(bytes) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', secret, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

test('absent legacy scripts do not block a detected Cod4R install with config and mod', async () => fixture(async root => {
  const scripts = path.join(root, 'absent-scripts');
  const installed = await cod4(root, 'Detected CoD4');
  let scans = 0;
  const events = [];
  const manager = new ServerManager(path.join(root, 'settings.json'), event => events.push(event), scripts, {
    detectInstallations: async () => { scans++; return detection({ cod4: found(installed) }); },
  });
  assert.equal(await manager.initialize(), null);
  assert.equal(game(await manager.snapshot(), 'cod4').pathSource, 'none');
  await manager.rescanInstallations();
  const snapshot = await manager.snapshot();
  const card = game(snapshot, 'cod4');
  assert.equal(scans, 1);
  assert.equal(card.gamePath, installed);
  assert.equal(card.installed, true);
  assert.equal(card.pathSource, 'steam');
  assert.equal(card.config.sv_hostname, 'Synthetic CoD4');
  assert.deepEqual(card.blockers, []);
  assert.equal(card.keyStatus, 'not-required');
  const command = manager.buildCommand(profiles.cod4, installed, card.options.port, card.options.mode, '', false);
  assert.equal(command.file, path.join(installed, 'Cod4R-DedRun.exe'));
  assert.deepEqual(command.args.slice(0, 4), ['-nogui', '+set', 'dedicated', '2']);
  assert.equal(command.args[command.args.indexOf('fs_game') + 1], 'mods/mp_bots');
  assert.equal(command.args.includes('cod4x.exe'), false);
  assert.equal(game(snapshot, 'waw').installed, false);
  assert.equal(game(snapshot, 'waw').pathSource, 'none');
  assert.equal(events.at(-1).snapshot.games[0].id, 'cod4');
  await assert.rejects(fs.stat(scripts), { code: 'ENOENT' });
}));

test('browse validates multiplayer files; manual override survives detection changes and restart', async () => fixture(async root => {
  const detected = await cod4(root, 'Detected');
  const manual = await cod4(root, 'Manual');
  const refreshed = await cod4(root, 'Detected After Rescan');
  const wrong = path.join(root, 'Wrong Folder');
  await put(path.join(wrong, 'iw4mp.exe'));
  let suggested = detected;
  const services = { detectInstallations: async () => detection({ cod4: found(suggested) }) };
  const settings = path.join(root, 'settings.json');
  const scripts = path.join(root, 'no-scripts');
  const manager = new ServerManager(settings, () => {}, scripts, services);
  await manager.initialize();
  await manager.rescanInstallations();
  assert.equal(game(await manager.snapshot(), 'cod4').gamePath, detected);
  assert.equal(await manager.chooseFolder('cod4', null, dialog(null)), false);
  await assert.rejects(manager.chooseFolder('cod4', null, dialog(wrong)), /multiplayer game executable/);
  assert.equal(game(await manager.snapshot(), 'cod4').gamePath, detected);
  await assert.rejects(fs.stat(settings), { code: 'ENOENT' });
  assert.equal(await manager.chooseFolder('cod4', null, dialog(manual)), true);
  let card = game(await manager.snapshot(), 'cod4');
  assert.equal(card.gamePath, manual);
  assert.equal(card.pathSource, 'manual');
  assert.equal(card.installed, true);
  assert.deepEqual(card.blockers, []);
  suggested = refreshed;
  await manager.rescanInstallations();
  card = game(await manager.snapshot(), 'cod4');
  assert.equal(card.gamePath, manual);
  assert.equal(card.pathSource, 'manual');
  assert.equal(JSON.parse(await fs.readFile(settings, 'utf8')).games.cod4.gamePath, manual);
  const reopened = new ServerManager(settings, () => {}, scripts, services);
  await reopened.initialize();
  await reopened.rescanInstallations();
  assert.equal(game(await reopened.snapshot(), 'cod4').gamePath, manual);
  assert.equal(game(await reopened.snapshot(), 'cod4').pathSource, 'manual');
  await fs.rm(path.join(manual, 'iw3mp.exe'));
  card = game(await reopened.snapshot(), 'cod4');
  assert.equal(card.installed, false);
  assert.match(card.blockers.join(' '), /multiplayer files were not found/);
}));

test('rescans replace reordered suggestions while preserving snapshot order and installed/pathSource fields', async () => fixture(async root => {
  const first = await cod4(root, 'First');
  const second = await cod4(root, 'Second');
  const mw2 = path.join(root, 'MW2');
  await put(path.join(mw2, 'iw4mp.exe'));
  await put(path.join(mw2, 'iw4x.exe'));
  await put(path.join(mw2, 'userraw', 'serverlan.cfg'), 'set sv_hostname "Synthetic MW2"\n');
  await put(path.join(mw2, 'userraw', 'z_svr_bots.iwd'));
  let next = detection({ mw2: found(mw2), cod4: found(first) });
  let calls = 0;
  const events = [];
  const manager = new ServerManager(path.join(root, 'settings.json'), event => events.push(event), path.join(root, 'scripts'), {
    detectInstallations: async () => { calls++; return next; },
  });
  await manager.rescanInstallations();
  let state = events.at(-1).snapshot;
  assert.deepEqual(state.games.map(item => item.id), order);
  for (const id of order) {
    const card = game(state, id);
    assert.equal(card.installed, ['cod4', 'mw2'].includes(id), id);
    assert.equal(card.pathSource, card.installed ? 'steam' : 'none', id);
  }
  assert.deepEqual(game(state, 'mw2').blockers, []);
  next = detection({ bo2: found(path.join(root, 'missing-BO2')), cod4: found(second) });
  await manager.rescanInstallations();
  state = events.at(-1).snapshot;
  assert.equal(calls, 2);
  assert.deepEqual(state.games.map(item => item.id), order);
  assert.equal(game(state, 'cod4').gamePath, second);
  assert.equal(game(state, 'cod4').pathSource, 'steam');
  assert.equal(game(state, 'mw2').installed, false);
  assert.equal(game(state, 'mw2').pathSource, 'none');
  assert.equal(game(state, 'bo2').installed, false);
  assert.equal(game(state, 'bo2').pathSource, 'steam');
  next = detection();
  await manager.rescanInstallations();
  assert.equal(game(await manager.snapshot(), 'cod4').pathSource, 'none');
  assert.equal(game(await manager.snapshot(), 'cod4').gamePath, '');
}));

test('Plutonium key stays absent until explicit import from a synthetic launcher; only status is published', async () => fixture(async root => {
  const scripts = path.join(root, 'private-synthetic-scripts');
  const launcher = launcherPath(scripts, profiles.waw);
  const key = `fixture-token-${crypto.randomBytes(12).toString('hex')}`;
  const original = Buffer.from(`@echo off\r\nset "key=${key}"\r\n`);
  await put(launcher, original);
  const safeStorage = fakeSafeStorage();
  const keyFile = path.join(root, 'private', 'keys.json');
  const settings = path.join(root, 'settings.json');
  const store = new KeyStore(keyFile, safeStorage);
  const events = [];
  const manager = new ServerManager(settings, event => events.push(event), scripts, {
    keyStore: store, detectInstallations: async () => detection(),
  });
  const originalReadFile = fs.readFile;
  let launcherReads = 0;
  fs.readFile = async (...args) => {
    if (args[0] === launcher) launcherReads++;
    return originalReadFile(...args);
  };
  try {
    await manager.initialize();
    await manager.rescanInstallations();
    assert.equal(game(await manager.snapshot(), 'waw').keyStatus, 'missing');
    assert.equal(game(await manager.snapshot(), 'bo2').keyStatus, 'missing');
    assert.equal(game(await manager.snapshot(), 'cod4').keyStatus, 'not-required');
    assert.equal(await store.has('waw'), false);
    await assert.rejects(fs.stat(keyFile), { code: 'ENOENT' });
    manager.data.root = '';
    await assert.rejects(manager.importKey('waw'), /Choose your private legacy scripts folder/);
    manager.data.root = scripts;
    await assert.rejects(manager.importKey('bo1'), /No key was found/);
    assert.equal(launcherReads, 0);
    assert.equal(await manager.importKey('waw'), true);
    assert.equal(launcherReads, 1);
  } finally {
    fs.readFile = originalReadFile;
  }
  // The import above is the only launcher read, even though it existed at startup.
  assert.equal(await store.get('waw'), key);
  assert.equal(game(await manager.snapshot(), 'waw').keyStatus, 'stored');
  assert.deepEqual(await fs.readFile(launcher), original);
  await manager.saveOptions('waw', { port: 28970 });
  const ordinarySettings = await fs.readFile(settings, 'utf8');
  assert.equal(JSON.parse(ordinarySettings).games.waw.port, 28970);
  assert.equal(ordinarySettings.includes(key), false);
  const encrypted = await fs.readFile(keyFile, 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(encrypted).keys), ['waw']);
  assert.equal(encrypted.includes(key), false);
  assert.equal(encrypted.includes(Buffer.from(key).toString('base64')), false);
  const statusOnly = JSON.stringify({ snapshot: await manager.snapshot(), events, settings: manager.data });
  assert.equal(statusOnly.includes(key), false);
  assert.equal(statusOnly.includes('fixture-token-'), false);

  safeStorage.setAvailable(false);
  const unavailable = game(await manager.snapshot(), 'waw');
  assert.equal(unavailable.keyStatus, 'unavailable');
  assert.match(unavailable.blockers.join(' '), /Encrypted server keys cannot be read/);
  assert.equal(JSON.stringify(unavailable).includes(key), false);
  assert.equal(await fs.readFile(keyFile, 'utf8'), encrypted);
  safeStorage.setAvailable(true);
  await manager.rescanInstallations();
  assert.equal(game(await manager.snapshot(), 'waw').keyStatus, 'stored');
  await manager.removeKey('waw');
  assert.equal(game(await manager.snapshot(), 'waw').keyStatus, 'missing');
  assert.deepEqual(await fs.readFile(launcher), original);
}));

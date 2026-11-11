const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { ServerManager } = require('../electron/manager.cjs');
const { KeyStore } = require('../electron/key-store.cjs');
const { order, profiles } = require('../electron/profiles.cjs');

// All paths, including the Plutonium bootstrapper/storage checks, stay in this
// sandbox. Detection is injected: these tests never query Steam or the registry.
async function fixture(work) {
  // %LOCALAPPDATA% is the Windows per-user temp root; fall back to the OS temp
  // directory so the suite also runs on a developer's non-Windows checkout.
  const base = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'botland-phase2-'));
  const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = path.join(root, 'local-app-data');
  try {
    await fs.mkdir(process.env.LOCALAPPDATA, { recursive: true });
    return await work(root);
  } finally {
    // Assigning undefined stores the string "undefined", which would leave every
    // later test in this file with a relative LOCALAPPDATA root.
    if (previous === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous;
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
  await put(path.join(folder, 'zone', 'english', 'mp_crash.ff'));
  await put(path.join(folder, 'zone', 'english', 'mp_crash_load.ff'));
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

test('a detected Cod4R install with config and mod is ready without any other files', async () => fixture(async root => {
  const installed = await cod4(root, 'Detected CoD4');
  let scans = 0;
  const events = [];
  const manager = new ServerManager(path.join(root, 'settings.json'), event => events.push(event), {
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
  assert.deepEqual(card.setup, { folder: true, engine: true, plutonium: null, key: null, bots: true, config: true, maps: true });
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
  const manager = new ServerManager(settings, () => {}, services);
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
  const reopened = new ServerManager(settings, () => {}, services);
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
  await put(path.join(mw2, 'zone', 'english', 'mp_rust.ff'));
  await put(path.join(mw2, 'zone', 'english', 'mp_rust_load.ff'));
  let next = detection({ mw2: found(mw2), cod4: found(first) });
  let calls = 0;
  const events = [];
  const manager = new ServerManager(path.join(root, 'settings.json'), event => events.push(event), {
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

test('a pasted Plutonium key is stored encrypted; only its status is ever published', async () => fixture(async root => {
  const key = `fixture-token-${crypto.randomBytes(12).toString('hex')}`;
  const safeStorage = fakeSafeStorage();
  const keyFile = path.join(root, 'private', 'keys.json');
  const settings = path.join(root, 'settings.json');
  const store = new KeyStore(keyFile, safeStorage);
  const events = [];
  const manager = new ServerManager(settings, event => events.push(event), {
    keyStore: store, detectInstallations: async () => detection(),
  });
  await manager.initialize();
  await manager.rescanInstallations();
  assert.equal(game(await manager.snapshot(), 'waw').keyStatus, 'missing');
  assert.equal(game(await manager.snapshot(), 'waw').setup.key, false);
  assert.equal(game(await manager.snapshot(), 'bo2').keyStatus, 'missing');
  assert.equal(game(await manager.snapshot(), 'cod4').keyStatus, 'not-required');
  assert.equal(game(await manager.snapshot(), 'cod4').setup.key, null);
  assert.equal(await store.has('waw'), false);
  await assert.rejects(fs.stat(keyFile), { code: 'ENOENT' });
  await assert.rejects(manager.saveKey('cod4', key), /does not use a Plutonium server key/);
  await manager.saveKey('waw', key);
  assert.equal(await store.get('waw'), key);
  assert.equal(game(await manager.snapshot(), 'waw').keyStatus, 'stored');
  assert.equal(game(await manager.snapshot(), 'waw').setup.key, true);
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
}));

test('an unreadable or damaged key store is explained, can be fixed by pasting or resetting, and never leaks a key', async () => fixture(async root => {
  const keyFile = path.join(root, 'private', 'keys.json');
  const settings = path.join(root, 'settings.json');
  const oldProfile = new KeyStore(keyFile, fakeSafeStorage());
  await oldProfile.save('waw', 'previous-profile-key-111');
  await oldProfile.save('bo1', 'previous-profile-key-222');
  const store = new KeyStore(keyFile, fakeSafeStorage());
  const events = [];
  const manager = new ServerManager(settings, event => events.push(event), { keyStore: store, detectInstallations: async () => detection() });
  await manager.initialize();
  await manager.rescanInstallations();

  // Another Windows profile wrote these keys: unreadable, and pasting must work.
  let waw = game(await manager.snapshot(), 'waw');
  assert.equal(waw.keyStatus, 'unavailable');
  assert.equal(waw.keyReason, 'unreadable');
  assert.equal(waw.setup.key, false);
  assert.match(waw.blockers.join(' '), /cannot be read by this Windows profile.*Paste your key again/);
  assert.equal(game(await manager.snapshot(), 'bo2').keyStatus, 'missing');
  assert.equal(game(await manager.snapshot(), 'bo2').keyReason, null);
  assert.equal(game(await manager.snapshot(), 'cod4').keyReason, null);
  assert.equal(await manager.resetKeyStore(), false, 'an unreadable (not damaged) key is not reset');
  await manager.saveKey('waw', 'fresh-key-abcdef');
  waw = game(await manager.snapshot(), 'waw');
  assert.equal(waw.keyStatus, 'stored');
  assert.equal(waw.keyReason, null);
  assert.equal(game(await manager.snapshot(), 'bo1').keyReason, 'unreadable');

  // A damaged keys.json blocks saving until it is reset; the old file is kept.
  const damaged = '{"version":1,"keys":';
  await fs.writeFile(keyFile, damaged);
  const blocked = game(await manager.snapshot(), 'mw3');
  assert.equal(blocked.keyStatus, 'unavailable');
  assert.equal(blocked.keyReason, 'damaged');
  assert.match(blocked.blockers.join(' '), /Reset key storage/);
  await assert.rejects(manager.saveKey('mw3', 'mw3-key-12345'), /damaged.*Reset key storage/);
  assert.equal(await manager.resetKeyStore(), true);
  assert.equal(game(await manager.snapshot(), 'mw3').keyStatus, 'missing');
  const kept = (await fs.readdir(path.dirname(keyFile))).filter(name => name.startsWith('keys.json.corrupt-'));
  assert.equal(kept.length, 1);
  assert.equal(await fs.readFile(path.join(path.dirname(keyFile), kept[0]), 'utf8'), damaged);
  await manager.saveKey('mw3', 'mw3-key-12345');
  assert.equal(game(await manager.snapshot(), 'mw3').keyStatus, 'stored');

  const published = JSON.stringify({ snapshot: await manager.snapshot(), events, settings: manager.data });
  for (const secret of ['fresh-key-abcdef', 'mw3-key-12345', 'previous-profile-key']) assert.equal(published.includes(secret), false);

  const noReset = new ServerManager(settings, () => {}, { detectInstallations: async () => detection() });
  await assert.rejects(noReset.resetKeyStore(), /unavailable/);
}));

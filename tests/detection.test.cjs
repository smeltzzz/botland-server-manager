const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { appIds } = require('../electron/artwork.cjs');
const {
  parseVdf, parseSteamPath, steamLibraries, inspectGameFolder, detectSteamGames, detectGame,
} = require('../electron/detection.cjs');

const mpFiles = {
  cod4: 'iw3mp.exe', waw: 'CoDWaWmp.exe', mw2: 'iw4mp.exe',
  bo1: 'BlackOpsMP.exe', mw3: 'iw5mp.exe', bo2: 't6mp.exe',
};
async function fixture(run) {
  const temp = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(temp, { recursive: true });
  const root = await fs.mkdtemp(path.join(temp, 'botland-detection-'));
  try { await run(root); } finally { await fs.rm(root, { force: true, recursive: true }); }
}
function registry(steamPath) {
  return async args => {
    assert.deepEqual(args, ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath']);
    return `HKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    SteamPath    REG_SZ    ${steamPath}\r\n`;
  };
}
function quoted(value) { return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`; }
async function manifest(library, id, name, appId = appIds[id]) {
  const folder = path.join(library, 'steamapps');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, `appmanifest_${appIds[id]}.acf`),
    `"AppState"\n{\n  "appid" "${appId}"\n  "installdir" ${quoted(name)}\n}\n`);
}
async function game(library, id, name) {
  const folder = path.join(library, 'steamapps', 'common', name);
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, mpFiles[id]), '');
  return folder;
}

test('parses nested KeyValues, comments, escaped slashes and both library layouts', () => {
  const parsed = parseVdf('\uFEFF"libraryfolders" { // comment\n"0" "C:\\\\Steam"\n"1" { "path" "D:\\\\Library" "apps" { "7940" "1" } } }');
  assert.equal(parsed.libraryfolders['0'], 'C:\\Steam');
  assert.equal(parsed.libraryfolders['1'].path, 'D:\\Library');
  assert.equal(parsed.libraryfolders['1'].apps['7940'], '1');
  assert.throws(() => parseVdf('"libraryfolders" { "1" "unterminated'), /Unterminated/);
  assert.throws(() => parseVdf('"libraryfolders" { "1" "a"'), /Unclosed/);
});

// parseSteamPath delegates to safeDirectory, which uses the host's path rules and
// therefore only accepts drive/UNC paths where path.isAbsolute does. The app ships
// for Windows, but keeping this assertion platform-gated lets the suite stay green
// on other hosts instead of reporting a false failure.
const windowsPaths = path.isAbsolute('C:\\Steam');
test('registry SteamPath parsing accepts only absolute local paths', { skip: !windowsPaths && 'Windows path semantics' }, () => {
  assert.equal(parseSteamPath('  SteamPath   REG_SZ   relative\\path\r\n'), '');
  assert.equal(parseSteamPath('  SteamPath   REG_SZ   "C:\\Steam Folder"\r\n'), 'C:\\Steam Folder');
  assert.equal(parseSteamPath('  Other   REG_SZ   C:\\Steam\r\n'), '');
});

test('finds modern Steam libraries and all six games using their artwork app IDs', async () => fixture(async root => {
  const steam = path.join(root, 'Steam');
  const library = path.join(root, 'Second Library');
  const bootstrapper = path.join(root, 'Plutonium', 'bin', 'plutonium-bootstrapper-win32.exe');
  await fs.mkdir(path.join(steam, 'steamapps'), { recursive: true });
  await fs.mkdir(path.dirname(bootstrapper), { recursive: true });
  await fs.mkdir(library, { recursive: true });
  await fs.writeFile(bootstrapper, '');
  const entries = Object.keys(appIds).map(id => `"${appIds[id]}" "1"`).join(' ');
  await fs.writeFile(path.join(steam, 'steamapps', 'libraryfolders.vdf'),
    `"libraryfolders" { "0" { "path" ${quoted(steam)} } "1" { "path" ${quoted(library)} "apps" { ${entries} } } }`);
  const expected = {};
  for (const id of Object.keys(appIds)) {
    const name = `Installed ${id}`;
    expected[id] = await game(library, id, name);
    await manifest(library, id, name);
  }
  await fs.writeFile(path.join(expected.cod4, 'Cod4R-DedRun.exe'), '');
  await fs.writeFile(path.join(expected.mw2, 'iw4x.exe'), '');
  const options = { regQuery: registry(steam), bootstrapperPath: bootstrapper };
  const found = await detectSteamGames(options);
  assert.equal(found.steamPath, steam);
  assert.deepEqual(found.libraries, [steam, library]);
  for (const id of Object.keys(appIds)) {
    assert.equal(found.games[id].gamePath, expected[id]);
    assert.equal(found.games[id].installed, true);
    assert.equal(found.games[id].engineInstalled, true);
    assert.equal(found.games[id].enginePath, ['cod4', 'mw2'].includes(id) ?
      path.join(expected[id], id === 'cod4' ? 'Cod4R-DedRun.exe' : 'iw4x.exe') : bootstrapper);
  }
  assert.deepEqual(await detectGame('cod4', options), found.games.cod4);
}));

test('supports old numbered library paths without apps metadata or a libraryfolders file', async () => fixture(async root => {
  const steam = path.join(root, 'Steam');
  const old = path.join(root, 'Old Library');
  await fs.mkdir(path.join(steam, 'steamapps'), { recursive: true });
  await fs.mkdir(old, { recursive: true });
  const primary = await game(steam, 'waw', 'WaW');
  await manifest(steam, 'waw', 'WaW');
  const secondary = await game(old, 'bo2', 'BO2');
  await manifest(old, 'bo2', 'BO2');
  await fs.writeFile(path.join(steam, 'steamapps', 'libraryfolders.vdf'),
    `"LibraryFolders" { "1" ${quoted(old)} "ContentStatsID" "123" }`);
  const options = { regQuery: registry(steam), bootstrapperPath: path.join(root, 'absent.exe') };
  const found = await detectSteamGames(options);
  assert.deepEqual(found.libraries, [steam, old]);
  assert.equal(found.games.waw.gamePath, primary);
  assert.equal(found.games.bo2.gamePath, secondary);
  assert.equal(found.games.waw.engineInstalled, false);
  assert.equal(found.games.cod4.gamePath, '');
  await fs.rm(path.join(steam, 'steamapps', 'libraryfolders.vdf'));
  assert.deepEqual((await steamLibraries(options)).libraries, [steam]);
}));

test('does not trust app hints, missing or mismatched manifests, unsafe installdir or absent MP files', async () => fixture(async root => {
  const steam = path.join(root, 'Steam');
  await fs.mkdir(path.join(steam, 'steamapps'), { recursive: true });
  await game(steam, 'cod4', 'CoD4');
  const options = { regQuery: registry(steam), bootstrapperPath: path.join(root, 'absent.exe') };
  assert.equal((await detectGame('cod4', options)).installed, false);
  await manifest(steam, 'cod4', 'CoD4', 'wrong-app-id');
  assert.equal((await detectGame('cod4', options)).installed, false);
  await manifest(steam, 'cod4', '../CoD4');
  assert.equal((await detectGame('cod4', options)).installed, false);
  await manifest(steam, 'cod4', 'CoD4');
  assert.equal((await detectGame('cod4', options)).installed, true);
  await fs.rm(path.join(steam, 'steamapps', 'common', 'CoD4', mpFiles.cod4));
  assert.equal((await detectGame('cod4', options)).gamePath, '');
}));

test('ignores malformed or unsafe library paths and handles unavailable registry gracefully', async () => fixture(async root => {
  const steam = path.join(root, 'Steam');
  await fs.mkdir(path.join(steam, 'steamapps'), { recursive: true });
  const options = { regQuery: registry(steam), bootstrapperPath: path.join(root, 'missing.exe') };
  await fs.writeFile(path.join(steam, 'steamapps', 'libraryfolders.vdf'),
    `"libraryfolders" { "1" "../escape" "2" ${quoted(path.join(root, 'missing'))} "3" ${quoted(steam)} }`);
  assert.deepEqual((await steamLibraries(options)).libraries, [steam]);
  await fs.writeFile(path.join(steam, 'steamapps', 'libraryfolders.vdf'), 'invalid VDF');
  assert.deepEqual((await steamLibraries(options)).libraries, [steam]);
  const absent = await detectSteamGames({ regQuery: async () => { throw new Error('Registry unavailable'); }, bootstrapperPath: path.join(root, 'missing.exe') });
  assert.equal(absent.steamPath, '');
  assert.deepEqual(absent.libraries, []);
  assert.equal(absent.games.mw3.installed, false);
}));

test('manual browse fallback checks MP and engine files without requiring a manifest', async () => fixture(async root => {
  const folder = path.join(root, 'Manual Game');
  const bootstrapper = path.join(root, 'Plutonium', 'bin', 'plutonium-bootstrapper-win32.exe');
  await fs.mkdir(folder);
  await fs.mkdir(path.dirname(bootstrapper), { recursive: true });
  await fs.writeFile(bootstrapper, '');
  assert.equal((await inspectGameFolder('mw2', folder)).installed, false);
  await fs.writeFile(path.join(folder, mpFiles.mw2), '');
  const missingEngine = await inspectGameFolder('mw2', folder);
  assert.equal(missingEngine.gamePath, folder);
  assert.equal(missingEngine.engineInstalled, false);
  await fs.writeFile(path.join(folder, 'iw4x.exe'), '');
  assert.equal((await inspectGameFolder('mw2', folder)).engineInstalled, true);
  await fs.writeFile(path.join(folder, mpFiles.bo2), '');
  assert.equal((await inspectGameFolder('bo2', folder, { bootstrapperPath: bootstrapper })).enginePath, bootstrapper);
  assert.deepEqual(await inspectGameFolder('mw2', path.join(root, '..', 'bad')), {
    gamePath: '', installed: false, enginePath: '', engineInstalled: false,
  });
  await assert.rejects(inspectGameFolder('unknown', folder), /Unknown game/);
  await assert.rejects(detectGame('unknown', { regQuery: registry(folder) }), /Unknown game/);
}));

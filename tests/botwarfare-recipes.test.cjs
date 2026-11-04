const test = require('node:test');
const assert = require('node:assert/strict');
const { zipSync } = require('fflate');
const { readModArchive } = require('../electron/mod-archive.cjs');
const { recipeFor } = require('../electron/botwarfare-recipes.cjs');

const cod4Root = 'Add to root of CoD4x server/mods/mp_bots/';
const mw2Root = 'Move files to root of MW2 folder/mods/mp_bots/';
const bo1Root = 'Move to root of Black Ops folder/mods/mp_bots/';
const callbackName = 'maps/mp/gametypes/_callbacksetup.gsx';
const callback = 'CodeCallback_StartGameType()\n{\n}\nCodeCallback_PlayerConnect()\n{\n\tself endon( "disconnect" );\n\t[[level.callbackPlayerConnect]]();\n}\n';
const binary = Buffer.from([0, 1, 128, 255]);

function archive(files) {
  const input = Object.create(null);
  for (const [name, body] of Object.entries(files)) input[name] = Buffer.from(body);
  return readModArchive(Buffer.from(zipSync(input)));
}

function cod4Files(source = callback) {
  return {
    [cod4Root + 'z_svr_bots.iwd']: binary,
    [cod4Root + callbackName]: source,
    [cod4Root + 'scriptdata/waypoints/mp_crash_wp.csv']: '1\n0,0,0',
    [cod4Root + 'scriptdata/waypoints/mp_bog_wp.csv']: '2\n0,0,0',
    [cod4Root + 'server.cfg']: 'untrusted settings',
    [cod4Root + 'launch.bat']: 'never run or copy',
    'Others/patch.bat': 'not part of the mod',
  };
}

function assertPlan(plan, target, storageCode, base, names) {
  assert.equal(plan.target, target);
  assert.equal(plan.storageCode, storageCode);
  assert.equal(plan.base, base);
  assert.deepEqual([...plan.files.keys()], names);
  assert.ok([...plan.files.values()].every(Buffer.isBuffer));
  assert.ok([...plan.files.keys()].every(name => !name.startsWith('/') && !name.includes('\\') && !name.includes('..')));
}

test('stable CoD4 installs only the mod payload, patches callback once and preserves newline style', () => {
  for (const newline of ['\n', '\r\n']) {
    const source = callback.replaceAll('\n', newline);
    const plan = recipeFor('cod4', 'stable', archive(cod4Files(source)));
    assertPlan(plan, 'game', undefined, 'mods/mp_bots', [
      'z_svr_bots.iwd', callbackName,
      'scriptdata/waypoints/mp_crash_wp.csv', 'scriptdata/waypoints/mp_bog_wp.csv',
    ]);
    assert.deepEqual(plan.files.get('z_svr_bots.iwd'), binary);
    assert.deepEqual(plan.patches, ['Cod4R clientid initialization']);
    const patched = plan.files.get(callbackName).toString();
    assert.ok(patched.includes(`\tself endon( "disconnect" );${newline}\t// Cod4R's qol.ff replaces _clientids.gsc`));
    assert.ok(patched.includes(`\tif ( !isDefined( level.clientid ) )${newline}\t\tlevel.clientid = 0;`));
    assert.ok(patched.includes(`\tif ( !isDefined( self.clientid ) )${newline}\t{${newline}\t\tself.clientid = level.clientid;${newline}\t\tlevel.clientid++;${newline}\t}${newline}\t[[level.callbackPlayerConnect]]();`));
    assert.equal(patched.replaceAll(newline, '' ).includes('\n'), false);
    const second = recipeFor('cod4', 'stable', archive(cod4Files(patched)));
    assert.equal(second.files.get(callbackName).toString(), patched);
    assert.deepEqual(second.patches, []);
    assert.equal(source.includes('self.clientid'), false, 'input buffer is not mutated');
  }
});

test('CoD4 fails closed for missing, duplicated, moved or altered callback anchor', () => {
  for (const wrong of [
    callback.replace('self endon( "disconnect" );', 'self endon( "death" );'),
    callback.replace('[[level.callbackPlayerConnect]]();', 'otherCall();'),
    callback + callback,
    callback.replace('CodeCallback_PlayerConnect()', 'CodeCallback_Other()'),
  ]) {
    assert.throws(() => recipeFor('cod4', 'stable', archive(cod4Files(wrong))), /anchor mismatch|body mismatch/u);
  }
  const missing = cod4Files();
  delete missing[cod4Root + callbackName];
  assert.throws(() => recipeFor('cod4', 'stable', archive(missing)), /missing required file/u);
});

test('stable IW4x MW2 uses userraw, not a mods folder, and excludes release launch/config files', () => {
  const plan = recipeFor('mw2', 'stable', archive({
    [mw2Root + 'z_svr_bots.iwd']: binary,
    [mw2Root + 'scriptdata/waypoints/mp_rust_wp.csv']: 'waypoints',
    [mw2Root + 'server.cfg']: 'ignore',
    [mw2Root + 'launch.bat']: 'ignore',
  }));
  assertPlan(plan, 'game', undefined, 'userraw', ['z_svr_bots.iwd', 'scriptdata/waypoints/mp_rust_wp.csv']);
  assert.deepEqual(plan.files.get('z_svr_bots.iwd'), binary);
  assert.deepEqual(plan.patches, []);
});

test('stable Plutonium IW5, T4, T5 and T6 each use a fixed root and exact required files', () => {
  const cases = [
    ['mw3', 'iw5', 'mods/bots', { 'z_svr_bots.iwd': binary, 'server.cfg': 'ignore' }, ['z_svr_bots.iwd']],
    ['waw', 't4', 'mods/mp_bots', { 'mp_bots/z_svr_bots.iwd': binary, 'mp_bots/server.cfg': 'ignore' }, ['z_svr_bots.iwd']],
    ['bo1', 't5', 'mods/mp_bots', {
      [bo1Root + 'description.txt']: 'Bot Warfare', [bo1Root + 'mod.ff']: binary,
      [bo1Root + 'mp_bots.iwd']: binary, 'Others/patch.gsc': 'never copy',
    }, ['description.txt', 'mod.ff', 'mp_bots.iwd']],
    ['bo2', 't6', 'scripts/mp', {
      't6_bot_warfare-cafee7d/scripts/mp/bots.gsc': 'bot',
      't6_bot_warfare-cafee7d/scripts/mp/bots_adapter_pt6.gsc': 'adapter',
      't6_bot_warfare-cafee7d/scripts/mp/other.gsc': 'ignore',
    }, ['bots.gsc', 'bots_adapter_pt6.gsc']],
  ];
  for (const [id, code, base, input, names] of cases) {
    const plan = recipeFor(id, 'stable', archive(input));
    assertPlan(plan, 'plutonium', code, base, names);
    assert.deepEqual(plan.patches, []);
    for (const [name, bytes] of plan.files) assert.ok(bytes.length, `${id}: ${name}`);
    // Every mandatory entry must be present. Non-target extras cannot substitute.
    for (const required of Object.keys(input).filter(name => !name.endsWith('server.cfg') && !name.endsWith('other.gsc') && !name.startsWith('Others/'))) {
      const without = { ...input };
      delete without[required];
      assert.throws(() => recipeFor(id, 'stable', archive(without)), /missing required|layout/u, `${id}: ${required}`);
    }
  }
});

test('stable CoD4 and MW2 reject missing waypoint data and ambiguous BO2 source roots', () => {
  const cod4 = cod4Files();
  delete cod4[cod4Root + 'scriptdata/waypoints/mp_crash_wp.csv'];
  delete cod4[cod4Root + 'scriptdata/waypoints/mp_bog_wp.csv'];
  assert.throws(() => recipeFor('cod4', 'stable', archive(cod4)), /missing required waypoints/u);
  assert.throws(() => recipeFor('mw2', 'stable', archive({ [mw2Root + 'z_svr_bots.iwd']: binary })), /missing required waypoints/u);
  const ambiguous = archive({
    'one/scripts/mp/bots.gsc': 'one', 'one/scripts/mp/bots_adapter_pt6.gsc': 'one',
    'two/scripts/mp/bots.gsc': 'two', 'two/scripts/mp/bots_adapter_pt6.gsc': 'two',
  });
  assert.throws(() => recipeFor('bo2', 'stable', ambiguous), /ambiguous/u);
});

test('development CoD4 builds a source IWD, excludes .gsx and keeps patched callback loose', () => {
  const root = 'iw3_bot_warfare-a1b2c3/';
  const source = archive({
    [root + callbackName]: callback,
    [root + 'maps/mp/bots/_bot.gsc']: 'bot',
    [root + 'maps/mp/bots/waypoints/_custom_map.gsc']: 'custom',
    [root + 'maps/mp/bots/ignore.gsx']: 'not compiled',
    [root + 'scripts/mp/bots.gsc']: 'entrypoint',
    [root + 'scripts/mp/bots_adapter_cod4x.gsc']: 'adapter',
    [root + 'scripts/ignore.gsx']: 'not compiled',
    [root + 'scripts/launch.bat']: 'not bundled',
    [root + 'maps/mp/config.cfg']: 'not bundled',
    [root + 'scriptdata/waypoints/mp_crash_wp.csv']: 'csv',
    [root + 'server.cfg']: 'not installed',
    [root + 'run.bat']: 'not executed',
  });
  const plan = recipeFor('cod4', 'development', source);
  assertPlan(plan, 'game', undefined, 'mods/mp_bots', [
    'z_svr_bots.iwd', callbackName, 'scriptdata/waypoints/mp_crash_wp.csv',
  ]);
  assert.deepEqual([...readModArchive(plan.files.get('z_svr_bots.iwd')).keys()], [
    'maps/mp/bots/_bot.gsc', 'maps/mp/bots/waypoints/_custom_map.gsc',
    'scripts/mp/bots.gsc', 'scripts/mp/bots_adapter_cod4x.gsc',
  ]);
  assert.match(plan.files.get(callbackName).toString(), /self\.clientid = level\.clientid;/u);
  assert.equal(plan.patches.length, 2);
  assert.equal(source.get(root + callbackName).toString(), callback);
  const repeated = recipeFor('cod4', 'development', source);
  assert.deepEqual(repeated.files.get('z_svr_bots.iwd'), plan.files.get('z_svr_bots.iwd'));
});

test('development refuses partial CoD4 source and unsupported release-only layouts', () => {
  const root = 'snapshot/';
  const missing = archive({ [root + callbackName]: callback, [root + 'maps/mp/bots/_bot.gsc']: 'bot', [root + 'scripts/mp/bots.gsc']: 'entrypoint' });
  assert.throws(() => recipeFor('cod4', 'development', missing), /missing required file/u);
  for (const id of ['mw2', 'mw3', 'waw', 'bo1']) {
    assert.throws(() => recipeFor(id, 'development', new Map()), /unsupported/u, id);
  }
  const bo2 = recipeFor('bo2', 'development', archive({
    'snapshot/scripts/mp/bots.gsc': 'bot', 'snapshot/scripts/mp/bots_adapter_pt6.gsc': 'adapter',
  }));
  assertPlan(bo2, 'plutonium', 't6', 'scripts/mp', ['bots.gsc', 'bots_adapter_pt6.gsc']);
  assert.throws(() => recipeFor('cod4', 'development', new Map()), /layout/u);
  assert.throws(() => recipeFor('unknown', 'stable', new Map()), /Unknown Bot Warfare game/u);
  assert.throws(() => recipeFor('mw3', 'nightly', new Map()), /Unknown Bot Warfare channel/u);
  assert.throws(() => recipeFor('mw3', 'stable', {}), TypeError);
});

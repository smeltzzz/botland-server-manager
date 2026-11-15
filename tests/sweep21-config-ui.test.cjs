const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { inspectText, validateValues } = require('../electron/config.cjs');

// Execute the real renderer helpers, not source-text patterns. CSS has no Node
// runtime and React effects are not mounted here; Electron owns DOM/focus smoke.
function rendererModule(relative, dependencies = {}) {
  const filename = path.join(__dirname, '..', relative);
  const javascript = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  const evaluate = vm.runInThisContext(`(function(module, exports, require) {\n${javascript}\n})`, { filename: relative });
  evaluate(loaded, loaded.exports, id => {
    if (Object.hasOwn(dependencies, id)) return dependencies[id];
    if (id.endsWith('.css')) return {};
    return require(id.startsWith('.') ? path.resolve(path.dirname(filename), id) : id);
  });
  return loaded.exports;
}
const i18n = rendererModule('src/i18n/index.ts');
const { configEdits, configNumericLimits, validateConfigEdits, applyConfigValue, reconcileBackupSelection } = rendererModule('src/ConfigWorkspace.tsx', { './i18n': i18n });

function configDocument(text = '', id = 'cod4', target = 'base') {
  return { ...inspectText(text, { id, target, mode: 'dom' }), path: 'synthetic-config.cfg', target, mode: 'dom', sourceRepo: '' };
}
const baseText = 'set sv_hostname "Example"\nset sv_maxclients "18"\nset bots_manage_fill "8"\n';

function errorsFor(key, value, text = baseText, id = 'cod4') {
  return validateConfigEdits(configDocument(text, id), { [key]: value }, id);
}

test('config drafts leave absent defaults, unset values and blank masked inputs alone', () => {
  const document = configDocument(`${baseText}set rcon_password "synthetic-only"\nset custom_directive ""\n`);
  const draft = { ...document.values, rcon_password: '', custom_directive: '', bots_main: '1', bots_main_chat: '1.0' };
  assert.deepEqual(configEdits(document, draft), {});
  assert.deepEqual(validateConfigEdits(document, configEdits(document, draft), 'cod4'), {});
  assert.deepEqual(configEdits(null, draft), {});
  assert.deepEqual(validateConfigEdits(null, { bots_manage_fill: '' }, 'cod4'), {});
  assert.deepEqual(configEdits(document, { ...draft, rcon_password: 'replacement-only' }), { rcon_password: 'replacement-only' });
  assert.deepEqual(validateConfigEdits(document, { rcon_password: '' }, 'cod4'), {});
  assert.deepEqual(validateConfigEdits(document, { custom_directive: '' }, 'cod4'), {}, 'unrecognized directives remain the backend’s responsibility');
  const mode = configDocument('', 'mw3', 'mode');
  const unset = configEdits(mode, { 'commonoption.timelimit': '', 'commonoption.friendlyfire': '' });
  assert.deepEqual(unset, {}, 'absent mode fields without declared defaults stay unset until edited');
  assert.deepEqual(validateConfigEdits(mode, unset, 'mw3'), {});
});

test('numeric inline validation rejects changed blank, non-finite and non-integer values', () => {
  for (const value of ['', ' ', '\t']) assert.match(errorsFor('bots_manage_fill', value).bots_manage_fill, /Enter a number/);
  for (const value of ['NaN', 'Infinity', '-Infinity', '1e999', 'not-a-number']) assert.match(errorsFor('bots_manage_fill', value).bots_manage_fill, /finite number/);
  for (const value of ['1.5', '2.0', '1e1', '0x10', ' 2 ', '123456789']) assert.match(errorsFor('bots_manage_fill', value).bots_manage_fill, /whole number/);
  assert.match(errorsFor('bots_manage_fill', '-1').bots_manage_fill, /at least 0/);
  assert.match(errorsFor('bots_manage_fill', '65').bots_manage_fill, /no more than 64/);
  assert.deepEqual(errorsFor('bots_manage_fill', '0'), {});
  assert.deepEqual(errorsFor('bots_manage_fill', '18'), {});
});

test('decimal controls and validation permit backend-supported precision rather than only tenths', () => {
  const document = configDocument(baseText);
  const field = document.fields.find(item => item.key === 'bots_main_chat');
  assert.equal(configNumericLimits(field, 'cod4').step, 0.0001);
  for (const value of ['0', '0.0001', '0.05', '1.2345', '10.0000']) {
    assert.deepEqual(validateConfigEdits(document, { bots_main_chat: value }, 'cod4'), {}, value);
    assert.doesNotThrow(() => validateValues({ bots_main_chat: value }, { id: 'cod4' }, baseText));
  }
  for (const value of ['1.00001', '1e0', '.5']) assert.match(errorsFor('bots_main_chat', value).bots_main_chat, /four decimal places/);
  assert.match(errorsFor('bots_main_chat', '-0.0001').bots_main_chat, /at least 0/);
  assert.match(errorsFor('bots_main_chat', '10.0001').bots_main_chat, /no more than 10/);
});

test('the schema and title-specific slot caps drive guided limits and inline errors', () => {
  for (const id of ['mw2', 'mw3', 'bo2']) {
    const document = configDocument(baseText, id);
    for (const key of ['sv_maxclients', 'bots_manage_fill']) {
      const field = document.fields.find(item => item.key === key);
      assert.equal(configNumericLimits(field, id).max, 18);
      assert.match(validateConfigEdits(document, { [key]: '19' }, id)[key], /18/);
    }
    assert.deepEqual(validateConfigEdits(document, { sv_maxclients: '18', bots_manage_fill: '18' }, id), {});
  }
  for (const id of ['cod4', 'waw', 'bo1']) {
    const document = configDocument(baseText, id);
    assert.equal(configNumericLimits(document.fields.find(item => item.key === 'sv_maxclients'), id).max, 64);
    assert.deepEqual(validateConfigEdits(document, { sv_maxclients: '64', bots_manage_fill: '64' }, id), {});
  }
});

test('slot/fill and skill relationships attach errors to the affected controls', () => {
  const document = configDocument(baseText);
  for (const patch of [{ bots_manage_fill: '19' }, { sv_maxclients: '7' }]) {
    const errors = validateConfigEdits(document, patch, 'cod4');
    assert.deepEqual(Object.keys(errors).sort(), ['bots_manage_fill', 'sv_maxclients']);
    assert.match(errors.bots_manage_fill, /cannot exceed player slots/);
    assert.equal(errors.sv_maxclients, errors.bots_manage_fill);
    assert.throws(() => validateValues(patch, { id: 'cod4' }, baseText), /Bot target cannot exceed player slots/);
  }
  assert.deepEqual(validateConfigEdits(document, { sv_maxclients: '24', bots_manage_fill: '24' }, 'cod4'), {});
  const skills = validateConfigEdits(document, { bots_skill_min: '6', bots_skill_max: '2' }, 'cod4');
  assert.deepEqual(Object.keys(skills).sort(), ['bots_skill_max', 'bots_skill_min']);
  assert.match(skills.bots_skill_min, /Minimum bot skill/);
  assert.deepEqual(validateConfigEdits(document, { bots_skill_min: '7' }, 'cod4'), {}, 'missing counterpart keeps its schema default');
});

test('unusual untouched values do not prevent unrelated inline edits and missing slot counts retain safe caps', () => {
  const document = configDocument('set sv_hostname "Example"\nset sv_maxclients "unknown"\nset bots_manage_fill "70"\nset bots_skill_min "7"\nset bots_skill_max "1"\n');
  const patch = configEdits(document, { ...document.values, sv_hostname: 'New name' });
  assert.deepEqual(patch, { sv_hostname: 'New name' });
  assert.deepEqual(validateConfigEdits(document, patch, 'cod4'), {}, 'the backend remains authoritative about existing file problems');
  assert.deepEqual(errorsFor('bots_manage_fill', '64', ''), {});
  assert.deepEqual(errorsFor('bots_manage_fill', '18', '', 'mw3'), {});
  assert.match(errorsFor('bots_manage_fill', '19', '', 'mw3').bots_manage_fill, /18/);
});

test('text/select validation respects allowEmpty and does not reject unchanged legacy choices', () => {
  const document = configDocument(`${baseText}set sv_motd "Welcome"\nset bots_team "legacy-choice"\n`);
  assert.deepEqual(validateConfigEdits(document, { sv_motd: '' }, 'cod4'), {});
  assert.match(validateConfigEdits(document, { sv_hostname: '' }, 'cod4').sv_hostname, /cannot be blank/);
  assert.match(validateConfigEdits(document, { sv_hostname: 'x'.repeat(81) }, 'cod4').sv_hostname, /80 characters/);
  assert.deepEqual(configEdits(document, document.values), {});
  assert.match(validateConfigEdits(document, { bots_team: 'new-invalid-choice' }, 'cod4').bots_team, /supported value/);
});

test('mode-file numeric fields use the same schema validation as base config fields', () => {
  const mw3 = configDocument('gameOpt commonOption.timeLimit "10"\n', 'mw3', 'mode');
  assert.match(validateConfigEdits(mw3, { 'commonoption.timelimit': '30.0001' }, 'mw3')['commonoption.timelimit'], /30/);
  assert.deepEqual(validateConfigEdits(mw3, { 'commonoption.timelimit': '1.2345' }, 'mw3'), {});
  const bo2 = configDocument('gts timelimit 10\n', 'bo2', 'mode');
  assert.match(validateConfigEdits(bo2, { timelimit: '1.5' }, 'bo2').timelimit, /whole number/);
  assert.deepEqual(validateConfigEdits(bo2, { timelimit: '0' }, 'bo2'), {});
});

test('both config views share hidden-dependent-field cleanup without mutating the draft', () => {
  const document = configDocument('set bots_team "custom"\nset bots_team_amount "3"\nset bots_skill "8"\n');
  const draft = { ...document.values, bots_team_amount: '9', bots_skill_axis_hard: '4', rcon_password: 'replacement-only' };
  const changedTeam = applyConfigValue(document, draft, 'bots_team', 'allies');
  assert.equal(changedTeam.bots_team_amount, '3', 'existing dependent returns to the file value');
  assert.equal(draft.bots_team_amount, '9', 'previous draft remains untouched');
  const changedSkill = applyConfigValue(document, changedTeam, 'bots_skill', '2');
  assert.equal(Object.hasOwn(changedSkill, 'bots_skill_axis_hard'), false, 'absent dependent must not become a new saved default');
  assert.deepEqual(configEdits(document, changedSkill), { bots_team: 'allies', bots_skill: '2', rcon_password: 'replacement-only' });
});

test('refreshing backup rows keeps only surviving selected IDs after partial deletion', () => {
  const backups = [{ id: 'keep-b', date: '2026-11-14', bytes: 1 }, { id: 'keep-a', date: '2026-11-14', bytes: 2 }, { id: 'new-copy', date: '2026-11-14', bytes: 3 }];
  const selected = ['removed', 'keep-a', 'keep-b', 'keep-a', 'also-removed'];
  assert.deepEqual(reconcileBackupSelection(selected, backups), ['keep-a', 'keep-b']);
  assert.deepEqual(reconcileBackupSelection(selected, []), []);
  assert.deepEqual(selected, ['removed', 'keep-a', 'keep-b', 'keep-a', 'also-removed'], 'selection reconciliation does not mutate the original selection');
});

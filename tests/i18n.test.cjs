const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const ts = require('typescript');
const { collectKeys } = require('../scripts/i18n-keys.cjs');
const { ServerManager } = require('../electron/manager.cjs');

const root = path.join(__dirname, '..');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'src', 'i18n', 'en.json'), 'utf8'));
const locales = JSON.parse(fs.readFileSync(path.join(root, 'src', 'i18n', 'locales.json'), 'utf8'));

const placeholders = value => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();

test('every t()/tp() key used by the renderer exists in the English catalog', () => {
  const { keys, problems } = collectKeys(path.join(root, 'src'));
  assert.deepEqual(problems, [], 'keys must be string literals so extraction stays complete');
  const missing = [...keys.keys()].filter(key => typeof catalog[key] !== 'string' || !catalog[key].trim());
  assert.deepEqual(missing, []);
  assert.ok(keys.size > 500, `expected the extracted UI catalog, found ${keys.size} keys`);
});

test('catalog values keep the placeholders of their source key', () => {
  for (const [key, value] of Object.entries(catalog)) {
    assert.equal(typeof value, 'string');
    assert.ok(value.trim().length > 0, `${key} has an empty translation`);
    assert.deepEqual(placeholders(value), placeholders(key), `${key} lost or renamed a placeholder`);
  }
});

test('locale metadata is complete and pseudo locales stay out of the picker', () => {
  const ids = locales.map(locale => locale.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('en'));
  for (const locale of locales) {
    assert.match(locale.id, /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$|^pseudo(?:-rtl)?$/);
    assert.ok(['ltr', 'rtl'].includes(locale.dir));
    assert.equal(typeof locale.userFacing, 'boolean');
  }
  assert.equal(locales.find(locale => locale.id === 'en').userFacing, true);
  assert.equal(locales.find(locale => locale.id === 'pseudo-rtl').dir, 'rtl');
  assert.equal(locales.find(locale => locale.id === 'pseudo-rtl').userFacing, false);
});

function i18nRuntime() {
  const source = fs.readFileSync(path.join(root, 'src', 'i18n', 'index.ts'), 'utf8');
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  const document = { documentElement: { lang: '', dir: '' } };
  vm.runInNewContext(javascript, {
    module, exports: module.exports, document,
    require(id) {
      if (id === 'react') return require('react');
      if (id === './en.json') return catalog;
      if (id === './locales.json') return locales;
      throw new Error(`Unexpected i18n dependency: ${id}`);
    },
  }, { filename: 'src/i18n/index.ts' });
  return { runtime: module.exports, document };
}

for (const locale of ['pseudo', 'pseudo-rtl']) {
  test(`${locale} preserves interpolation tokens and substitutes supplied values without transforming them`, () => {
    const { runtime, document } = i18nRuntime();
    runtime.setLocale(locale);
    const name = 'Alice É_28962';
    const file = 'C:\\Example\\Game\\main\\sv_hostname.cfg';
    const result = runtime.translate('Hello {name}; {name} saved {count} files at {file}. Keep {unprovided}.', { name, file, count: 12 });
    assert.ok(result.startsWith('⟦Hélló· '), 'literal words are accented and expanded');
    assert.ok(result.endsWith('⟧'));
    assert.equal(result.split(name).length - 1, 2, 'each repeated placeholder is replaced');
    assert.ok(result.includes(file), 'technical path is unchanged');
    assert.ok(result.includes('12'), 'numeric substitution is unchanged');
    assert.deepEqual(placeholders(result), ['unprovided'], 'unprovided tokens remain usable and unmodified');
    assert.equal(runtime.translate('{name}', { name: 'sv_privateclients; ^2User {literal}' }), '⟦sv_privateclients; ^2User {literal}⟧', 'interpolated values are neither expanded nor recursively interpolated');
    assert.equal(runtime.translate('{name} {file} {count}'), '⟦{name} {file} {count}⟧', 'placeholders themselves do not gain expansion dots');
    assert.equal(document.documentElement.dir, locale === 'pseudo-rtl' ? 'rtl' : 'ltr');
    assert.equal(document.documentElement.lang, 'en');
  });

  test(`${locale} plural messages keep substitutions in singular and plural forms`, () => {
    const { runtime } = i18nRuntime();
    runtime.setLocale(locale);
    const one = runtime.tp('Saved {count} change for {name}', 'Saved {count} changes for {name}', 1, { name: 'sv_hostname' });
    const other = runtime.tp('Saved {count} change for {name}', 'Saved {count} changes for {name}', 2, { name: 'sv_hostname' });
    assert.match(one, /1 chángé·+ fór·+ sv_hostname/);
    assert.match(other, /2 chángés·+ fór·+ sv_hostname/);
    assert.deepEqual(placeholders(one), []);
    assert.deepEqual(placeholders(other), []);
  });
}

test('the stylesheet uses logical properties and ships an RTL override layer', () => {
  for (const file of ['styles.css', 'config.css', 'artwork.css']) {
    const css = fs.readFileSync(path.join(root, 'src', file), 'utf8');
    assert.doesNotMatch(css, /text-align:\s*(?:left|right)/, `${file} still uses physical text alignment`);
    assert.doesNotMatch(css, /(?:^|[;{])\s*(?:margin|padding|border)-(?:left|right)\s*:/, `${file} still uses a physical margin, padding or border`);
  }
  assert.match(fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8'), /\[dir=rtl\]/);
});

async function temporary(testContext) {
  const base = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'botland-i18n-'));
  testContext.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the manager persists a locale and rejects unknown tags', async t => {
  const dir = await temporary(t);
  const settings = path.join(dir, 'settings.json');
  const manager = new ServerManager(settings, () => {});
  manager.broadcastState = async () => {};
  await manager.setLocale('pseudo-rtl');
  assert.equal((await manager.snapshot()).locale, 'pseudo-rtl');
  await assert.rejects(manager.setLocale('not a locale'), /Unknown interface language/);
  await assert.rejects(manager.setLocale(''), /Unknown interface language/);
  const reloaded = new ServerManager(settings, () => {});
  reloaded.broadcastState = async () => {};
  await reloaded.initialize();
  assert.equal((await reloaded.snapshot()).locale, 'pseudo-rtl');
});

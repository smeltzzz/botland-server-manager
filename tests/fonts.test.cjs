const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('the UI fonts are small WOFF2 subsets with a Latin unicode range', async () => {
  const css = await fs.readFile(path.join(root, 'src', 'styles.css'), 'utf8');
  for (const weight of [700, 800]) {
    const file = path.join(root, 'src', 'assets', `barlow-condensed-${weight}.woff2`);
    const bytes = await fs.readFile(file);
    assert.equal(bytes.subarray(0, 4).toString('ascii'), 'wOF2', `${weight} is a WOFF2 file`);
    assert.ok(bytes.length < 40_000, `${weight} stays small (${bytes.length} bytes)`);
    assert.match(css, new RegExp(`barlow-condensed-${weight}\\.woff2[^}]*format\\('woff2'\\)`));
    assert.match(css, new RegExp(`barlow-condensed-${weight}\\.woff2[^}]*unicode-range:`));
  }
  assert.doesNotMatch(css, /\.ttf'\)/, 'the shipped CSS does not reference TrueType sources');
});

test('the built CSS references only the WOFF2 files that were emitted', async t => {
  const dist = path.join(root, 'dist', 'assets');
  let files;
  try { files = await fs.readdir(dist); }
  catch { t.skip('Run npm run build first.'); return; }
  const cssName = files.find(name => name.startsWith('index-') && name.endsWith('.css'));
  assert.ok(cssName, 'a built stylesheet exists');
  const css = await fs.readFile(path.join(dist, cssName), 'utf8');
  assert.match(css, /\.woff2/);
  assert.ok(files.some(name => name.endsWith('.woff2')), 'the subset font is emitted as an asset');
  assert.ok(!files.some(name => name.endsWith('.ttf')), 'no full TrueType font is bundled');
  assert.doesNotMatch(css, /data:font/, 'fonts are not inlined as data URLs');
});

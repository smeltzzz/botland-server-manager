// Regenerates src/i18n/en.json from the keys used in the renderer.
// Existing values are kept (English is the source language, so they normally
// equal the key); stale keys are removed. Run: npm run i18n:extract
const fs = require('node:fs');
const path = require('node:path');
const { collectKeys, dynamicKeys } = require('./i18n-keys.cjs');

const root = path.join(__dirname, '..');
const catalogPath = path.join(root, 'src', 'i18n', 'en.json');
const { keys, problems } = collectKeys(path.join(root, 'src'));
if (problems.length) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
} else {
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(catalogPath, 'utf8')); } catch { /* First extraction. */ }
  // Only keys used by application code (plus the documented runtime lookups)
  // stay in the catalog, so translators are never handed dead strings.
  const catalog = {};
  for (const key of [...keys.keys(), ...dynamicKeys]) catalog[key] = existing[key] || key;
  const sorted = Object.fromEntries(Object.keys(catalog).sort((a, b) => a.localeCompare(b)).map(key => [key, catalog[key]]));
  fs.writeFileSync(catalogPath, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`${Object.keys(sorted).length} keys written to src/i18n/en.json`);
}

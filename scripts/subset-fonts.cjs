// Regenerates the WOFF2 subsets in src/assets from the full Barlow Condensed
// TTFs. Run with `npm run fonts:subset` after changing the character set.
//
// Barlow's OFL has no Reserved Font Name, so subsetting is permitted. The
// copyright/license name records are preserved in the output.
const fs = require('node:fs/promises');
const path = require('node:path');
const subsetFont = require('subset-font');

const root = path.join(__dirname, '..');
// Basic Latin, Latin-1 Supplement, Latin Extended-A and the punctuation the
// interface actually uses. Add ranges here before shipping a locale that needs
// more glyphs (for example Greek or Cyrillic), then rerun this script.
const characters = [
  ...Array.from({ length: 0x7f - 0x20 }, (_, index) => 0x20 + index),
  ...Array.from({ length: 0x100 - 0xa0 }, (_, index) => 0xa0 + index),
  ...Array.from({ length: 0x180 - 0x100 }, (_, index) => 0x100 + index),
  0x2013, 0x2014, 0x2018, 0x2019, 0x201a, 0x201c, 0x201d, 0x201e,
  0x2022, 0x2026, 0x2039, 0x203a, 0x2122, 0x2212,
].map(code => String.fromCodePoint(code)).join('');

const weights = [700, 800];

async function main() {
  for (const weight of weights) {
    const source = path.join(root, 'src', 'assets', `barlow-condensed-${weight}.ttf`);
    const target = path.join(root, 'src', 'assets', `barlow-condensed-${weight}.woff2`);
    const full = await fs.readFile(source);
    const subset = await subsetFont(full, characters, {
      targetFormat: 'woff2',
      // Keep copyright, family, version, license description and license URL.
      preserveNameIds: [0, 1, 2, 3, 4, 5, 6, 13, 14],
    });
    await fs.writeFile(target, subset);
    console.log(`${path.basename(target)}: ${(full.length / 1024).toFixed(1)} KB -> ${(subset.length / 1024).toFixed(1)} KB`);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

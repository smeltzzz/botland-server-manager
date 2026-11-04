const fs = require('node:fs/promises');
const path = require('node:path');

// Limit cleanup to known botLANd Windows release files in the output directory.
// Never recurse or delete game files, user settings, or unrelated build output.
const names = ['BotLANd Server Manager', 'botLANd Server Manager'];
const artifact = /^(BotLANd Server Manager|botLANd Server Manager) (?:Setup )?(\d+\.\d+\.\d+(?:-[\w.-]+)?)\.exe(?:\.blockmap)?$/;

async function pruneRelease(releaseDir, version, productName) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) || !names.includes(productName)) {
    throw new Error('Unexpected package name or version; release cleanup cancelled.');
  }
  const expected = [
    `${productName} Setup ${version}.exe`,
    `${productName} ${version}.exe`,
  ];
  // A failed or partial package build must not remove the previous working release.
  for (const name of expected) {
    const entry = await fs.stat(path.join(releaseDir, name));
    if (!entry.isFile() || entry.size === 0) throw new Error(`Missing completed release: ${name}`);
  }

  const removed = [];
  for (const entry of await fs.readdir(releaseDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = artifact.exec(entry.name);
    // Windows file names are case-insensitive: rebuilding a version keeps an
    // existing file's original capitalization, which must not be deleted.
    const sameName = process.platform === 'win32' ? match?.[1].toLowerCase() === productName.toLowerCase() : match?.[1] === productName;
    if (!match || (sameName && match[2] === version)) continue;
    await fs.unlink(path.join(releaseDir, entry.name));
    removed.push(entry.name);
  }
  return removed;
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const pkg = require(path.join(root, 'package.json'));
  pruneRelease(path.join(root, 'release'), pkg.version, pkg.build.productName)
    .then(removed => console.log(removed.length ? `Removed old botLANd release files:\n${removed.map(name => `  ${name}`).join('\n')}` : 'No old botLANd release files to remove.'))
    .catch(error => { console.error(`Release cleanup cancelled: ${error.message}`); process.exitCode = 1; });
}

module.exports = { pruneRelease };

const fs = require('node:fs/promises');
const path = require('node:path');
const { profileFor } = require('./profiles.cjs');

// Images are loaded from the user's own Steam cache, never shipped with the app.
const appIds = { cod4: '7940', waw: '10090', mw2: '10180', bo1: '42700', mw3: '42690', bo2: '202970' };
const fileNames = { hero: 'library_hero.jpg', cover: 'library_600x900.jpg' };
function cacheRoots(extraRoots = []) {
  return [...new Set([
    ...extraRoots.filter(root => typeof root === 'string' && root),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Steam', 'appcache', 'librarycache'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Steam', 'appcache', 'librarycache'),
    'C:\\Program Files (x86)\\Steam\\appcache\\librarycache',
  ].filter(Boolean))];
}
/** @param {Buffer} buffer @returns {'image/jpeg'|'image/png'|'image/webp'|null} */
function mimeFor(buffer) {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
async function loadImage(file) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 6_000_000 || stat.size < 12) return null;
    const bytes = await fs.readFile(file);
    const mime = mimeFor(bytes);
    return mime ? `data:${mime};base64,${bytes.toString('base64')}` : null;
  } catch { return null; }
}
async function artworkFor(id, kind, override, extraRoots = []) {
  profileFor(id);
  if (!Object.hasOwn(fileNames, kind)) throw new Error('Unknown artwork type.');
  if (typeof override === 'string') {
    const image = await loadImage(override);
    if (image) return image;
  }
  for (const root of cacheRoots(extraRoots)) {
    const folder = path.join(root, appIds[id]);
    const image = await loadImage(path.join(folder, fileNames[kind]));
    if (image) return image;
    // Newer Steam clients keep each image in a hashed subfolder of the app folder.
    let entries = [];
    try { entries = await fs.readdir(folder, { withFileTypes: true }); } catch { /* No cache for this app. */ }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const nested = await loadImage(path.join(folder, entry.name, fileNames[kind]));
      if (nested) return nested;
    }
  }
  return null;
}
module.exports = { artworkFor, loadImage, mimeFor, cacheRoots, appIds };

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { profileFor } = require('./profiles.cjs');

/**
 * A deliberately small, non-secret starting point. Eighteen slots (the IW5
 * maximum) and eight bots leave room for human players; users can tune both
 * in the normal config editor. BO1 uses its native difficulty, and T6 uses
 * its separate 0–3 bot scale. Mode rules belong to existing mode files.
 * @param {string} id
 * @returns {string}
 */
function starterText(id) {
  const profile = profileFor(id);
  const lines = [
    '// botLANd starter config; review settings before hosting.',
    `set sv_hostname "botLANd ${profile.short} Server"`,
    'set sv_maxclients "18"',
    'set bots_main "1"',
    'set bots_manage_fill "8"',
  ];
  if (id === 'bo1') lines.push('set bot_difficulty "normal"');
  else lines.push(`set bots_skill "${id === 'bo2' ? '1' : '3'}"`);
  if (['cod4', 'waw', 'mw2', 'mw3'].includes(id)) lines.push('set bots_main_firstIsHost "0"');
  if (id === 'mw3') lines.push(`set fs_game "${profile.mod}"`);
  if (id === 'mw3' || id === 'bo2') lines.push(`exec ${path.basename(profile.rotation)}`);
  return lines.join('\r\n') + '\r\n';
}

/**
 * Create only the missing base config in an existing game folder. An existing
 * file, including one created by a concurrent call, raises EEXIST; it is never
 * read, updated, or replaced. This does not create rotations or mode files.
 * @param {string} id
 * @param {string} gamePath
 * @returns {Promise<string>} Absolute path of the newly created config.
 */
async function createStarterConfig(id, gamePath) {
  const profile = profileFor(id);
  if (typeof gamePath !== 'string' || !gamePath.trim() || !path.isAbsolute(gamePath)) throw new Error('Select an installed game folder first.');
  const root = path.resolve(gamePath);
  let stat;
  try { stat = await fs.stat(root); }
  catch (error) { if (error.code === 'ENOENT') throw new Error('Select an installed game folder first.'); throw error; }
  if (!stat.isDirectory()) throw new Error('Select an installed game folder first.');
  const file = path.join(root, profile.config);
  const parent = path.dirname(file);
  await fs.mkdir(parent, { recursive: true });
  // Do not follow a pre-existing config-directory symlink outside the game
  // folder. Resolving the root also permits a deliberately selected symlinked
  // game folder without writing elsewhere relative to that selection.
  const [realRoot, realParent] = await Promise.all([fs.realpath(root), fs.realpath(parent)]);
  const relative = path.relative(realRoot, realParent);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Config directory is outside the selected game folder.');
  // Publish complete bytes with an exclusive hard link: rename on Windows could
  // replace an existing config. A failed stage/link leaves no partial config.
  const staged = path.join(parent, `.botland-starter-${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(staged, 'wx', 0o600);
    await handle.writeFile(starterText(id), 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await fs.link(staged, file);
    } catch (error) {
      // Some game libraries sit on exFAT/FAT, which cannot create hard links.
      // Fall back to an exclusive copy; EACCES still means a real permissions
      // failure and must not be treated as a filesystem limitation.
      if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EINVAL'].includes(error?.code)) throw error;
      try {
        await fs.copyFile(staged, file, fs.constants.COPYFILE_EXCL);
      } catch (copyError) {
        // COPYFILE_EXCL never replaces an existing file; remove only a partial
        // copy this call created, never a config that was already there.
        if (copyError?.code !== 'EEXIST') await fs.rm(file, { force: true }).catch(() => {});
        throw copyError;
      }
    }
    return file;
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(staged, { force: true }).catch(() => {});
  }
}

module.exports = { createStarterConfig, starterText };

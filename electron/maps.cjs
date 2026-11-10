const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { withoutBlockComments, decode } = require('./config.cjs');

const safeName = /^[a-z0-9_]+$/i;
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function filesUnder(root, recursive = false, depth = 0) {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return []; }
  const result = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && /^(?:mp_|co_|oilrig).*\.ff$/i.test(entry.name)) result.push({ root, name: entry.name.slice(0, -3).toLowerCase() });
    if (recursive && depth < 5 && entry.isDirectory() && !entry.isSymbolicLink()) result.push(...await filesUnder(full, true, depth + 1));
  }
  return result;
}
async function customMaps(root) {
  let dirs;
  try { dirs = await fs.readdir(root, { withFileTypes: true }); } catch { return []; }
  const names = [];
  for (const dir of dirs) if ((dir.isDirectory() || dir.isSymbolicLink()) && safeName.test(dir.name) && await exists(path.join(root, dir.name, `${dir.name}.ff`))) names.push(dir.name.toLowerCase());
  return names;
}
function storage(code) { return path.join(process.env.LOCALAPPDATA || '', 'Plutonium', 'storage', code); }
async function scanMaps(profile, gamePath) {
  const g = (...parts) => path.join(gamePath, ...parts);
  const s = (code, ...parts) => path.join(storage(code), ...parts);
  let names = [];
  if (profile.id === 'cod4' || profile.id === 'waw') {
    const roots = profile.id === 'cod4' ? [g('zone', 'english'), g('zone')] : [g('zone'), s('t4', 'zone')];
    const zone = (await Promise.all(roots.map(r => filesUnder(r, profile.id === 'waw')))).flat();
    const files = new Set(zone.map(f => f.name));
    names = zone.filter(f => f.name.startsWith('mp_') && !f.name.endsWith('_load') && files.has(`${f.name}_load`)).map(f => f.name);
    const userRoots = profile.id === 'cod4' ? [g('usermaps')] : [g('usermaps'), s('t4', 'usermaps')];
    names.push(...(await Promise.all(userRoots.map(customMaps))).flat());
  } else if (profile.id === 'mw2') {
    const roots = [g('zone', 'english'), g('zone', 'dlc'), g('zone', 'iw4x', 'x86', 'english'), g('zone', 'iw4x', 'x86', 'dlc')];
    const files = (await Promise.all([...roots, g('zone', 'iw4x', 'x86', 'patch')].map(r => filesUnder(r)))).flat();
    const base = new Set(files.filter(f => !f.root.endsWith('patch')).map(f => f.name));
    names = files.filter(f => f.name.endsWith('_load')).map(f => f.name.slice(0, -5)).filter(n => /^(mp_|co_|oilrig$)/.test(n) && base.has(n));
    names.push(...await customMaps(g('usermaps')));
  } else if (profile.id === 'bo1' || profile.id === 'bo2') {
    const code = profile.id === 'bo1' ? 't5' : 't6';
    const zone = (await Promise.all([g('zone'), s(code, 'zone')].map(r => filesUnder(r, true)))).flat();
    names = zone.map(f => f.name).filter(n => n.startsWith('mp_') && !/_(load|patch)$/.test(n) && n !== 'mp_frontend');
  } else if (profile.id === 'mw3') {
    const roots = [g('zone', 'english'), g('zone', 'dlc'), s('iw5', 'zone')];
    const zone = (await Promise.all(roots.map(r => filesUnder(r)))).flat();
    const byRoot = new Set(zone.map(f => `${f.root}:${f.name}`));
    names = zone.filter(f => f.name.startsWith('mp_') && f.name.endsWith('_load') && byRoot.has(`${f.root}:${f.name.slice(0, -5)}`)).map(f => f.name.slice(0, -5));
  }
  return [...new Set(names.filter(n => safeName.test(n)))].sort((a, b) => a.localeCompare(b));
}
async function modeOptions(profile, gamePath) {
  if (profile.modeType === 'gametype') {
    return profile.id === 'cod4' || profile.id === 'mw2'
      ? [{ value: 'dom', label: 'Domination' }, { value: 'war', label: 'Team Deathmatch' }, { value: 'dm', label: 'Free for All' }, { value: 'sd', label: 'Search & Destroy' }]
      : [{ value: 'dom', label: 'Domination' }, { value: 'tdm', label: 'Team Deathmatch' }, { value: 'dm', label: 'Free for All' }, { value: 'sd', label: 'Search & Destroy' }];
  }
  const folder = profile.id === 'mw3' ? path.join(gamePath, 'admin') : path.join(gamePath, 'main', 'gamesettings');
  const extension = profile.id === 'mw3' ? '.dsr' : '.cfg';
  let entries = [];
  try { entries = await fs.readdir(folder); } catch { /* Folder not installed. */ }
  let candidates = entries.filter(n => n.toLowerCase().endsWith(extension) && safeName.test(n.slice(0, -extension.length)));
  if (profile.id === 'bo2') {
    // This folder also contains Zombies settings. Only multiplayer files that
    // explicitly select their own gametype are valid for a t6mp rotation.
    const verified = await Promise.all(candidates.map(async name => {
      try {
        // Decode like the config editor, so UTF-16 mode files are not silently dropped.
        const text = withoutBlockComments(decode(await fs.readFile(path.join(folder, name))).text);
        const declarations = text.split(/\r?\n/).map(line => line.split('//', 1)[0].trim().match(/^set_gametype\s+([a-z0-9_]+)\b/i)).filter(Boolean);
        const declaration = declarations.at(-1);
        return declaration?.[1].toLowerCase() === name.slice(0, -extension.length).toLowerCase() ? name : null;
      } catch { return null; }
    }));
    candidates = verified.filter(Boolean);
  }
  return candidates.map(n => ({ value: n.slice(0, -extension.length), label: n.slice(0, -extension.length).replace(/_default$/i, '').toUpperCase() }));
}
function shuffle(names) {
  const copy = [...names];
  for (let i = copy.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [copy[i], copy[j]] = [copy[j], copy[i]]; }
  return copy;
}
/** @param {import('./profiles.cjs').GameProfile} profile @param {string[]} maps @param {string} mode @param {boolean} randomize @returns {string} */
function rotationText(profile, maps, mode, randomize) {
  if (!maps.length || maps.some(m => !safeName.test(m))) throw new Error('Choose at least one valid map.');
  if (!safeName.test(mode)) throw new Error('Invalid game mode.');
  if (profile.id === 'bo2' && maps.length < 2) throw new Error('Black Ops II needs at least two maps.');
  const ordered = randomize ? shuffle(maps) : maps;
  let rotation;
  if (profile.id === 'mw3') rotation = `dsr ${mode} ${ordered.map(m => `map ${m}`).join(' ')}`;
  else if (profile.id === 'bo2') rotation = `execgts ${mode}.cfg ${ordered.map(m => `map ${m}`).join(' ')}`;
  else if (profile.id === 'mw2') rotation = ordered.map(m => `map ${m}`).join(' ');
  else rotation = ordered.map(m => `gametype ${mode} map ${m}`).join(' ');
  const variable = profile.id === 'cod4' || profile.id === 'waw' ? 'sv_mapRotation' : 'sv_maprotation';
  const command = profile.id === 'bo2' ? `${variable} "${rotation}"` : `set ${variable} "${rotation}"`;
  return `// Generated by botLANd Server Manager; changes here will be replaced on next start.\r\n${command}\r\n${['cod4', 'waw', 'mw2'].includes(profile.id) ? `set ${variable}Current ""\r\n` : ''}`;
}
async function writeRotation(file, contents) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try { await fs.writeFile(temp, contents, 'ascii'); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}
module.exports = { scanMaps, modeOptions, rotationText, writeRotation, shuffle };

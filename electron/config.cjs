const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { schemaFor, fieldFor } = require('./schema.cjs');
const { withConfigLock } = require('./config-backups.cjs');

/** @typedef {{id?: string, target?: 'base'|'mode', mode?: string, token?: string}} ConfigOptions */
const legacyKeys = new Set(['sv_hostname', 'sv_maxclients', 'bots_manage_fill', 'bots_skill', 'bot_difficulty', 'bots_main', 'bots_play_obj', 'bots_manage_fill_mode', 'bots_team', 'scr_dom_timelimit', 'scr_dom_scorelimit']);
// Plutonium accepts its server key as a plain `key` dvar, so bare and suffixed
// key names are secret too; GUID lists may be singular (e.g. sv_adminguid).
const secretName = /(?:password|passwd|secret|token|api.?key|server.?key|licen[cs]e.?key|(?:^|[_.])key$|rcon|guid|auth)/i;
const safeKey = /^[a-z_][a-z0-9_.]*$/i;
function isSecret(key) { return secretName.test(key); }
function decode(buffer) {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) return { text: buffer.subarray(3).toString('utf8'), encoding: 'utf8', bom: true };
  for (const [bom, encoding] of [[[0xff, 0xfe], 'utf16le'], [[0xfe, 0xff], 'utf16be']]) {
    if (!buffer.subarray(0, 2).equals(Buffer.from(bom))) continue;
    try { return { text: new TextDecoder(encoding === 'utf16le' ? 'utf-16le' : 'utf-16be', { fatal: true }).decode(buffer.subarray(2)), encoding, bom: true }; }
    catch { throw new Error('This config file starts with a UTF-16 marker but is not valid UTF-16 text. Re-save it in a text editor as UTF-8 or UTF-16.'); }
  }
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), encoding: 'utf8', bom: false }; }
  catch { return { text: buffer.toString('latin1'), encoding: 'latin1', bom: false }; }
}
function encode(text, original) {
  if (original.encoding === 'utf16le' || original.encoding === 'utf16be') {
    let bytes = Buffer.from(text, 'utf16le');
    if (original.encoding === 'utf16be') bytes = bytes.swap16();
    const bom = original.bom ? Buffer.from(original.encoding === 'utf16le' ? [0xff, 0xfe] : [0xfe, 0xff]) : Buffer.alloc(0);
    return Buffer.concat([bom, bytes]);
  }
  const bytes = Buffer.from(text, original.encoding);
  return original.bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]) : bytes;
}
function assignment(line, dialect = 'dvar') {
  if (/^\s*(?:\/\/|#|;)/.test(line)) return null;
  const pattern = dialect === 'gameOpt' ? /^(\s*gameOpt\s+)([a-z][a-z0-9_.]*)(\s+)(.*)$/i
    : dialect === 'gts' ? /^(\s*gts\s+)([a-z][a-z0-9_]*)(\s+)(.*)$/i
      // Some configs (e.g. IW4x's `set _Admin ""`) keep placeholder dvars with a leading underscore.
      : /^(\s*(?:(?:set|seta|sets|setu)\s+)?)([a-z_][a-z0-9_]*)(\s+)(.*)$/i;
  const match = line.match(pattern);
  if (!match) return null;
  if (dialect === 'dvar' && !/^\s*set(?:a|s|u)?\s+/i.test(line) && !/^(?:bots?_|sv_|scr_|g_)/i.test(match[2])) return null;
  const rest = match[4].trim();
  let value; let suffix;
  if (rest.startsWith('"')) {
    const closing = rest.indexOf('"', 1);
    if (closing < 0) return null;
    value = rest.slice(1, closing);
    suffix = rest.slice(closing + 1);
  } else {
    const comment = match[4].search(/\s+\/\//);
    value = (comment < 0 ? match[4] : match[4].slice(0, comment)).trim();
    suffix = comment < 0 ? '' : match[4].slice(comment);
  }
  return { key: match[2].toLowerCase(), sourceKey: match[2], value, prefix: match[1] + match[2] + match[3], suffix };
}
function withoutBlockComments(text) {
  return text.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, comment => comment.replace(/[^\r\n]/g, ' '));
}
function parseEntries(text, dialect = 'dvar') {
  const entries = new Map();
  withoutBlockComments(text).split(/\r?\n/).forEach((line, lineIndex) => {
    const item = assignment(line, dialect);
    if (!item) return;
    const old = entries.get(item.key);
    entries.set(item.key, { ...item, lineIndex, count: (old?.count || 0) + 1 });
  });
  return entries;
}
function dialectFor(opts = {}) { return opts.target === 'mode' ? (opts.id === 'mw3' ? 'gameOpt' : 'gts') : 'dvar'; }
function parseConfig(text, opts = {}) {
  const dialect = dialectFor(opts);
  const allowed = opts.id ? new Set(schemaFor(opts.id, opts.target || 'base', opts.mode).fields.map(field => field.key)) : legacyKeys;
  const result = {};
  for (const [key, item] of parseEntries(text, dialect)) if (allowed.has(key) && !isSecret(key)) result[key] = item.value;
  return result;
}
function validateOne(value, field, key) {
  if (typeof value !== 'string' || value.length > 512 || /[";\r\n\x00-\x1f]/.test(value)) throw new Error(`Invalid value for ${key}. Quotes, semicolons and line breaks are not permitted.`);
  // A block-comment marker would hide every following line from the parser.
  if (/\/\*|\*\//.test(value)) throw new Error(`Invalid value for ${key}. Comment markers (/* or */) are not permitted.`);
  if (!field) return value;
  if (field.type === 'select') {
    if (!field.choices.some(choice => choice.value === value)) throw new Error(`Invalid ${field.label.toLowerCase()}.`);
  } else if (field.type === 'integer') {
    if (!/^-?\d{1,8}$/.test(value) || Number(value) < field.min || Number(value) > field.max) throw new Error(`${field.label} must be between ${field.min} and ${field.max}.`);
  } else if (field.type === 'decimal') {
    if (!/^-?\d{1,6}(?:\.\d{1,4})?$/.test(value) || Number(value) < field.min || Number(value) > field.max) throw new Error(`${field.label} must be between ${field.min} and ${field.max}.`);
  } else if (field.type === 'text') {
    if ((!value.trim() && !isSecret(key) && !field.allowEmpty) || value.length > (field.maxLength || 256)) throw new Error(`${field.label} must be 1–${field.maxLength || 256} characters.`);
  }
  return value;
}
function validateValues(values, opts = {}, text = '') {
  if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length > 100) throw new Error('Invalid settings.');
  const dialect = dialectFor(opts);
  const existing = parseEntries(text, dialect);
  const cleaned = {};
  for (const [rawKey, value] of Object.entries(values)) {
    const key = rawKey.toLowerCase();
    if (!safeKey.test(key) || Object.hasOwn(cleaned, key)) throw new Error(`Invalid setting: ${rawKey}`);
    if (opts.id && key === 'bots_manage_add') throw new Error('bots_manage_add is a one-shot runtime action, not a persistent config setting.');
    const field = opts.id ? fieldFor(opts.id, opts.target || 'base', key, opts.mode) : (legacyKeys.has(key) ? ['cod4', 'bo1', 'bo2'].map(id => fieldFor(id, 'base', key, 'dom')).find(Boolean) : null);
    if (!opts.id && !field) throw new Error(`Invalid setting: ${rawKey}`);
    if (opts.id && !field && !existing.has(key)) throw new Error(`Setting ${rawKey} does not exist in this config.`);
    if (field?.presentOnly && !existing.has(key)) throw new Error(`${field.label} is not available in this config.`);
    cleaned[key] = validateOne(value, field, key);
  }
  const current = Object.fromEntries([...existing].map(([key, entry]) => [key, entry.value]));
  const slotCap = ['mw2', 'mw3', 'bo2'].includes(opts.id) ? 18 : 64;
  // A missing or non-numeric slot count must not disable the check (NaN compares false).
  const rawSlots = cleaned.sv_maxclients ?? current.sv_maxclients ?? '';
  const slots = /^\s*\d+\s*$/.test(rawSlots) ? Math.min(Number(rawSlots), slotCap) : slotCap;
  if ('bots_manage_fill' in cleaned && +(cleaned.bots_manage_fill) > slots) throw new Error('Bot target cannot exceed player slots.');
  if ('sv_maxclients' in cleaned && +(cleaned.bots_manage_fill ?? current.bots_manage_fill ?? 0) > +cleaned.sv_maxclients) throw new Error('Bot target cannot exceed player slots.');
  if (slotCap === 18 && +cleaned.sv_maxclients > 18) {
    const name = { mw2: 'Modern Warfare 2', mw3: 'Modern Warfare 3', bo2: 'Black Ops II' }[opts.id];
    throw new Error(`${name} supports at most 18 player slots.`);
  }
  const min = +(cleaned.bots_skill_min ?? current.bots_skill_min ?? 1);
  const max = +(cleaned.bots_skill_max ?? current.bots_skill_max ?? 7);
  if (min > max) throw new Error('Minimum bot skill cannot exceed maximum bot skill.');
  return cleaned;
}
function updateConfigText(text, values, opts = {}) {
  const patch = validateValues(values, opts, text);
  const ending = text.includes('\r\n') ? '\r\n' : '\n';
  // Keep each original separator so edits do not normalize unrelated lines.
  const lines = text.split(/(\r\n|\n)/);
  const activeLines = withoutBlockComments(text).split(/(\r\n|\n)/);
  const dialect = dialectFor(opts);
  for (const [key, value] of Object.entries(patch)) {
    let last = -1;
    for (let i = 0; i < activeLines.length; i += 2) if (assignment(activeLines[i], dialect)?.key === key && assignment(lines[i], dialect)) last = i;
    if (last === -1) {
      const sourceKey = (opts.id && fieldFor(opts.id, opts.target || 'base', key, opts.mode)?.sourceKey) || key;
      const prefix = dialect === 'dvar' ? 'set ' : dialect === 'gameOpt' ? 'gameOpt ' : 'gts ';
      const added = `${prefix}${sourceKey} "${value}"`;
      // An empty file gets the line itself, not a leading blank line.
      if (text.endsWith('\n') || text === '') {
        lines[lines.length - 1] = added;
        lines.push(ending, '');
      } else lines.push(ending, added);
    } else {
      const item = assignment(lines[last], dialect);
      lines[last] = `${item.prefix}"${value}"${item.suffix}`;
    }
  }
  const updated = lines.join('');
  // Block comments (e.g. an unterminated /*) can hide the edited line from the
  // game, so a save would report success without taking effect. Refuse instead.
  const result = parseEntries(updated, dialect);
  for (const [key, value] of Object.entries(patch)) {
    if (result.get(key)?.value !== value) throw new Error(`Could not safely update ${key}: a /* block comment in the config would hide the change. Fix the comment in the original file first.`);
  }
  return updated;
}
// Latin-1 files cannot store characters above U+00FF; refuse rather than corrupt them.
function assertEncodable(patch, decoded) {
  if (decoded.encoding !== 'latin1') return;
  for (const [key, value] of Object.entries(patch)) {
    if (/[^\x00-\xff]/.test(value)) throw new Error(`Invalid value for ${key}. This config file only supports Western (Latin-1) characters.`);
  }
}
function hash(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
// The review token covers the target path, the file bytes and the
// validated values, so a commit can only write exactly what was previewed
// against the previewed file (two byte-identical mode files differ by path).
function pathKey(file) {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
function reviewToken(original, patch, file) {
  const values = Object.entries(patch).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return crypto.createHash('sha256').update(pathKey(file)).update('\0').update(hash(original)).update('\0').update(JSON.stringify(values)).digest('hex');
}
function inspectText(text, opts = {}) {
  const dialect = dialectFor(opts);
  const items = parseEntries(text, dialect);
  const values = parseConfig(text, opts);
  const entries = [...items.values()].map(entry => ({ key: entry.key, value: isSecret(entry.key) ? '' : entry.value, hasValue: !!entry.value, masked: isSecret(entry.key), count: entry.count }));
  return { values, entries, fields: schemaFor(opts.id, opts.target || 'base', opts.mode).fields };
}
async function readConfig(file, opts = {}) { return parseConfig(decode(await fs.readFile(file)).text, opts); }
async function readDocument(file, opts) { return inspectText(decode(await fs.readFile(file)).text, opts); }
/** @param {string} file @param {Record<string, string>} values @param {ConfigOptions} [opts] */
async function previewConfig(file, values, opts = {}) {
  const original = await fs.readFile(file);
  const decoded = decode(original);
  const text = decoded.text;
  const entries = parseEntries(text, dialectFor(opts));
  const patch = validateValues(values, opts, text);
  assertEncodable(patch, decoded);
  const updated = updateConfigText(text, patch, opts);
  const changes = Object.entries(patch).filter(([key, value]) => entries.get(key)?.value !== value).map(([key, after]) => ({
    key, label: (opts.id && fieldFor(opts.id, opts.target || 'base', key, opts.mode)?.label) || key,
    before: isSecret(key) ? '••••••' : (entries.get(key)?.value ?? '(not set)'),
    after: isSecret(key) ? '••••••' : after,
    duplicates: entries.get(key)?.count || 0,
  }));
  return { token: reviewToken(original, patch, file), changes, changed: updated !== text };
}
/** @param {string} file @param {Record<string, string>} values @param {ConfigOptions} [opts] */
async function saveConfig(file, values, opts = {}) {
  // Saves share the backup module's per-file queue, so a save and a backup
  // restore of the same config can never interleave their check-then-rename.
  return withConfigLock(file, async () => {
    const link = await fs.lstat(file);
    // Replacing a symlink or hard link by rename would silently detach it, and
    // the backups panel refuses such files; refuse consistently up front.
    if (link.isSymbolicLink() || link.nlink > 1) throw new Error(`${path.basename(file)} is a symbolic or hard link. Replace it with a regular file before editing it here.`);
    const original = await fs.readFile(file);
    const decoded = decode(original);
    const patch = validateValues(values, opts, decoded.text);
    assertEncodable(patch, decoded);
    if (opts.token && opts.token !== reviewToken(original, patch, file)) throw new Error('Config or settings changed since preview. Refresh and review your edits again.');
    const updated = updateConfigText(decoded.text, patch, opts);
    if (updated === decoded.text) return;
    const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`;
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
    let replaced = false;
    try {
      await fs.writeFile(backup, original, { flag: 'wx' });
      await fs.writeFile(temp, encode(updated, decoded), { flag: 'wx' });
      // Recheck after the awaited writes so an editor change is not silently replaced.
      if (!(await fs.readFile(file)).equals(original)) throw new Error('Config changed since preview. Refresh and review your edits again.');
      await fs.rename(temp, file);
      replaced = true;
    } catch (error) {
      if (['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw new Error(`Could not write ${path.basename(file)}. It is read-only or in use by another program. Close the program or clear the read-only flag, then try again.`);
      throw error;
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
      // A backup of a file that was never replaced is only clutter.
      if (!replaced) await fs.rm(backup, { force: true }).catch(() => {});
    }
  });
}
function parseLauncher(text) {
  const variables = {};
  for (const line of text.split(/\r?\n/)) {
    // Accept the common batch forms: set "KEY=VALUE", set KEY=VALUE,
    // set KEY = VALUE and set KEY="VALUE". Values may contain '='.
    const match = line.match(/^\s*set\s+(.+?)\s*$/i);
    if (!match) continue;
    let body = match[1];
    if (body.length >= 2 && body.startsWith('"') && body.endsWith('"') && body.indexOf('"', 1) === body.length - 1) {
      body = body.slice(1, -1);
    }
    const equals = body.indexOf('=');
    if (equals <= 0) continue;
    const key = body.slice(0, equals).trim();
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) continue;
    let value = body.slice(equals + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    variables[key.toLowerCase()] = value;
  }
  return variables;
}
module.exports = { decode, withoutBlockComments, parseConfig, parseEntries, inspectText, isSecret, validateValues, updateConfigText, readConfig, readDocument, previewConfig, saveConfig, parseLauncher };

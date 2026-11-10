const fs = require('node:fs/promises');
const path = require('node:path');

// Public upstream identifiers only. Nothing from game installs, settings or keys is sent.
const SOURCES = Object.freeze({
  cod4: { repo: 'iw3_bot_warfare', tag: 'v2.2.0', asset: 'iw3bw220.zip', prefix: 'iw3bw', sha256: '7b4a65add11b63dd53cad57a51f32efeb48141e314506543909e813f290796ba' },
  waw: { repo: 't4_bot_warfare', tag: 'v2.3.0', asset: 't4bw230.zip', prefix: 't4bw', sha256: '266a183f6557f58c14808ef455ba009e5d763295f47695731978b88aa45c2d21' },
  mw2: { repo: 'iw4_bot_warfare', tag: 'v2.3.0', asset: 'iw4bw230.zip', prefix: 'iw4bw', sha256: '6ac8708893ac18d2f3fd96d49d95d6135449a50a409811172ef2b38fa94edadc' },
  bo1: { repo: 't5_bot_warfare', tag: 'v1.1.1', asset: 'bo1bw111.zip', prefix: 'bo1bw', sha256: '0bef68a979fc560efe9b2cad5361f6e23962120cfbf57d09fe2f7efdff1dc3c3' },
  mw3: { repo: 'iw5_bot_warfare', tag: 'v2.3.0', asset: 'iw5bw230.zip', prefix: 'iw5bw', sha256: '733692aaeda839635d86f9752803b04ecfbd0057f9475661b8cadf084543cfaa' },
  bo2: { repo: 't6_bot_warfare', commit: 'cafee7d585160b046dc928f90798a611683e6cd1', sha256: '8b0516ba56e511c21bc63e3b4d9924a530d7aa2e9ee29e6b8f099f8135166ae1' },
});

const CACHE_FILE = 'botwarfare-sources.json';
const CACHE_AGE_MS = 18 * 60 * 60 * 1000;
// Failed checks (offline, rate limited) retry sooner instead of caching the
// failure for the full metadata lifetime.
const FAILURE_RETRY_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_CACHE_BYTES = 64 * 1024;
const HOSTS = new Set(['api.github.com', 'github.com', 'codeload.github.com']);
const SHA = /^[a-f0-9]{40}$/;
const TAG = /^v(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})$/;
const ETAG = /^(?:W\/)?"[\x20-\x7e]{1,180}"$/;
const ids = Object.keys(SOURCES);
const COD4_DEVELOPMENT_KEY = 'cod4-development';

function sourceFor(id) {
  if (typeof id !== 'string' || !Object.hasOwn(SOURCES, id)) throw new Error('Unknown Bot Warfare game.');
  return SOURCES[id];
}

function approvedUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.port || url.username || url.password || url.hash) {
    throw new Error('Unapproved source URL.');
  }
  return url.href;
}

function releaseUrl(source, tag, asset) {
  return approvedUrl(`https://github.com/ineedbots/${source.repo}/releases/download/${tag}/${asset}`);
}
function archiveUrl(source, commit) {
  return approvedUrl(`https://codeload.github.com/ineedbots/${source.repo}/zip/${commit}`);
}
function apiUrl(source, developmentSnapshot = false) {
  const suffix = source.commit || developmentSnapshot ? 'commits/master' : 'releases/latest';
  return approvedUrl(`https://api.github.com/repos/ineedbots/${source.repo}/${suffix}`);
}

function cleanNotes(value) {
  return typeof value === 'string' ? value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, 2048) : '';
}
function safeEtag(value) { return typeof value === 'string' && ETAG.test(value) ? value : null; }
function assetFor(source, tag) { return `${source.prefix}${tag.slice(1).replaceAll('.', '')}.zip`; }
function validRelease(source, data) {
  if (!data || !TAG.test(data.tag_name) || !Array.isArray(data.assets)) return null;
  const expected = assetFor(source, data.tag_name);
  const asset = data.assets.find(item => item && item.name === expected &&
    item.browser_download_url === releaseUrl(source, data.tag_name, expected));
  if (!asset) return null;
  return { tag: data.tag_name, asset: asset.name, notes: cleanNotes(data.body) };
}
function validCommit(data) {
  return data && typeof data.sha === 'string' && SHA.test(data.sha) ?
    { commit: data.sha, notes: cleanNotes(data.commit && data.commit.message) } : null;
}
function validRecord(source, record, developmentSnapshot = false) {
  if (!record || typeof record !== 'object') return null;
  if (source.commit || developmentSnapshot) return SHA.test(record.commit) ? { commit: record.commit, notes: cleanNotes(record.notes) } : null;
  if (!TAG.test(record.tag) || record.asset !== assetFor(source, record.tag)) return null;
  return { tag: record.tag, asset: record.asset, notes: cleanNotes(record.notes) };
}

// Stream, rather than response.text(), so Content-Length cannot lie about the body size.
async function boundedJson(response) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error('Source response too large.');
  if (!response.body || typeof response.body.getReader !== 'function') throw new Error('Unreadable source response.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('Source response too large.');
      chunks.push(Buffer.from(value));
    }
  } finally { if (size > MAX_RESPONSE_BYTES) await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// No automatic redirect following: even an approved API URL may redirect to an
// unapproved host. Only the three exact HTTPS hosts above are ever contacted.
async function requestJson(fetcher, url, etag) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('Source request timed out.')); }, REQUEST_TIMEOUT_MS);
  });
  const work = (async () => {
    for (let hops = 0; hops <= 3; hops++) {
      const response = await fetcher(approvedUrl(url), {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'botLANd-source-check',
          ...(etag ? { 'If-None-Match': etag } : {}),
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (hops === 3) throw new Error('Too many source redirects.');
        const location = response.headers.get('location');
        if (!location) throw new Error('Invalid source redirect.');
        url = approvedUrl(new URL(location, url).href);
        continue;
      }
      if (response.status === 304) return { status: 304, etag: safeEtag(response.headers.get('etag')) };
      if (response.status === 403 || response.status === 429) {
        const rateLimited = response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0';
        return { status: rateLimited ? 'rate-limited' : 'offline' };
      }
      if (response.status !== 200) return { status: 'offline' };
      return { status: 200, etag: safeEtag(response.headers.get('etag')), data: await boundedJson(response) };
    }
    throw new Error('Too many source redirects.');
  })();
  try { return await Promise.race([work, timeout]); }
  finally { clearTimeout(timer); controller.abort(); }
}

class BotWarfareSource {
  // userData must be app.getPath('userData'); never pass a game or scripts folder.
  constructor({ userData, fetch: fetcher = globalThis.fetch, now = Date.now } = {}) {
    if (typeof userData !== 'string' || !path.isAbsolute(userData)) throw new Error('Absolute app userData path required.');
    if (typeof fetcher !== 'function' || typeof now !== 'function') throw new Error('Source fetch and clock must be functions.');
    this.file = path.join(userData, CACHE_FILE);
    this.fetch = fetcher;
    this.now = now;
    this.pending = new Map();
    this.queue = Promise.resolve();
  }

  async readCache() {
    let text;
    try {
      if ((await fs.stat(this.file)).size > MAX_CACHE_BYTES) return {};
      text = await fs.readFile(this.file, 'utf8');
    } catch { return {}; }
    try {
      const parsed = JSON.parse(text);
      if (parsed.version !== 1 || !parsed.sources || typeof parsed.sources !== 'object') return {};
      const entries = {};
      for (const id of [...ids, COD4_DEVELOPMENT_KEY]) {
        const raw = parsed.sources[id];
        if (!raw || typeof raw !== 'object') continue;
        const developmentSnapshot = id === COD4_DEVELOPMENT_KEY;
        const source = SOURCES[developmentSnapshot ? 'cod4' : id];
        const record = validRecord(source, raw.record, developmentSnapshot);
        entries[id] = {
          checkedAt: Number.isSafeInteger(raw.checkedAt) && raw.checkedAt >= 0 ? raw.checkedAt : 0,
          etag: record ? safeEtag(raw.etag) : null,
          record,
        };
      }
      return entries;
    } catch { return {}; }
  }

  async writeCache(entries) {
    const file = this.file;
    const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    try {
      await fs.writeFile(temp, JSON.stringify({ version: 1, sources: entries }), { flag: 'wx', mode: 0o600 });
      await fs.rename(temp, file);
    } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
  }

  async refresh(id, force = false, channel = 'stable') {
    const source = sourceFor(id);
    const developmentSnapshot = id === 'cod4' && channel === 'development';
    // CoD4's source snapshot and packaged release have independent ETags and TTLs.
    const key = developmentSnapshot ? COD4_DEVELOPMENT_KEY : id;
    if (this.pending.has(key)) return this.pending.get(key);
    const task = (async () => {
      const entries = await this.readCache();
      const entry = entries[key] || { checkedAt: 0, etag: null, record: null };
      const now = this.now();
      if (!force && entry.checkedAt && now >= entry.checkedAt && now - entry.checkedAt < CACHE_AGE_MS) {
        return { status: 'cached', record: entry.record };
      }
      let result;
      try { result = await requestJson(this.fetch, apiUrl(source, developmentSnapshot), entry.etag); }
      catch { result = { status: 'offline' }; }
      let status = result.status;
      let record = entry.record;
      if (status === 200) {
        const next = source.commit || developmentSnapshot ? validCommit(result.data) : validRelease(source, result.data);
        if (next) { record = next; entry.etag = result.etag; status = 'current'; }
        else { status = 'unsupported'; entry.etag = null; }
      } else if (status === 304) {
        if (!record) { status = 'offline'; entry.etag = null; }
        else { status = 'not-modified'; entry.etag = result.etag || entry.etag; }
      }
      entry.record = record;
      const succeeded = status === 'current' || status === 'not-modified' || status === 'unsupported';
      const previous = entry.checkedAt && entry.checkedAt <= now ? entry.checkedAt : 0;
      entry.checkedAt = succeeded ? now : Math.max(previous, now - CACHE_AGE_MS + FAILURE_RETRY_MS);
      // Fetches can run concurrently; merge and persist one cache entry at a
      // time so simultaneous game and channel checks do not lose each other.
      const save = this.queue.then(async () => {
        const current = await this.readCache();
        current[key] = entry;
        await this.writeCache(current);
      });
      this.queue = save.then(() => {}, () => {});
      try { await save; } catch { /* Optional metadata cache, never block the app. */ }
      return { status, record };
    })();
    this.pending.set(key, task);
    try { return await task; } finally { this.pending.delete(key); }
  }

  async resolveSource(id, channel = 'stable', { force = false } = {}) {
    const source = sourceFor(id);
    if (channel !== 'stable' && channel !== 'development') throw new Error('Unknown Bot Warfare channel.');
    const { status, record } = await this.refresh(id, force, channel);
    const repo = `https://github.com/ineedbots/${source.repo}`;
    if (channel === 'development' && !source.commit && id !== 'cod4') return {
      id, channel, repo, supported: false, status, refType: null, ref: null, assetUrl: null,
      notes: 'Development source snapshots are not verified installable release packages for this game.',
    };
    if (source.commit || channel === 'development') {
      const commit = source.commit && channel === 'stable' ? source.commit : record && record.commit;
      return {
        id, channel, repo, supported: Boolean(commit), status, refType: 'commit', ref: commit || null,
        commit: commit || null, assetUrl: commit ? archiveUrl(source, commit) : null,
        expectedHash: source.commit && channel === 'stable' ? source.sha256 : null,
        notes: source.commit && channel === 'stable' ? 'Pinned upstream source snapshot; T6 has no tagged releases.' :
          (commit ? record.notes : 'Latest master commit is unavailable offline; development install is disabled.'),
      };
    }
    const usable = record && compareTags(record.tag, source.tag) >= 0 ? record : null;
    const tag = usable ? usable.tag : source.tag;
    const asset = usable ? usable.asset : source.asset;
    return { id, channel, repo, supported: true, status, refType: 'tag', ref: tag, tag,
      assetUrl: releaseUrl(source, tag, asset), expectedHash: tag === source.tag ? source.sha256 : null,
      notes: usable ? usable.notes : '' };
  }

  // installed: { cod4: { channel: 'development', commit: '...' }, bo2: { channel: 'stable', commit: '...' } }
  // Unknown/missing manifests are not interpreted as an available update.
  async checkUpdates({ installed = {}, force = false } = {}) {
    const results = await Promise.all(ids.map(async id => {
      const source = SOURCES[id];
      const { status, record } = await this.refresh(id, force);
      const latest = source.commit ||
        (record && compareTags(record.tag, source.tag) >= 0 ? record.tag : source.tag);
      const manifest = installed && Object.hasOwn(installed, id) ? installed[id] : null;
      const cod4Development = id === 'cod4' && manifest && manifest.channel === 'development' ?
        await this.refresh(id, force, 'development') : null;
      let updateAvailable = null;
      if (manifest && typeof manifest === 'object' && manifest.channel === 'stable') {
        const current = source.commit ? (manifest.commit || (manifest.refType === 'commit' && manifest.ref))
          : (manifest.tag || (manifest.refType === 'tag' && manifest.ref));
        if (typeof current === 'string' && (source.commit ? SHA.test(current) : TAG.test(current))) {
          // Only claim an update when the latest upstream tag is newer. T6's stable
          // commit is pinned and never silently replaced by master.
          updateAvailable = source.commit ? false : compareTags(latest, current) > 0;
        }
      } else if ((source.commit || id === 'cod4') && manifest && manifest.channel === 'development' &&
                 typeof (manifest.commit || manifest.ref) === 'string' && SHA.test(manifest.commit || manifest.ref)) {
        const developmentCommit = cod4Development ? cod4Development.record && cod4Development.record.commit :
          record && record.commit;
        if (developmentCommit) updateAvailable = (manifest.commit || manifest.ref) !== developmentCommit;
      }
      return [id, { status: cod4Development ? cod4Development.status : status,
        repo: `https://github.com/ineedbots/${source.repo}`,
        latest: source.commit ? { commit: latest, developmentCommit: record && record.commit || null } :
          cod4Development ? { tag: latest, developmentCommit: cod4Development.record && cod4Development.record.commit || null } :
            { tag: latest },
        updateAvailable }];
    }));
    return Object.fromEntries(results);
  }
}

function compareTags(a, b) {
  const left = a.slice(1).split('.').map(Number);
  const right = b.slice(1).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}

module.exports = { SOURCES, BotWarfareSource, approvedUrl, CACHE_AGE_MS, MAX_RESPONSE_BYTES };

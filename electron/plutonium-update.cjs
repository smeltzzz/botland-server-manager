const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { bootstrapPath } = require('./profiles.cjs');

// botLANd keeps one copy of Plutonium's official updater (plutonium.exe) in its
// own app data folder and runs it with -update-only. The updater installs or
// refreshes Plutonium in %LOCALAPPDATA%\Plutonium, which is where every
// Plutonium server is launched from. Nothing else is downloaded or executed.
const UPDATER_URL = 'https://cdn.plutonium.pw/updater/plutonium.exe';
// SHA-256 of the official updater published at UPDATER_URL. Its signing
// certificate does not chain to a trusted root, so a pinned digest is the only
// meaningful integrity check. If Plutonium publishes a new updater, downloads
// are refused until botLANd is updated; an already installed Plutonium keeps working.
const UPDATER_SHA256 = '85d1d1ca4d5881d9b98928c2006fb0eec9655e2705fe74088e6f974a19703f0f';
const MAX_BYTES = 32 * 1024 * 1024;
const IDLE_TIMEOUT_MS = 30_000;
const TOTAL_TIMEOUT_MS = 5 * 60_000;
const RUN_TIMEOUT_MS = 15 * 60_000;
// Launches skip the update when Plutonium was refreshed recently.
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

function approved(raw) {
  let url;
  try { url = new URL(raw); } catch { return false; }
  return url.protocol === 'https:' && !url.port && !url.username && !url.password &&
    (url.hostname === 'plutonium.pw' || url.hostname.endsWith('.plutonium.pw'));
}
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }

/** Download the pinned updater; only HTTPS plutonium.pw hosts are contacted. */
async function downloadUpdater({ fetch: fetcher = globalThis.fetch, url = UPDATER_URL, sha256 = UPDATER_SHA256,
  idleTimeoutMs = IDLE_TIMEOUT_MS, totalTimeoutMs = TOTAL_TIMEOUT_MS } = {}) {
  if (typeof fetcher !== 'function') throw new TypeError('Plutonium download fetch must be a function.');
  const controller = new AbortController();
  let idle;
  let expired = false;
  let reader;
  // Aborting the request does not always end a body that is already streaming,
  // so a stalled download also cancels its reader.
  const expire = () => {
    expired = true;
    controller.abort();
    try { if (reader) Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* Already released. */ }
  };
  const touch = () => { clearTimeout(idle); idle = setTimeout(expire, idleTimeoutMs); };
  const overall = setTimeout(expire, totalTimeoutMs);
  const failed = () => new Error(expired
    ? 'The Plutonium download timed out. Check your connection and try again.'
    : 'Could not download Plutonium. Check your connection and try again.');
  try {
    let target = url;
    for (let hops = 0; hops <= 3; hops++) {
      if (!approved(target)) throw new Error('Refused a Plutonium download from an unexpected address.');
      touch();
      let response;
      try {
        response = await fetcher(target, { method: 'GET', redirect: 'manual', signal: controller.signal,
          headers: { Accept: 'application/octet-stream', 'User-Agent': 'botLANd-plutonium-update' } });
      } catch { throw failed(); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw failed();
        target = new URL(location, target).href;
        continue;
      }
      if (response.status !== 200 || !response.body) throw failed();
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error('The Plutonium download is larger than expected.');
      reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          let result;
          try { result = await reader.read(); } catch { throw failed(); }
          if (expired) throw failed();
          if (result.done) break;
          touch();
          size += result.value.length;
          if (size > MAX_BYTES) throw new Error('The Plutonium download is larger than expected.');
          chunks.push(Buffer.from(result.value));
        }
      } finally {
        const current = reader;
        reader = undefined;
        try { current.releaseLock(); } catch { /* A cancelled read may still hold the lock. */ }
      }
      const bytes = Buffer.concat(chunks, size);
      const digest = crypto.createHash('sha256').update(bytes).digest('hex');
      if (digest !== sha256) {
        throw new Error('The downloaded Plutonium updater did not match the verified version, so it was not used. '
          + 'Plutonium may have published a new updater; update botLANd, or install Plutonium from plutonium.pw.');
      }
      return bytes;
    }
    throw new Error('Too many redirects while downloading Plutonium.');
  } finally {
    clearTimeout(idle);
    clearTimeout(overall);
    controller.abort();
  }
}

// The updater must run like a double-click: with redirected pipes or a hidden
// window it never exits. Its own small progress window shows briefly instead.
function runUpdater(file, args, { cwd, timeout, onSpawn = () => {}, spawnProcess = spawn }) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnProcess(file, args, { cwd, windowsHide: false, stdio: 'ignore', shell: false }); }
    catch { return reject(new Error('The Plutonium updater could not be started. Antivirus software may have blocked it.')); }
    let spawned = false;
    let processError = false;
    child.once('spawn', () => { spawned = true; onSpawn(child.pid); });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.once('error', () => {
      if (spawned) { processError = true; return; }
      clearTimeout(timer);
      reject(new Error('The Plutonium updater could not be started. Antivirus software may have blocked it.'));
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('The Plutonium update took too long and was stopped.'));
      if (code === 0) return resolve();
      if (processError && (code === null || code === undefined)) return reject(new Error('The Plutonium updater process reported an error.'));
      reject(new Error(`The Plutonium updater exited with code ${code ?? 'unknown'}.`));
    });
  });
}

const LAUNCHER = 'plutonium-launcher-win32.exe';
/** Running Plutonium launcher windows, with the process that started each one. */
function listLaunchers() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const script = `@(Get-CimInstance Win32_Process -Filter "Name='${LAUNCHER}'" | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId } }) | ConvertTo-Json -Compress`;
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 20000, windowsHide: true, maxBuffer: 1_000_000 }, (error, stdout) => {
      if (error) return resolve(null); // Unknown: callers must not assume "closed".
      try {
        const parsed = JSON.parse(String(stdout).trim() || '[]');
        const items = Array.isArray(parsed) ? parsed : [parsed];
        resolve(items.every(item => Number.isInteger(item?.pid) && Number.isInteger(item?.ppid)) ? items : null);
      } catch { resolve(null); }
    });
  });
}
function killProcess(pid) { try { process.kill(pid); } catch { /* Already closed. */ } }

class PlutoniumUpdater {
  /** @param {{ userData: string, fetch?: typeof fetch, run?: typeof runUpdater, now?: () => number,
   *  bootstrapper?: () => string, maxAgeMs?: number, launchers?: typeof listLaunchers, kill?: (pid: number) => void,
   *  sha256?: string }} options */
  constructor({ userData, fetch, run = runUpdater, now = Date.now, bootstrapper = bootstrapPath, maxAgeMs = MAX_AGE_MS,
    launchers = listLaunchers, kill = killProcess, sha256 = UPDATER_SHA256 }) {
    this.launchers = launchers;
    this.kill = kill;
    if (typeof userData !== 'string' || !path.isAbsolute(userData)) throw new Error('An absolute app data folder is required.');
    this.dir = path.join(userData, 'plutonium');
    this.exe = path.join(this.dir, 'plutonium.exe');
    this.stateFile = path.join(this.dir, 'state.json');
    this.fetch = fetch;
    this.sha256 = sha256;
    this.run = run;
    this.now = now;
    this.bootstrapper = bootstrapper;
    this.maxAgeMs = maxAgeMs;
    this.running = null;
    this.lastError = '';
  }
  get updating() { return this.running !== null; }
  async readState() {
    try {
      const state = JSON.parse(await fs.readFile(this.stateFile, 'utf8'));
      return typeof state?.lastUpdated === 'string' && !Number.isNaN(Date.parse(state.lastUpdated)) ? state : {};
    } catch { return {}; }
  }
  async installed() {
    const file = this.bootstrapper();
    return Boolean(file) && path.isAbsolute(file) && exists(file);
  }
  async status() {
    const [installed, state] = await Promise.all([this.installed(), this.readState()]);
    return { installed, updating: this.updating, lastUpdated: state.lastUpdated || null, error: this.lastError || null };
  }
  async ensureUpdater() {
    let cached;
    try { cached = await fs.readFile(this.exe); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (cached && crypto.createHash('sha256').update(cached).digest('hex') === this.sha256) return;
    await fs.mkdir(this.dir, { recursive: true });
    const bytes = await downloadUpdater({ fetch: this.fetch, sha256: this.sha256 });
    const temp = `${this.exe}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, bytes);
      // Windows cannot rename over an existing file. Never run the old copy if
      // it changed: replacement failure leaves the update failed, not trusted.
      if (cached) await fs.rm(this.exe);
      await fs.rename(temp, this.exe);
      const installed = await fs.readFile(this.exe);
      if (crypto.createHash('sha256').update(installed).digest('hex') !== this.sha256) {
        throw new Error('The cached Plutonium updater did not match the verified version, so it was not used.');
      }
    } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
  }
  /** Install or update Plutonium. Concurrent callers share one run. */
  update() {
    if (this.running) return this.running;
    const work = (async () => {
      try {
        if (!path.isAbsolute(this.bootstrapper() || '')) throw new Error('The Windows LOCALAPPDATA folder is not set, so Plutonium cannot be installed.');
        // With the launcher open, the updater waits for it to close and never
        // finishes, so do not start an update that cannot complete.
        const launchers = await this.launchers();
        if (launchers === null) throw new Error('Could not check whether the Plutonium launcher is open; the update was not started.');
        if (launchers.length) throw new Error('Close the Plutonium launcher window first; Plutonium cannot update while it is open.');
        await this.ensureUpdater();
        let updaterPid = null;
        try {
          await this.run(this.exe, ['-update-only'], { cwd: this.dir, timeout: RUN_TIMEOUT_MS, onSpawn: pid => { updaterPid = pid; } });
        } finally {
          // The updater opens the Plutonium launcher when it finishes. Close only
          // the window this update started, never one the user opened.
          if (updaterPid) for (const item of await this.launchers() || []) if (item.ppid === updaterPid) this.kill(item.pid);
        }
        if (!await this.installed()) throw new Error('The Plutonium updater finished, but Plutonium was not found afterwards.');
        await fs.writeFile(this.stateFile, JSON.stringify({ lastUpdated: new Date(this.now()).toISOString() }), 'utf8').catch(() => {});
        this.lastError = '';
      } catch (error) {
        this.lastError = error.message;
        throw error;
      }
    })();
    this.running = work;
    work.finally(() => { if (this.running === work) this.running = null; }).catch(() => {});
    return work;
  }
  async fresh() {
    const state = await this.readState();
    return Boolean(state.lastUpdated) && this.now() - Date.parse(state.lastUpdated) < this.maxAgeMs;
  }
  /**
   * Called before a Plutonium server starts. Updates at most once per maxAgeMs.
   * A failed update only blocks the launch when Plutonium is not installed.
   * @param {{ log?: (text: string, level?: string) => void, skip?: boolean }} [options]
   */
  async prepareLaunch({ log = () => {}, skip = false } = {}) {
    // Capture a manual update before any awaits: even a fresh/skipped launch
    // must not proceed until that update has finished (or failed).
    const pending = this.running;
    const installed = await this.installed();
    if (!pending && installed && (skip || await this.fresh()) && !this.running) return { updated: false };
    log(installed ? 'Checking for Plutonium updates…' : 'Installing Plutonium…');
    try {
      await (pending || this.running || this.update());
      log(installed ? 'Plutonium is up to date.' : 'Plutonium installed.');
      return { updated: true };
    } catch (error) {
      if (!await this.installed()) throw new Error(`Plutonium could not be installed: ${error.message}`);
      log(`Plutonium update skipped: ${error.message} Starting with the installed version.`, 'error');
      return { updated: false };
    }
  }
}

module.exports = { PlutoniumUpdater, downloadUpdater, runUpdater, UPDATER_URL, UPDATER_SHA256 };

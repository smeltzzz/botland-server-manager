const { execFile: defaultExecFile } = require('node:child_process');
const { isIP } = require('node:net');

const TIMEOUT_MS = 7000;
const MAX_OUTPUT_BYTES = 3_000_000;

function localPort(endpoint) {
  const match = /^(\[[^\]]+\]|[^:\s]+):(\d{1,5})$/.exec(endpoint);
  if (!match) return null;
  const address = match[1].startsWith('[') ? match[1].slice(1, -1) : match[1];
  const port = Number(match[2]);
  return isIP(address) && port >= 1 && port <= 65535 ? port : null;
}

function collectSockets(stdout, pidsByPort) {
  for (const line of stdout.split(/\r?\n/)) {
    // Windows netstat's UDP rows have a local endpoint, foreign endpoint and
    // PID. Accept a missing foreign endpoint too, but never infer a PID from it.
    const columns = line.trim().split(/\s+/);
    if (columns.length < 3 || columns[0].toUpperCase() !== 'UDP') continue;
    const port = localPort(columns[1]);
    if (port === null) continue;
    const pidText = columns.length === 4 ? columns[3] : columns.length === 3 ? columns[2] : null;
    const pidNumber = pidText && /^[1-9]\d*$/.test(pidText) ? Number(pidText) : NaN;
    const pid = Number.isSafeInteger(pidNumber) ? pidNumber : null;
    if (!pidsByPort.has(port)) pidsByPort.set(port, new Set());
    pidsByPort.get(port).add(pid);
  }
}

function queryNetstat(execFile, protocol) {
  return new Promise((resolve, reject) => {
    try {
      execFile('netstat.exe', ['-ano', '-p', protocol],
        { timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
        (error, stdout) => {
          if (error) return reject(error);
          // execFile enforces maxBuffer for the real process; also enforce it
          // for injected implementations rather than parsing unbounded output.
          if (typeof stdout !== 'string' && !Buffer.isBuffer(stdout)) return reject(new Error('Invalid netstat output.'));
          if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) return reject(new Error('Netstat output exceeded limit.'));
          resolve(String(stdout));
        });
    } catch (error) { reject(error); }
  });
}

/**
 * Detect possible orphan *ports*, not process identity or ownership. A socket
 * may belong to any program, including one unrelated to the given gamePath.
 * Empty results never establish that a port is free: netstat may be unavailable,
 * incomplete or race with a process starting/stopping. No process is adopted or
 * stopped, and no command line (which could contain server keys) is read.
 *
 * @param {{id: string, port: number, gamePath?: string}[]} candidates
 * @param {{execFile?: typeof defaultExecFile}} options
 * @returns {Promise<{id: string, pid: number|null, port: number, reason: string}[]>}
 */
async function findPossibleOrphans(candidates, { execFile = defaultExecFile } = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const requested = candidates.filter(item => item && typeof item.id === 'string' &&
    Number.isInteger(item.port) && item.port >= 1 && item.port <= 65535);
  if (!requested.length) return [];

  // Query both address families. A successful query for only one family can
  // establish occupancy, but cannot establish that its PID is the only one.
  const results = await Promise.allSettled(['udp', 'udpv6'].map(protocol => queryNetstat(execFile, protocol)));
  const pidsByPort = new Map();
  for (const result of results) {
    if (result.status === 'fulfilled') collectSockets(result.value, pidsByPort);
  }
  const incomplete = results.some(result => result.status === 'rejected');
  const reported = new Set();
  const findings = [];
  for (const { id, port } of requested) {
    const pids = pidsByPort.get(port);
    if (!pids || reported.has(JSON.stringify([id, port]))) continue;
    reported.add(JSON.stringify([id, port]));
    const ambiguous = incomplete || pids.size !== 1 || pids.has(null);
    findings.push({
      id, pid: ambiguous ? null : [...pids][0], port,
      reason: ambiguous ? 'UDP port occupied (ambiguous PID; process identity unverified)'
        : 'UDP port occupied (process identity unverified)',
    });
  }
  return findings;
}

module.exports = { findPossibleOrphans };

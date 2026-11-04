const os = require('node:os');
const { isIP } = require('node:net');

function ipv4Scope(address) {
  const [a, b, c] = address.split('.').map(Number);
  // Unspecified, loopback, link-local (APIPA), multicast and reserved addresses
  // cannot be offered as ordinary connect targets.
  if (a === 0 || a === 127 || (a === 169 && b === 254) || a >= 224) return null;
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'shared';
  // Do not describe special-purpose addresses as public Internet addresses.
  if ((a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)) return 'other';
  return 'public';
}

const descriptions = {
  private: 'Private LAN IPv4',
  shared: 'Shared/CGNAT IPv4 (not a private LAN address)',
  other: 'Other IPv4 (not a private LAN address)',
  public: 'Public IPv4 (not a private LAN address; external reachability is unknown)',
  ula: 'Private IPv6 ULA',
};

function rank(scope) {
  if (scope === 'private') return 0;
  if (scope === 'ula') return 2;
  return 1;
}

/**
 * List OS-assigned connect targets without querying the network. Only a single
 * candidate in the best-ranked group is suggested as primary; multiple NICs
 * require the host to choose an address suitable for their players' network.
 * This cannot establish whether an adapter is physically connected or whether
 * any address/port is reachable from another computer.
 *
 * @param {number} port UDP port (1–65535)
 * @param {typeof os.networkInterfaces} networkInterfaces Injectable OS enumerator
 * @returns {{primaryAddress: string|null, primary: object|null, ambiguous: boolean, candidates: object[]}}
 */
function discoverConnectAddresses(port, networkInterfaces = os.networkInterfaces) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError('Invalid connect port.');
  let interfaces;
  try { interfaces = networkInterfaces(); } catch { interfaces = {}; }
  const candidates = [];
  const seen = new Set();
  if (interfaces && typeof interfaces === 'object') {
    for (const [adapter, entries] of Object.entries(interfaces)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!entry || entry.internal !== false || typeof entry.address !== 'string') continue;
        const { address } = entry;
        const family = entry.family === 4 ? 'IPv4' : entry.family === 6 ? 'IPv6' : entry.family;
        let scope;
        if (family === 'IPv4' && isIP(address) === 4) scope = ipv4Scope(address);
        else if (family === 'IPv6' && isIP(address) === 6 && !address.includes('%')) {
          const first = Number.parseInt(address.split(':', 1)[0], 16);
          if (first >= 0xfc00 && first <= 0xfdff) scope = 'ula';
        }
        if (!scope) continue;
        const key = JSON.stringify([adapter, family, address.toLowerCase()]);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ adapter, address, family, scope, label: descriptions[scope],
          connectAddress: `${family === 'IPv6' ? `[${address}]` : address}:${port}` });
      }
    }
  }
  // Preserve OS enumeration order within each class; it does not imply network
  // priority. An equally ranked second address makes the choice ambiguous.
  candidates.sort((left, right) => rank(left.scope) - rank(right.scope));
  const ambiguous = candidates.length > 1 && rank(candidates[0].scope) === rank(candidates[1].scope);
  const primary = candidates.length && !ambiguous ? candidates[0] : null;
  return { primaryAddress: primary?.connectAddress ?? null, primary, ambiguous, candidates };
}

module.exports = { discoverConnectAddresses };

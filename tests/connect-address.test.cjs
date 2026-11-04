const test = require('node:test');
const assert = require('node:assert/strict');
const { discoverConnectAddresses } = require('../electron/connect-address.cjs');

function ip(address, overrides = {}) {
  return { address, family: address.includes(':') ? 'IPv6' : 'IPv4', internal: false, ...overrides };
}
function discover(port, interfaces) {
  return discoverConnectAddresses(port, () => interfaces);
}

test('suggests the only RFC1918 IPv4 before other IPv4 and IPv6 ULA', () => {
  const result = discover(28960, {
    other: [ip('8.8.8.8'), ip('fd12:3456::7')],
    lan: [ip('172.31.8.4')],
  });
  assert.deepEqual(result.candidates.map(candidate => candidate.connectAddress),
    ['172.31.8.4:28960', '8.8.8.8:28960', '[fd12:3456::7]:28960']);
  assert.equal(result.primaryAddress, '172.31.8.4:28960');
  assert.equal(result.primary, result.candidates[0]);
  assert.equal(result.ambiguous, false);
  assert.deepEqual(result.candidates.map(candidate => candidate.scope), ['private', 'public', 'ula']);
  assert.equal(result.candidates[0].adapter, 'lan');
});

test('returns all equally ranked LAN adapters but does not claim one as the primary', () => {
  const result = discover(27016, {
    wifi: [ip('192.168.1.2')],
    ethernet: [ip('10.0.0.2')],
    vpn: [ip('172.16.0.5')],
  });
  assert.deepEqual(result.candidates.map(candidate => [candidate.adapter, candidate.connectAddress]), [
    ['wifi', '192.168.1.2:27016'], ['ethernet', '10.0.0.2:27016'], ['vpn', '172.16.0.5:27016'],
  ]);
  assert.equal(result.primaryAddress, null);
  assert.equal(result.primary, null);
  assert.equal(result.ambiguous, true);
});

test('filters loopback, APIPA, unspecified, multicast, internal, and malformed entries', () => {
  const result = discover(1234, {
    local: [ip('127.0.0.1'), ip('127.10.0.1'), ip('169.254.1.2'), ip('0.2.3.4'),
      ip('224.0.0.1'), ip('255.255.255.255'), ip('::1'), ip('fe80::1'),
      ip('192.168.1.4', { internal: true }), ip('192.168.1.5', { family: 'IPv6' }),
      ip('10.1.1.1:9999'), ip('192.168.1.2'), ip('192.168.1.2'), null],
    malformed: undefined,
  });
  assert.deepEqual(result.candidates.map(candidate => candidate.address), ['192.168.1.2']);
  assert.equal(result.primaryAddress, '192.168.1.2:1234');
});

test('identifies public and shared IPv4 without presenting either as private LAN', () => {
  const publicResult = discover(30000, { ethernet: [ip('8.8.4.4', { family: 4 })] });
  assert.equal(publicResult.primaryAddress, '8.8.4.4:30000');
  assert.equal(publicResult.primary.scope, 'public');
  assert.match(publicResult.primary.label, /Public IPv4.*not a private LAN address/);
  assert.match(publicResult.primary.label, /reachability is unknown/);
  const shared = discover(30000, { vpn: [ip('100.64.1.2')] });
  assert.equal(shared.primary.scope, 'shared');
  assert.match(shared.primary.label, /not a private LAN address/);
  for (const address of ['192.0.2.4', '198.51.100.12', '203.0.113.7', '192.88.99.1']) {
    const documentation = discover(30000, { test: [ip(address)] });
    assert.equal(documentation.primary.scope, 'other');
    assert.doesNotMatch(documentation.primary.label, /Public IPv4/);
  }
  assert.equal(discover(30000, { lan: [ip('172.15.1.1')] }).primary.scope, 'public');
  assert.equal(discover(30000, { lan: [ip('172.32.1.1')] }).primary.scope, 'public');
});

test('uses bracketed IPv6 ULA only as a fallback and supports numeric OS family values', () => {
  const fallback = discover(28962, {
    lan: [ip('2001:db8::5'), ip('fdab::42', { family: 6 }), ip('fc00::1')],
  });
  assert.deepEqual(fallback.candidates.map(candidate => candidate.connectAddress),
    ['[fdab::42]:28962', '[fc00::1]:28962']);
  assert.equal(fallback.primaryAddress, null);
  assert.equal(fallback.ambiguous, true);
  assert.equal(fallback.candidates[0].family, 'IPv6');
  const one = discover(28962, { lan: [ip('fdab::42')] });
  assert.equal(one.primaryAddress, '[fdab::42]:28962');
  const otherV4 = discover(28962, { lan: [ip('fdab::42'), ip('100.127.0.2')] });
  assert.equal(otherV4.primaryAddress, '100.127.0.2:28962');
});

test('empty/unavailable enumeration produces no candidates; rejects invalid ports before enumeration', () => {
  const empty = { primaryAddress: null, primary: null, ambiguous: false, candidates: [] };
  assert.deepEqual(discover(28960, {}), empty);
  assert.deepEqual(discoverConnectAddresses(28960, () => { throw new Error('unavailable'); }), empty);
  assert.deepEqual(discoverConnectAddresses(28960, () => null), empty);
  for (const port of [0, 65536, -1, 1.2, '28960', NaN, Infinity]) {
    assert.throws(() => discoverConnectAddresses(port, () => { throw new Error('enumerated'); }),
      /Invalid connect port/);
  }
});

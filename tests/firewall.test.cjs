const test = require('node:test');
const assert = require('node:assert/strict');
const { ServerManager } = require('../electron/manager.cjs');

// Mirrors the NetSecurity cmdlet output: enum names, independent of the Windows display language.
function rule(port, remoteAddress, overrides = {}) {
  return {
    enabled: overrides.enabled ?? 'True',
    direction: overrides.direction ?? 'Inbound',
    action: overrides.action ?? 'Allow',
    protocol: overrides.protocol ?? 'UDP',
    localPort: overrides.localPort ?? [String(port)],
    remoteAddress: overrides.remoteAddress ?? [remoteAddress],
  };
}

test('names one firewall rule per game', () => {
  const manager = new ServerManager('unused', () => {}, 'unused');
  assert.equal(manager.firewallName('cod4'), 'botLANd CoD4 UDP');
  assert.equal(manager.firewallName('bo2'), 'botLANd BO2 UDP');
});

test('reads missing, lan, any, drift and unknown rule states', async () => {
  const manager = new ServerManager('unused', () => {}, 'unused');
  const queried = [];
  const respond = rules => { manager.firewallQuery = async name => { queried.push(name); return rules; }; };
  respond([rule(28962, 'LocalSubnet')]);
  assert.equal((await manager.firewallStatus('cod4')).state, 'lan');
  assert.equal(queried[0], 'botLANd CoD4 UDP');
  respond([rule(28962, 'Any')]);
  assert.equal((await manager.firewallStatus('cod4')).state, 'any');
  // Single values (not arrays) are accepted too.
  respond([rule(28962, null, { localPort: '28962', remoteAddress: 'LocalSubnet' })]);
  assert.equal((await manager.firewallStatus('cod4')).state, 'lan');
  for (const overrides of [{ localPort: ['12'] }, { enabled: 'False' }, { direction: 'Outbound' }, { action: 'Block' }, { protocol: 'TCP' },
    { remoteAddress: ['172.16.0.0/12'] }, { remoteAddress: ['LocalSubnet', '10.0.0.0/8'] }, { localPort: ['28962', '28963'] }]) {
    respond([rule(28962, 'LocalSubnet', overrides)]);
    assert.equal((await manager.firewallStatus('cod4')).state, 'drift', JSON.stringify(overrides));
  }
  respond([rule(28962, 'LocalSubnet'), rule(28962, 'LocalSubnet')]);
  assert.equal((await manager.firewallStatus('cod4')).state, 'drift');
  respond([]);
  assert.deepEqual(await manager.firewallStatus('cod4'), { name: 'botLANd CoD4 UDP', port: 28962, state: 'missing' });
  manager.firewallQuery = async () => { throw new Error('firewall service unavailable'); };
  assert.equal((await manager.firewallStatus('cod4')).state, 'unknown');
});

test('applies the rule elevated with the stored port and visibility scope', async () => {
  const manager = new ServerManager('unused', () => {}, 'unused');
  const runs = [];
  manager.runElevated = async lines => { runs.push(lines); };
  manager.firewallQuery = async () => [rule(28962, 'LocalSubnet')];
  assert.equal((await manager.firewallApply('cod4')).state, 'lan');
  assert.equal(runs.length, 1);
  const script = runs[0].join('\n');
  assert.match(script, /\$targetName = 'botLANd CoD4 UDP'/);
  assert.match(script, /\$targetPort = '28962'/);
  assert.match(script, /\$targetScope = 'LocalSubnet'/);
  assert.match(script, /New-NetFirewallRule/);
  assert.match(script, /Assert-ManagedRule/);
  assert.match(script, /Set-NetFirewallRule.*-NewDisplayName/);
  assert.ok(script.indexOf('New-NetFirewallRule') < script.indexOf('Remove-NetFirewallRule'));
  manager.data.games.mw3 = { port: 27016, lan: false };
  const mw3Runs = [];
  manager.runElevated = async lines => { mw3Runs.push(lines); };
  manager.firewallQuery = async () => [rule(27016, 'Any')];
  assert.equal((await manager.firewallApply('mw3')).state, 'any');
  const mw3Script = mw3Runs[0].join('\n');
  assert.match(mw3Script, /\$targetPort = '27016'/);
  assert.match(mw3Script, /\$targetScope = 'Any'/);
});

test('a running server keeps its rule on the launched port; scope follows saved visibility', async () => {
  const manager = new ServerManager('unused', () => {}, 'unused');
  manager.data.games.cod4 = { port: 30000, lan: true };
  manager.instances.set('cod4', { status: 'running', activePort: 28962 });
  const runs = [];
  manager.runElevated = async lines => { runs.push(lines); };
  manager.firewallQuery = async () => [rule(28962, 'LocalSubnet')];
  assert.deepEqual(await manager.firewallStatus('cod4'), { name: 'botLANd CoD4 UDP', port: 28962, state: 'lan' });
  await manager.firewallApply('cod4');
  assert.match(runs[0].join('\n'), /\$targetPort = '28962'/);
  assert.match(runs[0].join('\n'), /\$targetScope = 'LocalSubnet'/);
  // Switching to Public while running widens the scope immediately, on the live port.
  manager.data.games.cod4.lan = false;
  await manager.firewallApply('cod4');
  assert.match(runs[1].join('\n'), /\$targetPort = '28962'/);
  assert.match(runs[1].join('\n'), /\$targetScope = 'Any'/);
  // Once stopped, the saved port applies and the old rule reads as a mismatch.
  manager.instances.delete('cod4');
  assert.deepEqual(await manager.firewallStatus('cod4'), { name: 'botLANd CoD4 UDP', port: 30000, state: 'drift' });
});

test('BO1 always gets a LAN-scoped rule because its launch stays public', async () => {
  const manager = new ServerManager('unused', () => {}, 'unused');
  manager.data.games.bo1 = { lan: false };
  assert.equal(manager.options('bo1').lan, false);
  assert.equal(manager.firewallScope('bo1'), 'lan');
  const runs = [];
  manager.runElevated = async lines => { runs.push(lines); };
  manager.firewallQuery = async () => [rule(28961, 'LocalSubnet')];
  assert.equal((await manager.firewallApply('bo1')).state, 'lan');
  assert.match(runs[0].join('\n'), /\$targetPort = '28961'/);
  assert.match(runs[0].join('\n'), /\$targetScope = 'LocalSubnet'/);
});

test('removes the rule elevated and reports a missing rule', async () => {
  const manager = new ServerManager('unused', () => {}, 'unused');
  const runs = [];
  manager.runElevated = async lines => { runs.push(lines); };
  manager.firewallQuery = async () => [];
  const removed = await manager.firewallRemove('waw');
  assert.deepEqual(removed, { name: 'botLANd WaW UDP', port: 28963, state: 'missing' });
  assert.equal(runs.length, 1);
  assert.equal(runs[0][0], "$targetName = 'botLANd WaW UDP'");
  assert.match(runs[0].join('\n'), /Remove-NetFirewallRule -PolicyStore PersistentStore -Name \(\[string\]\$rule\.Name\) -ErrorAction Stop/);
});

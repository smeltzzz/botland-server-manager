const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { buildFirewallApplyLines, buildFirewallRemoveLines } = require('../electron/firewall-rule.cjs');

const input = { name: 'botLANd BO1 UDP', port: 28961, scope: 'localsubnet' };
const lines = () => buildFirewallApplyLines(input);
const removeLines = () => buildFirewallRemoveLines({ name: input.name });

function rule(name = 'old', display = input.name, group = 'botLANd.ServerManager') {
  return { Name: name, DisplayName: display, Group: group, Description: 'Managed by botLANd Server Manager (UDP)', Direction: 'Inbound', Action: 'Allow', Enabled: 'True', Profile: 'Any', Protocol: 'UDP', LocalPort: '12345', RemotePort: 'Any', LocalAddress: 'Any', RemoteAddress: 'Any', Program: 'Any', Service: 'Any' };
}

// A rule made by the old launcher scripts (netsh): same name, no owner or description.
function legacy(name = 'old', overrides = {}) {
  return { ...rule(name), Group: '', Description: '', LocalPort: String(input.port), ...overrides };
}

function mockRun(scenario, initial = [], generator = lines) {
  // This harness shadows every NetSecurity cmdlet in a child PowerShell process.
  // It has no elevation, no import of NetSecurity and no real firewall writes.
  const prelude = `
$ErrorActionPreference = 'Stop'
$script:rules = [System.Collections.ArrayList]::new()
$script:scenario = '${scenario}'
$script:failed = $false
foreach ($item in (ConvertFrom-Json -InputObject '${JSON.stringify(initial).replaceAll("'", "''")}')) { [void]$script:rules.Add($item) }
function Get-NetFirewallRule {
  [CmdletBinding()] param([string]$PolicyStore, [string]$DisplayName, [string]$Name)
  if ($PSBoundParameters.ContainsKey('Name') -and -not $script:failed) {
    if ($script:scenario -eq 'remove-owner-drift') {
      $script:failed = $true
      $script:rules[0].Group = 'administrator'
    }
    if ($script:scenario -eq 'remove-new-policy') {
      $script:failed = $true
      [void]$script:rules.Add([pscustomobject]@{ Name='policy'; DisplayName='botLANd BO1 UDP'; Group=''; Description=''; Store='GPO' })
    }
  }
  foreach ($item in $script:rules) {
    if ($PolicyStore -eq 'ActiveStore' -or $PolicyStore -eq 'PersistentStore') {
      if ($PolicyStore -eq 'PersistentStore' -and $item.PSObject.Properties['Store'] -and $item.Store -eq 'GPO') { continue }
      if ($script:scenario -eq 'remove-policy-shadow' -and $PolicyStore -eq 'ActiveStore' -and -not ($item.PSObject.Properties['Store'] -and $item.Store -eq 'GPO')) { continue }
      if ($PSBoundParameters.ContainsKey('Name') -and $item.Name -cne $Name) { continue }
      if ($PSBoundParameters.ContainsKey('DisplayName') -and $item.DisplayName -cne $DisplayName) { continue }
      if ($PolicyStore -eq 'ActiveStore') {
        $copy = $item.PSObject.Copy()
        $source = if ($item.PSObject.Properties['Store'] -and $item.Store -eq 'GPO') { 'GroupPolicy' } else { 'Local' }
        $copy | Add-Member -NotePropertyName PolicyStoreSourceType -NotePropertyValue $source -Force
        $copy
      } else { $item }
    }
  }
}
function New-NetFirewallRule {
  [CmdletBinding()] param([string]$PolicyStore, [string]$Name, [string]$DisplayName, [string]$Group, [string]$Description, [string]$Direction, [string]$Action, [string]$Enabled, [string]$Profile, [string]$Protocol, [string]$LocalPort, [string]$RemotePort, [string]$LocalAddress, [string]$RemoteAddress)
  [void]$script:rules.Add([pscustomobject]@{ Name=$Name; DisplayName=$DisplayName; Group=$Group; Description=$Description; Direction=$Direction; Action=$Action; Enabled=$Enabled; Profile=$Profile; Protocol=$Protocol; LocalPort=$LocalPort; RemotePort=$RemotePort; LocalAddress=$LocalAddress; RemoteAddress=$RemoteAddress; Program='Any'; Service='Any' })
  if ($script:scenario -eq 'create') { throw 'mock create failure after insertion' }
}
function Set-NetFirewallRule {
  [CmdletBinding()] param([string]$PolicyStore, [string]$Name, [string]$NewDisplayName)
  if ($script:scenario -eq 'promote' -and $Name -like 'botLANd-*' -and $NewDisplayName -eq 'botLANd BO1 UDP') { throw 'mock promotion failure' }
  $item = @($script:rules | Where-Object Name -CEQ $Name)[0]
  if (-not $item) { throw 'mock rule missing' }
  $item.DisplayName = $NewDisplayName
  if ($script:scenario -eq 'promote-after-write' -and $Name -like 'botLANd-*' -and -not $script:failed) { $script:failed = $true; throw 'mock post-write promotion failure' }
}
function Remove-NetFirewallRule {
  [CmdletBinding()] param([string]$PolicyStore, [string]$Name)
  if ($script:scenario -eq 'cleanup' -and $Name -eq 'old') { throw 'mock cleanup failure' }
  if ($script:scenario -eq 'remove-noop') { return }
  $item = @($script:rules | Where-Object Name -CEQ $Name)[0]
  if ($item) { [void]$script:rules.Remove($item) }
  if ($script:scenario -eq 'remove-policy-after-write') {
    [void]$script:rules.Add([pscustomobject]@{ Name='policy'; DisplayName='botLANd BO1 UDP'; Group=''; Description=''; Store='GPO' })
  }
  if ($script:scenario -eq 'cleanup-after-write' -and $Name -eq 'old') { throw 'mock post-write cleanup failure' }
}
function Get-NetFirewallPortFilter {
  [CmdletBinding()] param([Parameter(ValueFromPipeline)]$InputObject)
  process { [pscustomobject]@{ Protocol=$InputObject.Protocol; LocalPort=$InputObject.LocalPort; RemotePort=$InputObject.RemotePort } }
}
function Get-NetFirewallAddressFilter {
  [CmdletBinding()] param([Parameter(ValueFromPipeline)]$InputObject)
  process { [pscustomobject]@{ LocalAddress=$InputObject.LocalAddress; RemoteAddress=$InputObject.RemoteAddress } }
}
function Get-NetFirewallApplicationFilter {
  [CmdletBinding()] param([Parameter(ValueFromPipeline)]$InputObject)
  process { [pscustomobject]@{ Program=$InputObject.Program } }
}
function Get-NetFirewallServiceFilter {
  [CmdletBinding()] param([Parameter(ValueFromPipeline)]$InputObject)
  process { [pscustomobject]@{ Service=$InputObject.Service } }
}
`;
  const script = `${prelude}\n$problem = ''\ntry {\n${generator().join('\n')}\n} catch { $problem = [string]$_ }\n@{ error=$problem; rules=@($script:rules.ToArray()) } | ConvertTo-Json -Depth 5 -Compress`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout.trim());
}

const windows = process.platform === 'win32';

test('accepts only fixed botLANd names, UDP ports and scopes', () => {
  assert.deepEqual(lines(), buildFirewallApplyLines({ ...input }));
  for (const name of ['botLANd BO1 UDP\'; Remove-NetFirewallRule -Name X; #', 'botLANd Unknown UDP', 'botLANd BO1 UDP\n']) {
    assert.throws(() => buildFirewallApplyLines({ ...input, name }), /Unknown/);
  }
  for (const port of [0, 65536, '28961', 21.5, NaN, Infinity]) {
    assert.throws(() => buildFirewallApplyLines({ ...input, port }), /port/);
  }
  for (const scope of ['Any', 'localSubnet', "any'; throw 'x", 'internet']) {
    assert.throws(() => buildFirewallApplyLines({ ...input, scope }), /scope/);
  }
  for (const scope of ['localsubnet', 'any']) {
    const script = buildFirewallApplyLines({ name: 'botLANd CoD4 UDP', port: 65535, scope }).join('\n');
    assert.match(script, /\$targetPort = '65535'/);
    assert.match(script, /\$targetScope = '(LocalSubnet|Any)'/);
  }
});

test('candidate precedes old rule mutation; removal is last and by immutable Name', () => {
  const script = lines().join('\n');
  const create = script.indexOf('New-NetFirewallRule -PolicyStore PersistentStore');
  const verify = script.indexOf('Assert-ManagedRule (Get-OneByName $candidateName) $pendingName');
  const promote = script.indexOf('Set-NetFirewallRule -PolicyStore PersistentStore -Name $candidateName -NewDisplayName $targetName');
  const remove = script.indexOf('Remove-NetFirewallRule -PolicyStore PersistentStore -Name $oldName');
  assert.ok(create < verify && verify < promote && promote < remove);
  assert.doesNotMatch(script, /Set-NetFirewallRule .* -Name \$oldName/);
  assert.match(script, /\$originals\.Count -gt 1/);
  assert.match(script, /\$active\.Count -ne \$originals\.Count/);
  assert.match(script, /\$rule\.Group -ceq \$owner/);
  assert.match(script, /\$rule\.Description -ceq \$description/);
  // Only assertions about the rule being replaced may accept the legacy fingerprint;
  // the replacement is always checked as strictly botLANd-marked.
  const assertions = script.split('\n').filter(line => /Assert-ManagedRule [(\$]/.test(line) && !line.includes('function'));
  assert.ok(assertions.length >= 6);
  for (const line of assertions) {
    const original = /\$oldName|\$originals\[0\]/.test(line);
    assert.equal(/\$true\b/.test(line), original, line);
  }
  assert.match(script, /\$promotionVerified = \$true/);
  assert.doesNotMatch(script, /netsh|Remove-NetFirewallRule -DisplayName/);
});

test('remove generator requires a unique marked identity and checks active rules after deletion', () => {
  const script = removeLines().join('\n');
  const local = script.indexOf('$originals = @(Get-ExactRules PersistentStore)');
  const active = script.indexOf('$active = @(Get-ExactRules ActiveStore)');
  const nameLookup = script.indexOf('Get-NetFirewallRule -PolicyStore PersistentStore -Name $ruleName');
  const recheck = script.indexOf('$currentActive = @(Get-ExactRules ActiveStore)');
  const remove = script.indexOf('Remove-NetFirewallRule -PolicyStore PersistentStore -Name ([string]$rule.Name)');
  const verify = script.lastIndexOf('Get-ExactRules ActiveStore');
  assert.ok(local >= 0 && local < active && active < nameLookup && nameLookup < recheck && recheck < remove && remove < verify);
  assert.match(script, /\$originals\.Count -ne 1 -or \$active\.Count -ne 1/);
  assert.match(script, /\$rule\.Name -cne \$ruleName/);
  assert.match(script, /\$rule\.Group -cne \$owner/);
  assert.match(script, /\$rule\.Description -cne \$description/);
  assert.match(script, /\$rule\.PolicyStoreSourceType -ne 'Local'/);
  assert.match(script, /Assert-OwnedIdentity \$active\[0\] \$true/);
  assert.match(script, /Assert-OwnedIdentity \$byName\[0\]/);
  assert.doesNotMatch(script, /\$legacy|Remove-NetFirewallRule -DisplayName|foreach \(\$rule in/);
  for (const name of ['botLANd Unknown UDP', "botLANd BO1 UDP'; Remove-NetFirewallRule -Name X; #"]) {
    assert.throws(() => buildFirewallRemoveLines({ name }), /Unknown/);
  }
});

test('mock: remove deletes only the unique marked local rule', { skip: !windows }, () => {
  const { error, rules } = mockRun('normal', [rule()], removeLines);
  assert.equal(error, '');
  assert.deepEqual(rules, []);
});

test('mock: remove refuses absent, duplicate, policy and unmarked rules without writes', { skip: !windows }, () => {
  const cases = [
    [],
    [legacy()],
    [rule('old', input.name, '')],
    [{ ...rule(), Description: '' }],
    [{ ...rule(), Description: 'administrator note' }],
    [rule('one'), rule('two')],
    [rule(), legacy('other')],
    [{ ...rule('policy'), Store: 'GPO' }],
    [rule(), { ...rule('policy'), Store: 'GPO' }],
  ];
  for (const initial of cases) {
    const { error, rules } = mockRun('normal', initial, removeLines);
    assert.notEqual(error, '', JSON.stringify(initial));
    assert.deepEqual(rules, initial);
  }
});

test('mock: remove rechecks ownership and policy before deleting', { skip: !windows }, () => {
  const drift = mockRun('remove-owner-drift', [rule()], removeLines);
  assert.match(drift.error, /ownership changed/);
  assert.equal(drift.rules.length, 1);
  assert.equal(drift.rules[0].Group, 'administrator');

  const policy = mockRun('remove-new-policy', [rule()], removeLines);
  assert.match(policy.error, /changed during removal/);
  assert.equal(policy.rules.length, 2);
  assert.ok(policy.rules.some(item => item.Name === 'old'));

  // A GPO rule can shadow the local rule in ActiveStore, even if it copies
  // the same Name and ownership marker; count and Name checks alone are insufficient.
  const shadow = [rule(), { ...rule(), Store: 'GPO' }];
  const result = mockRun('remove-policy-shadow', shadow, removeLines);
  assert.match(result.error, /not from the local policy store/);
  assert.deepEqual(result.rules, shadow);
});

test('mock: remove reports rules still active after a no-op or new policy rule', { skip: !windows }, () => {
  const noop = mockRun('remove-noop', [rule()], removeLines);
  assert.match(noop.error, /still active/);
  assert.equal(noop.rules.length, 1);

  const policy = mockRun('remove-policy-after-write', [rule()], removeLines);
  assert.match(policy.error, /still active/);
  assert.equal(policy.rules.length, 1);
  assert.equal(policy.rules[0].Store, 'GPO');
});

test('mock: create and update work without losing a rule', { skip: !windows }, () => {
  for (const initial of [[], [rule()]]) {
    const { error, rules } = mockRun('normal', initial);
    assert.equal(error, '');
    assert.equal(rules.length, 1);
    assert.equal(rules[0].DisplayName, input.name);
    assert.equal(rules[0].LocalPort, String(input.port));
    assert.equal(rules[0].RemoteAddress, 'LocalSubnet');
  }
});

test('mock: ambiguous and unmarked rules fail without modification', { skip: !windows }, () => {
  for (const initial of [[rule('old', input.name, '')], [rule(), rule('other')], [rule('old', input.name, 'other-owner')], [{ ...rule(), Protocol: 'TCP' }], [{ ...rule(), RemoteAddress: '0.0.0.0/0' }], [{ ...rule('policy'), Store: 'GPO' }], [rule(), { ...rule('policy'), Store: 'GPO' }]]) {
    const { error, rules } = mockRun('normal', initial);
    assert.notEqual(error, '');
    assert.deepEqual(rules, initial);
  }
});

test('mock: creation and promotion faults retain original and clean candidate', { skip: !windows }, () => {
  for (const original of [rule(), legacy()]) {
    for (const scenario of ['create', 'promote', 'promote-after-write']) {
      const { error, rules } = mockRun(scenario, [original]);
      assert.notEqual(error, '', scenario);
      assert.deepEqual(rules, [original], scenario);
    }
  }
});

test('mock: failed cleanup keeps verified new rule, whether old removal happened or not', { skip: !windows }, () => {
  for (const original of [rule(), legacy()]) {
    for (const scenario of ['cleanup', 'cleanup-after-write']) {
      const { error, rules } = mockRun(scenario, [original]);
      assert.match(error, /New rule is active, but cleanup failed/);
      assert.equal(rules.length, scenario === 'cleanup' ? 2 : 1);
      assert.equal(rules.find(item => item.LocalPort === String(input.port)).DisplayName, input.name);
      if (scenario === 'cleanup') assert.equal(rules.find(item => item.Name === 'old').DisplayName, input.name);
    }
  }
});

test('mock: a rule from the old launcher scripts is replaced by a botLANd-marked one in a single update', { skip: !windows }, () => {
  // Group/Description may come back empty or null depending on how the rule was made.
  for (const unmarked of [{ Group: '', Description: '' }, { Group: null, Description: null }]) {
    const { error, rules } = mockRun('normal', [legacy('{GUID-OLD}', unmarked)]);
    assert.equal(error, '');
    assert.equal(rules.length, 1);
    assert.notEqual(rules[0].Name, '{GUID-OLD}', 'the old rule is gone');
    assert.equal(rules[0].DisplayName, input.name);
    assert.equal(rules[0].Group, 'botLANd.ServerManager');
    assert.equal(rules[0].Description, 'Managed by botLANd Server Manager (UDP)');
    assert.equal(rules[0].LocalPort, String(input.port));
    assert.equal(rules[0].RemoteAddress, 'LocalSubnet');
  }
  // The replacement is managed, so the next update works exactly as before.
  const { error, rules } = mockRun('normal', [legacy('{GUID-OLD}')]);
  assert.equal(error, '');
  assert.equal(mockRun('normal', rules).error, '');
});

test('mock: a legacy-looking rule that differs in any way is still refused and left untouched', { skip: !windows }, () => {
  const cases = {
    'a description but no group': legacy('old', { Description: 'something else' }),
    'a group but no description': legacy('old', { Group: 'other-owner' }),
    'a different owner': legacy('old', { Group: 'other-owner', Description: 'other' }),
    'a program restriction': legacy('old', { Program: 'C:\\game.exe' }),
    'a service restriction': legacy('old', { Service: 'SomeService' }),
    'a remote port': legacy('old', { RemotePort: '80' }),
    'a local address': legacy('old', { LocalAddress: '10.0.0.5' }),
    'a remote range': legacy('old', { RemoteAddress: '10.0.0.0/8' }),
    TCP: legacy('old', { Protocol: 'TCP' }),
    outbound: legacy('old', { Direction: 'Outbound' }),
    block: legacy('old', { Action: 'Block' }),
    disabled: legacy('old', { Enabled: 'False' }),
    'a profile restriction': legacy('old', { Profile: 'Private' }),
  };
  for (const [label, rule1] of Object.entries(cases)) {
    const { error, rules } = mockRun('normal', [rule1]);
    assert.match(error, /not owned by botLANd|unsupported|unsafe/i, label);
    assert.deepEqual(rules, [rule1], label);
  }
  // Duplicates and Group Policy rules are ambiguous even when they look like legacy rules.
  for (const initial of [[legacy('one'), legacy('two')], [legacy('one'), rule('two')], [{ ...legacy('policy'), Store: 'GPO' }], [legacy('one'), { ...legacy('policy'), Store: 'GPO' }]]) {
    const { error, rules } = mockRun('normal', initial);
    assert.notEqual(error, '');
    assert.deepEqual(rules, initial);
  }
});

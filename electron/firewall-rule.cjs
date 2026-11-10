const { profiles } = require('./profiles.cjs');

const managedNames = new Set(Object.values(profiles).map(profile => `botLANd ${profile.short} UDP`));

// Returns statements for Manager.runElevated(lines). Never execute these unelevated:
// NetSecurity writes require administrator privileges. An existing legacy netsh rule
// has no ownership marker and must be reviewed/migrated manually, not replaced.
function buildFirewallApplyLines({ name, port, scope }) {
  if (!managedNames.has(name)) throw new Error('Unknown botLANd firewall rule.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid UDP port.');
  if (scope !== 'localsubnet' && scope !== 'any') throw new Error('Invalid firewall scope.');

  // All interpolated values have been checked against a finite allowlist or a
  // numeric range. Generated GUIDs are created inside the elevated process.
  return [
    `$targetName = '${name}'`,
    `$targetPort = '${port}'`,
    `$targetScope = '${scope === 'localsubnet' ? 'LocalSubnet' : 'Any'}'`,
    "$owner = 'botLANd.ServerManager'",
    "$description = 'Managed by botLANd Server Manager (UDP)'",
    // DisplayName is not an identity: it can be duplicated, including by GPO.
    // Fail closed on ambiguous matches; mutate only a uniquely marked local rule.
    'function Get-ExactRules($store, $display) {',
    '  $lookupErrors = @()',
    '  $found = @(Get-NetFirewallRule -PolicyStore $store -DisplayName $display -ErrorAction SilentlyContinue -ErrorVariable lookupErrors)',
    "  $failure = @($lookupErrors | Where-Object { $_.CategoryInfo.Category -ne 'ObjectNotFound' })",
    '  if ($failure.Count) { throw $failure[0] }',
    '  return @($found | Where-Object { [string]$_.DisplayName -ceq $display })',
    '}',
    'function Get-OneByName($ruleName) {',
    '  $found = @(Get-NetFirewallRule -PolicyStore PersistentStore -Name $ruleName -ErrorAction Stop)',
    "  if ($found.Count -ne 1) { throw 'Firewall rule identity changed.' }",
    '  return $found[0]',
    '}',
    'function Assert-ManagedRule($rule, $display, $localPort, $remote) {',
    "  if ([string]$rule.DisplayName -cne $display -or [string]$rule.Group -cne $owner -or [string]$rule.Description -cne $description) { throw 'Firewall rule is not owned by botLANd.' }",
    "  if ([string]$rule.Direction -ne 'Inbound' -or [string]$rule.Action -ne 'Allow' -or [string]$rule.Enabled -ne 'True' -or [string]$rule.Profile -ne 'Any') { throw 'Firewall rule has unsupported settings.' }",
    '  $ports = $rule | Get-NetFirewallPortFilter -ErrorAction Stop',
    '  $addresses = $rule | Get-NetFirewallAddressFilter -ErrorAction Stop',
    '  $apps = $rule | Get-NetFirewallApplicationFilter -ErrorAction Stop',
    '  $services = $rule | Get-NetFirewallServiceFilter -ErrorAction Stop',
    "  if (@($ports).Count -ne 1 -or [string]$ports.Protocol -notin @('UDP', '17') -or @($ports.LocalPort).Count -ne 1 -or [string]$ports.LocalPort -cne $localPort -or @($ports.RemotePort).Count -ne 1 -or [string]$ports.RemotePort -ne 'Any') { throw 'Firewall rule has unsupported port filters.' }",
    "  if (@($addresses).Count -ne 1 -or @($addresses.LocalAddress).Count -ne 1 -or [string]$addresses.LocalAddress -ne 'Any' -or @($addresses.RemoteAddress).Count -ne 1 -or [string]$addresses.RemoteAddress -cne $remote) { throw 'Firewall rule has unsupported address filters.' }",
    "  if (@($apps).Count -ne 1 -or [string]$apps.Program -ne 'Any' -or @($services).Count -ne 1 -or [string]$services.Service -ne 'Any') { throw 'Firewall rule has unsupported application filters.' }",
    '}',
    '$originals = @(Get-ExactRules PersistentStore $targetName)',
    '$active = @(Get-ExactRules ActiveStore $targetName)',
    "if ($originals.Count -gt 1 -or $active.Count -ne $originals.Count) { throw 'Ambiguous firewall rules: resolve duplicate or policy rules manually.' }",
    '$oldName = $null',
    '$oldPort = $null',
    '$oldScope = $null',
    'if ($originals.Count -eq 1) {',
    '  $oldName = [string]$originals[0].Name',
    '  $oldPorts = $originals[0] | Get-NetFirewallPortFilter -ErrorAction Stop',
    '  $oldAddresses = $originals[0] | Get-NetFirewallAddressFilter -ErrorAction Stop',
    '  $oldPort = [string]$oldPorts.LocalPort',
    '  $oldScope = [string]$oldAddresses.RemoteAddress',
    "  if ($oldPort -notmatch '^[1-9][0-9]{0,4}$' -or [int]$oldPort -gt 65535 -or $oldScope -cnotin @('Any', 'LocalSubnet')) { throw 'Existing rule has unsafe filters; review it manually.' }",
    '  Assert-ManagedRule $originals[0] $targetName $oldPort $oldScope',
    '}',
    "$candidateName = 'botLANd-' + [guid]::NewGuid().ToString('N')",
    "$pendingName = $targetName + ' (pending ' + $candidateName + ')'",
    '$promotionVerified = $false',
    'try {',
    '  New-NetFirewallRule -PolicyStore PersistentStore -Name $candidateName -DisplayName $pendingName -Group $owner -Description $description -Direction Inbound -Action Allow -Enabled True -Profile Any -Protocol UDP -LocalPort $targetPort -RemotePort Any -LocalAddress Any -RemoteAddress $targetScope -ErrorAction Stop | Out-Null',
    '  Assert-ManagedRule (Get-OneByName $candidateName) $pendingName $targetPort $targetScope',
    '  $current = @(Get-ExactRules PersistentStore $targetName)',
    '  $currentActive = @(Get-ExactRules ActiveStore $targetName)',
    "  if ($current.Count -ne $originals.Count -or $currentActive.Count -ne $originals.Count) { throw 'Firewall rules changed during update.' }",
    '  if ($oldName) {',
    "    if ([string]$current[0].Name -cne $oldName -or [string]$currentActive[0].Name -cne $oldName) { throw 'Firewall rule identity changed during update.' }",
    '    Assert-ManagedRule (Get-OneByName $oldName) $targetName $oldPort $oldScope',
    '  }',
    // Keep the original display name intact until the verified candidate is
    // promoted. A failed cleanup then yields visible duplicate-rule drift.
    '  Set-NetFirewallRule -PolicyStore PersistentStore -Name $candidateName -NewDisplayName $targetName -ErrorAction Stop',
    '  Assert-ManagedRule (Get-OneByName $candidateName) $targetName $targetPort $targetScope',
    '  $promoted = @(Get-ExactRules ActiveStore $targetName)',
    "  if ($promoted.Count -ne ($originals.Count + 1) -or @($promoted | Where-Object { [string]$_.Name -ceq $candidateName }).Count -ne 1) { throw 'Candidate rule was not promoted.' }",
    '  $promotionVerified = $true',
    '  if ($oldName) {',
    '    Assert-ManagedRule (Get-OneByName $oldName) $targetName $oldPort $oldScope',
    '    Remove-NetFirewallRule -PolicyStore PersistentStore -Name $oldName -ErrorAction Stop',
    '  }',
    '} catch {',
    '  $failure = [string]$_',
    '  if ($promotionVerified) {',
    "    throw ('New rule is active, but cleanup failed; duplicate rules may remain. Inspect both rules before retrying: ' + $failure)",
    '  }',
    '  $rollbackErrors = @()',
    '  if ($oldName) {',
    '    try { Assert-ManagedRule (Get-OneByName $oldName) $targetName $oldPort $oldScope }',
    '    catch { $rollbackErrors += [string]$_ }',
    '  }',
    '  try {',
    '    $candidate = Get-NetFirewallRule -PolicyStore PersistentStore -Name $candidateName -ErrorAction SilentlyContinue',
    '    if ($candidate) {',
    "      if ([string]$candidate.DisplayName -cnotin @($pendingName, $targetName)) { throw 'Candidate identity changed; it was not removed.' }",
    '      Assert-ManagedRule $candidate ([string]$candidate.DisplayName) $targetPort $targetScope',
    '      Remove-NetFirewallRule -PolicyStore PersistentStore -Name $candidateName -ErrorAction Stop',
    '    }',
    '  } catch { $rollbackErrors += [string]$_ }',
    "  if ($rollbackErrors.Count) { throw ('Firewall update failed; rollback also failed. Inspect the retained original/temporary rules manually: ' + $failure + '; ' + ($rollbackErrors -join '; ')) }",
    '  throw $failure',
    '}',
  ];
}

// Removes the local rules with exactly this botLANd display name, including
// legacy netsh rules created before ownership markers existed. Unlike the old
// netsh call, failures are reported instead of being discarded, and a rule
// that is still active afterwards (for example one pushed by Group Policy)
// is reported rather than shown as removed.
function buildFirewallRemoveLines({ name }) {
  if (!managedNames.has(name)) throw new Error('Unknown botLANd firewall rule.');
  return [
    `$targetName = '${name}'`,
    'function Get-ExactRules($store) {',
    '  $lookupErrors = @()',
    '  $found = @(Get-NetFirewallRule -PolicyStore $store -DisplayName $targetName -ErrorAction SilentlyContinue -ErrorVariable lookupErrors)',
    "  $failure = @($lookupErrors | Where-Object { $_.CategoryInfo.Category -ne 'ObjectNotFound' })",
    '  if ($failure.Count) { throw $failure[0] }',
    '  return @($found | Where-Object { [string]$_.DisplayName -ceq $targetName })',
    '}',
    'foreach ($rule in @(Get-ExactRules PersistentStore)) { Remove-NetFirewallRule -PolicyStore PersistentStore -Name ([string]$rule.Name) -ErrorAction Stop }',
    "if (@(Get-ExactRules ActiveStore).Count) { throw ('A rule named ' + $targetName + ' is still active, probably from Group Policy. Ask your administrator to remove it.') }",
  ];
}

module.exports = { buildFirewallApplyLines, buildFirewallRemoveLines };

# Windows Firewall integration check (manual, opt-in)

This changes Windows Firewall rules and may cause a UAC prompt. Do not run it during a live match or on a machine whose network access you cannot interrupt. The automated suite only tests mocked PowerShell scripts; it never modifies the real firewall.

1. In PowerShell, inspect the existing botLANd rule for the game with `Get-NetFirewallRule -DisplayName 'botLANd CoD4 UDP' -ErrorAction SilentlyContinue | Select-Object Name,DisplayName,Group,Description,Enabled,Direction,Action`. Also inspect its port and address filters with `Get-NetFirewallPortFilter` and `Get-NetFirewallAddressFilter`. Record the current values; do not paste private IP addresses or tokens in a public issue.
2. If no rule exists, open the game's Overview and choose **Create firewall rule**. Approve UAC. Verify the new rule has the correct UDP port, `LocalSubnet` for LAN or `Any` for Public, and the botLANd ownership marker. Test a client connection from the intended network.
3. To test an update, change the game port or visibility in botLANd, then choose **Update firewall rule**. Inspect the new rule and confirm the old named rule is gone. If UAC is canceled or staging fails, the original rule must remain intact. Do not deliberately break a real firewall rule to simulate failure.
4. Older botLANd rules created by `netsh` do not have the new ownership marker and cannot be updated automatically. If the app refuses an update, inspect the rule first; if you are certain it is your botLANd rule, use **Remove rule** explicitly, then **Create firewall rule**. Expect a brief gap in connectivity between those actions.
5. To test removal, explicitly choose **Remove rule** and verify only the selected botLANd display name was removed. Recreate it if you still need inbound access.

Always review other inbound rules for the game or engine. A LAN-scoped botLANd rule does not override a broader rule installed elsewhere.

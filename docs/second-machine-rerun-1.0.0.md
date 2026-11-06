# Second-machine rerun packet for 1.0.0 (not executed)

Status: **not executed for 1.0.0**. The owner accepted the CI-verified artifacts and published 1.0.0 on 2026-11-05 without this second-machine rerun. This packet remains as a regression checklist for a future release; it is **not** evidence of a clean-machine functional pass for 1.0.0.

It covers the lifecycle and config-save changes added after the 0.9.0-rc.1 Phase 5 acceptance. It does not replace the full [clean-machine verification record](clean-machine-verification.md).

Use a **separate Windows 10/11 PC or VM** from the development machine. Prefer a VM snapshot so the installation-disappears check is disposable and reversible. The draft release assets are visible only to repository maintainers, so the owner must supply the two EXEs and `SHA256SUMS.txt` to the tester.

## Artifact under test

| Item | Value |
| --- | --- |
| Version | 1.0.0 |
| Installer | `botLANd Server Manager Setup 1.0.0.exe` (GitHub displays it as `botLANd.Server.Manager.Setup.1.0.0.exe`) |
| Portable | `botLANd Server Manager 1.0.0.exe` (GitHub displays it as `botLANd.Server.Manager.1.0.0.exe`) |
| Source | tag `v1.0.0`, commit `fabe21c3a124dbfd7d5ca9ad2d4e28d9b17656c7` |
| CI run | https://github.com/smeltzzz/botland-server-manager/actions/runs/41966682348 |
| Installer SHA-256 | `645d72e1fd49ebd97d2c35c52133d4929643c2d2badcd513a4c8a85ab634a4b5` |
| Portable SHA-256 | `b0559340cc66390b60f8e42de2f1952d41fa4729d9a263aad1f3e430010892fb` |

Verify before installing:

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath '.\botLANd.Server.Manager.Setup.1.0.0.exe'
# Compare case-insensitively with the installer SHA-256 above.
# SHA256SUMS.txt lists the original space-named CI filenames; compare the hash, not the name.

gh attestation verify '.\botLANd.Server.Manager.Setup.1.0.0.exe' --repo smeltzzz/botland-server-manager
# Confirm the repository, workflow, tag v1.0.0 and commit fabe21c3a124dbfd7d5ca9ad2d4e28d9b17656c7.
```

Do not install or run the build if either check fails. Checksums and attestations prove origin and download integrity, not functional safety.

## Redaction and safety rules

- Never share server keys, private launchers, config contents, command lines, hostnames, IP addresses, GUIDs, or unredacted logs/screenshots.
- Record key status only as **present** or **absent**. Never record a key value.
- Run the disappearance check only on a disposable/test installation or after a VM snapshot. Do not put the only copy of a game install at risk.
- Stop servers through the app and confirm the port is free before reverting the snapshot.
- Do not include local file paths in the final report. Use game names and UDP ports only.

## Record

Record for every check: **Pass**, **Fail**, or **Not exercised**, plus a short redacted note.

- Date:
- Tester initials:
- Windows version and architecture:
- App version shown in the sidebar:
- Display scale and high-contrast setting:
- Second machine type (physical PC / VM):

## A. Install and first launch

1. Verify the SHA-256 and attestation above.
2. Install with the NSIS installer. Launch botLANd.
3. Confirm the sidebar shows version **1.0.0** and the app reaches the dashboard without a startup error.
4. If time permits, repeat the launch with the portable EXE. Both files are release assets; the portable build must not require the installer.
5. Confirm no server, firewall rule, or game file is changed merely by launching the app.
6. Close the app. Confirm no game server process remains.

## B. One full title journey (minimum)

Run this on one title with a working game/engine/config/Bot Warfare setup. If time allows, repeat start/stop and a bot join for the other five titles.

1. Confirm the game is detected and preflight shows the expected ready/blocker state.
2. Start the server. Confirm the app shows **Running** and a Stop control.
3. Confirm the UDP port is bound:

   ```powershell
   Get-NetUDPEndpoint -LocalPort <port> -ErrorAction SilentlyContinue
   ```

4. Join with a compatible client and **visually confirm bots enter a match** if a licensed client is available. Otherwise record **Not exercised**; a bound port alone is not a bot-join pass.
5. Open **Configuration**, change one guided setting, and click **Review changes**:
   - The review dialog takes focus.
   - Tab stays inside the dialog.
   - Escape closes it and focus returns to the **Review changes** button.
6. Save the change:
   - The success notice appears.
   - A timestamped backup appears next to the config file.
   - The saved value is present when Configuration reloads.
7. External-edit guard: open the review dialog again, modify the same config file outside the app (for example, append a comment in Notepad), then click Save. Confirm the app refuses the save because the file changed after preview. Restore the file afterwards.
8. Restart the server and confirm the saved setting takes effect.
9. Stop through the app. Confirm the managed process is gone, the UDP port is free, and the console/log tail shows a stop or exit message.

## C. Running server when its installation disappears (required)

This checks the post-acceptance lifecycle fix. Use a VM snapshot or a disposable install you can restore.

1. Start the server and confirm **Running** plus Stop on both the dashboard card and the game page.
2. Rename the detected game folder (or its multiplayer executable) outside botLANd.
3. Click **Refresh server status**.
4. Expected:
   - The game remains on the dashboard and under **ACTIVE / UNAVAILABLE** in the sidebar.
   - It does **not** move to **Not installed**.
   - The running count still includes it.
   - Stop remains available on the card and game page.
5. Click **Stop**. Confirm the managed process ends and the UDP port is released.
6. Restore the folder name or revert the snapshot. Confirm the game is detected again.

If Stop fails, record the exact UI message and whether the process still exits. Do not kill unrelated processes by port alone.

## D. Completed action with a failed status refresh (best effort)

The renderer distinguishes a completed action from a follow-up status-refresh failure. This path is covered by the built-renderer synthetic smoke (`tests/packaged-smoke.cjs`) and is not reliably reproducible through the normal UI without altering system permissions.

If you can induce an IPC/status failure safely (for example, deny read access to a disposable game folder after an action), confirm the notice says:

> Action completed, but the status could not be refreshed: ... Use Refresh server status to try again.

The action result must remain visible; the app must not claim the action itself failed. Otherwise record **Not exercised** and note that the synthetic smoke covers it.

## E. Config saved but reload failed (best effort)

The manager now reports a successful write separately from a failed reload. This path is covered by `tests/sweep4-fixes.test.cjs` and is not reliably reproducible without a carefully timed file lock or permission change.

If induced, confirm the message says:

> The configuration was saved, but it could not be reloaded. Reopen Configuration to refresh it before making more changes.

Confirm the file content is actually saved, reopening Configuration shows it, and the app does not invite a duplicate save. Otherwise record **Not exercised** and rely on the automated regression test.

## F. Final state and evidence

- [ ] All servers stopped; all tested UDP ports free.
- [ ] Firewall rules created during testing removed through the app.
- [ ] Snapshot reverted or test install removed; no keys or configs left in shared evidence.
- [ ] Results recorded here with only redacted details.
- [ ] Owner reviewed the exact assets, hashes, and attestations.
- [ ] Publish the release only after the owner accepts the results.

### Results

| Check | Result | Redacted note |
| --- | --- | --- |
| A. Install and first launch | | |
| B. Full title journey (title: ____) | | |
| B. Review dialog focus/Escape | | |
| B. Save, backup, reload | | |
| B. External-edit guard | | |
| B. Restart applies setting | | |
| B. Stop/port release | | |
| C. Installation disappears while running | | |
| C. Stop still available | | |
| D. Refresh-failure message | | |
| E. Save-reload-failure message | | |

Additional titles (optional):

| Title | Start/stop | Bot join observed | Notes |
| --- | --- | --- | --- |
| CoD4 | | | |
| MW2 | | | |
| WaW | | | |
| BO1 | | | |
| MW3 | | | |
| BO2 | | | |

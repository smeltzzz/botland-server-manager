# Clean-machine verification checklist

Phase 5 acceptance requires a separate Windows PC or VM. The author's current PC is useful for smoke tests but **does not count as a clean-machine pass**. Do not share keys, launcher files, configs, process command lines or unredacted logs in an issue.

## Preparation

- Use Windows 10 or later, an owned Steam install of the title, and its compatible server engine already installed. Follow the official engine guide; botLANd does not install games or engines.
- Install the current botLANd installer or portable build on this second machine. Record the app version and Windows version without including private user paths.
- If a game is not detected, use **Browse game folder**. Confirm the detected folder contains the multiplayer executable and the matching engine is recognized.
- For Plutonium titles, paste a server key into botLANd's masked field. Confirm only **Key stored** appears; do not copy the key into a report. Optionally import from a private launcher only after explicit consent.
- If Bot Warfare is missing, click **Install Bot Warfare**. Confirm the source/version and archive SHA-256 are shown, the expected mod files appear in the installation, and no upstream `.bat` or script ran. Do not overwrite a customized mod without reviewing the backup warning.
- If a base config is missing, click **Create starter config**. Confirm it did not overwrite an existing file; MW3 and BO2 need their separate mode-rule files and executable `exec` of generated rotations.
- Choose a mode, installed map pool, UDP port and LAN/Public visibility. Resolve all readiness blockers. Inspect the Windows Firewall and router separately; a Public switch is not a reachability test.

## Per-title journey

Repeat on the second machine for each game separately. Before each Start, confirm the port is free and no server from a legacy script is running. Start from the app, wait for the game server to bind its UDP port, and use **Copy** on the appropriate local interface address. Join with a compatible game client and **visually confirm bots enter a match**. Change one guided setting via Preview/Commit, restart and verify it takes effect; inspect the byte-for-byte backup. Stop through the app, verify the process and port are gone, and record whether the console or log-file tail showed useful output. A server that merely binds its port is not a bot-join pass.

| Title | Engine to confirm | Special checks |
|---|---|---|
| CoD4 | Cod4R/IW3x `Cod4R-DedRun.exe`, not CoD4x | `mods/mp_bots`, patched callback, `-nogui`; public listing needs the IW3x hosting guide's tokens/firewall |
| WaW | Plutonium T4 | T4 mod IWD in Plutonium storage, key stored |
| MW2 | IW4x | `userraw/z_svr_bots.iwd`, `sv_lanonly` follows visibility, 18-slot cap |
| BO1 | Plutonium T5 | `mod.ff` and IWD; no `-lan` launch flag, so use a LAN-scoped firewall rule for LAN privacy |
| MW3 | Plutonium IW5 | `admin/*.dsr` mode, `exec server_live.cfg`, IW5 storage mod, 18-slot cap |
| BO2 | Plutonium T6 | two maps minimum, matching `gamesettings/*.cfg` with `set_gametype`, both T6 scripts, 18-slot cap |

## Evidence and status

For each title record: detected install, engine, key status (present/absent only), Bot Warfare version and SHA-256, config/starter result, preflight, port bound, local client connected, **bots observed in-game by the user**, Stop/port released, and any blockers. Redact hostnames, IPs, GUIDs, passwords, tokens and local paths before sharing. A broken step needs a reproducible fix and a second-machine rerun.

### Earlier current-PC-only record (before outside testing, 2026-11-04)

- **Current PC only:** all six game installs and engines detected; existing Bot Warfare files and configs pass preflight. WaW, BO1, MW3 and BO2 keys were explicitly imported to encrypted per-user storage with the user's permission; values were not displayed or logged.
- **Current PC only:** CoD4 (UDP 28962), WaW (28963), MW2 (28964), BO1 (28961), MW3 (27016) and BO2 (4976) each bound their port and stayed up briefly when launched by the manager. Each was stopped by the manager and the ports were free afterward. This does **not** establish client connectivity, public listing, or bots joining.
- **Packaging smoke on the current PC:** a temporary unpacked Windows build completed outside `release/`. A later isolated local `0.9.0-rc.1` build produced both unsigned NSIS and portable EXEs without pruning `release/`; its `app.asar` contains the Electron main process, diagnostics module, renderer, MIT license and production `fflate` dependency. The packaged EXEs have not been installed or run on a second machine, and this is not a CI-attested release.
- **At that time, pending:** no second PC or VM was available. Packaged install journey, in-game bot joins and real firewall/UAC integration were not yet signed off. This historical local-only record did not establish Phase 5 acceptance.

### User-reported Phase 5 acceptance (2026-11-04)

The user subsequently confirmed that a **separate Windows PC/VM** tested the **local unsigned 0.9.0-rc.1 packaged build**: the install/portable journey, client connections and **bots visibly joining matches in all six titles**, guided edit/backup and Stop/port-release checks, and real firewall/UAC checks. The user explicitly accepted Phase 5 based on those results. This records the user's attestation; no keys, launcher files, logs, IPs, private paths, or independent test artifacts were collected in this repository.

| Title | Second-machine bot-join outcome |
|---|---|
| CoD4 (Cod4R/IW3x target) | Passed, as confirmed by the user |
| WaW | Passed, as confirmed by the user |
| MW2 | Passed, as confirmed by the user |
| BO1 | Passed, as confirmed by the user |
| MW3 | Passed, as confirmed by the user |
| BO2 | Passed, as confirmed by the user |

This acceptance applies to the tested **0.9.0-rc.1 local build**. The published 1.0.0 installer and portable EXE were built by tagged CI from commit `fabe21c3a124dbfd7d5ca9ad2d4e28d9b17656c7`, matched the published SHA-256 checksums and passed GitHub build-provenance verification. They were **not** installed on a second machine. The owner approved carrying Phase 5 acceptance across the reviewed version-only runtime delta. The 1.0.0 source also contains post-acceptance lifecycle and error-handling fixes: running servers remain visible and stoppable when an installation disappears, completed actions are distinguished from status-refresh failures, and a saved config that cannot be reloaded is reported without inviting a duplicate save. These changes do not alter launch commands or networking behavior. Their affected UI and config-save journeys were not rerun on a second machine; the owner accepted the CI-verified artifacts for publication without that rerun. Automated tests and the synthetic packaged smoke cover those paths, but they are not a clean-machine functional pass.

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

### Status as of 2026-11-04

- **Current PC only:** all six game installs and engines detected; existing Bot Warfare files and configs pass preflight. WaW, BO1, MW3 and BO2 keys were explicitly imported to encrypted per-user storage with the user's permission; values were not displayed or logged.
- **Current PC only:** CoD4 (UDP 28962), WaW (28963), MW2 (28964), BO1 (28961), MW3 (27016) and BO2 (4976) each bound their port and stayed up briefly when launched by the manager. Each was stopped by the manager and the ports were free afterward. This does **not** establish client connectivity, public listing, or bots joining.
- **Packaging smoke:** a temporary unpacked Windows build completed outside `release/`. Its `app.asar` contains the Electron main process, installer module, renderer, MIT license, and production `fflate` dependency. The NSIS/portable install journey has not been run on a second machine.
- **Pending:** no second PC or VM is available yet. Packaged install journey, real in-game bot joins for the current build, and real firewall/UAC integration are not signed off. Phase 5 is not accepted until the user confirms the second-machine results.

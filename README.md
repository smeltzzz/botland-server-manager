# botLANd Server Manager

Windows desktop app for configuring and launching six Call of Duty bot servers. The existing batch and PowerShell scripts are **not modified** by the app. botLANd launches the installed executables directly and generates each game's live map-rotation config when you click Start.

> **Pre-1.0 setup:** This release still requires your own installed games, compatible server engines, Bot Warfare mods, existing configs, and legacy server launch scripts. It does not install any of those or provide a one-click first-run setup yet. Do not copy private launch scripts into this repository.

## Requirements

- Windows 10 or later; owned Steam installs of the games you want to host.
- Compatible engines already set up: Cod4R/IW3x for CoD4, IW4x for MW2, and [Plutonium](https://plutonium.pw/docs/install/) for WaW, BO1, MW3, and BO2. Follow the respective engine's official installation guide. botLANd does not distribute game or engine files.
- The matching Bot Warfare mod from [ineedbots](https://github.com/ineedbots), already installed for each game you want to host. In-app installation is planned for 1.0.
- For this release, the corresponding legacy server-script folders and configs; Plutonium titles need your own server keys in the private launch scripts. Keep these scripts and keys outside the repository.

## What works

- Dashboard with setup checks, per-game controls, running status and live output.
- Select the game install folder and the folder containing the six server-script folders.
- Guided, game-specific Bot Warfare settings based on the six ineedbots repositories. BO2's 0–3 difficulty scale and 0–1 fill modes are separate from the other titles; BO1 exposes its native `bot_difficulty` setting.
- Edit server, bot and match settings in the existing configs. MW3 `.dsr` and BO2 `gamesettings/*.cfg` files have their own mode-rule editors. A searchable advanced view exposes existing directives, masking secret values.
- Preview individual changes before saving. Every changed config gets a byte-for-byte timestamped backup; unrecognized settings, comments, includes and line endings are retained. Saves are refused if a file changed after preview.
- Display cover and hero art directly from the local Steam library cache, or choose your own JPG/PNG/WebP images (up to 6 MB). Images are never bundled in the installer; original abstract art is used when none is available.
- Select installed maps, a supported game mode, shuffling and a UDP port. The app writes the correct engine-specific rotation at launch; BO2 only lists multiplayer rulesets that declare a matching `set_gametype`, excluding Zombies files.
- Flip each server between **LAN only** and **Public** with a per-game switch on the game page (the dashboard cards show the current visibility). The switch only changes the launch arguments — CoD4 `dedicated 1→2`, MW2 `sv_lanonly 1→0`, and Plutonium's `-lan` flag present or absent — and applies at the next start. Public mode removes the LAN restriction; it does not guarantee a listing in every game's server browser. Players joining from outside the local network additionally need the UDP port opened or forwarded in the network router's settings — the firewall rule and the app can only cover this PC.
- Manage the matching **Windows Firewall rule** per server from the Overview tab (one UAC prompt per create/update/remove). The rule allows inbound UDP for the chosen port, scoped to the local subnet in LAN mode and to any address in Public mode. botLANd only ever touches the single rule named `botLANd <Game> UDP` and leaves every other rule alone. A firewall rule applies immediately — even mid-match — and unlike the launch switch, it takes effect on already-running servers. While a server is running, its rule targets the port that server was launched with; after changing the port, update the rule once the server restarts. Rule status is read with the NetSecurity PowerShell cmdlets, so it works on any Windows display language. For BO1 the firewall rule is the real LAN guard, because its launch profile cannot pass `-lan`, so BO1's rule is always scoped to the local subnet.
- Launch and stop only processes started by this app. It checks for a UDP port already in use (IPv4 and IPv6 listeners; if Windows' `netstat` cannot be run, the server still starts and the game reports any bind failure) and requires confirmation before stopping servers on app exit.
- Plutonium server keys are read **in memory** from the original launchers and never stored in the app's preferences or intentionally printed to the UI.

## Run locally

1. Install Node.js 22 or later and run `npm install` in this folder.
2. Run `npm run dev` for the desktop development build.
3. Run `npm test` and `npm run build` to validate changes.
4. Run `npm run dist:win` for NSIS and portable Windows executables under `release/`. After both executables are built successfully, the command removes older versioned botLANd installers, portable EXEs and their blockmaps from that folder. These unsigned local builds may trigger a Windows SmartScreen prompt.

For a browser-only **design preview** during development, open the Vite URL without Electron. It uses simulated servers; start/stop in that preview does not launch a game. The Electron desktop window uses the real local installations.

The packaged app initially looks for server scripts under `GameServers` in your Documents folder. Use **Change folder** in the lower left to point it to your own scripts folder. Existing game paths are read from the matching legacy `.bat` launchers until you select a different folder. Existing saved preferences take precedence; the app migrates settings from the old capitalization of its user-data folder without overwriting current settings.

## Important notes

- The original `.bat` files still contain plaintext Plutonium keys; this app does not remove or rotate them. Keep those launchers private and rotate keys if they have been shared. The game executable still receives the key through its command line, as it does with the existing launchers.
- Stopping uses Windows `taskkill /T /F` against the process started by botLANd and its descendants. It is not an in-game graceful shutdown. Other servers are never intentionally targeted.
- Existing generated rotation files are replaced on start. If you need to preserve a hand-edited rotation, copy it elsewhere first.
- BO1's existing launch pattern lacks Plutonium's `-lan` argument, so it always launches public; add the LAN firewall rule from the Overview tab to actually restrict it. Never assume a server is private solely because it runs on your own PC.
- The IW5 launcher and botLANd both pass `-lan` and use UDP 27016 by default. For a LAN client, connect to the server's private IP and port; no router port forwarding is needed. Review all existing Windows Firewall rules before relying on LAN-only access: other inbound rules may still allow access from public networks.
- Config changes and launch options take effect on the next start, not in a running match. Installed maps and game mode support differ between games; map lists are checked again at launch.
- MW3/IW5 uses the game folder selected in the UI (or the path from `5-MW3-Server/!start_mp_server.bat`), `admin/server.cfg`, the selected `admin/*.dsr`, and Bot Warfare's `mods/bots/z_svr_bots.iwd` in either that game folder or Plutonium IW5 storage. `server.cfg` must actively `exec server_live.cfg`; botLANd generates that rotation on Start. PE architecture alone is not a reliable compatibility test; an executable can still fail at launch for other reasons. Restore missing runtime files from a compatible installation rather than copying DLLs from an unrelated game.
- The game-specific fields are based on upstream documentation; settings absent from your installed config are shown as defaults until you explicitly edit them. BO2 `gts` and MW3 `gameOpt` rules are only edited in their real mode files; the BO2 include directives and comments remain untouched.
- Secret values in the advanced editor are masked in the UI and change preview. Replacing a secret still stores it in the game's plaintext config and its backup, as required by those game servers; keep those files private.
- The status cards track processes started by this app. A server started from a batch file is not adopted; a port check will block starting a second server on the same UDP port.
- The console is a per-session, in-memory view. Bot installation/update, automatic restart and secure migration of legacy keys are not yet included.

## Credits and legal

botLANd is an independent community project, not affiliated with or endorsed by Activision, Plutonium, or the Bot Warfare authors. Game titles and trademarks belong to their respective owners. You must provide your own licensed game and engine installations.

Bot Warfare is created by [ineedbots](https://github.com/ineedbots). Upstream repositories: [CoD4 (IW3)](https://github.com/ineedbots/iw3_bot_warfare), [WaW (T4)](https://github.com/ineedbots/t4_bot_warfare), [MW2 (IW4)](https://github.com/ineedbots/iw4_bot_warfare), [BO1 (T5)](https://github.com/ineedbots/t5_bot_warfare), [MW3 (IW5)](https://github.com/ineedbots/iw5_bot_warfare), and [BO2 (T6)](https://github.com/ineedbots/t6_bot_warfare). Their files are not bundled or redistributed by botLANd. The Barlow font's OFL license is in [`src/assets/OFL.txt`](src/assets/OFL.txt).

botLANd itself is licensed under [MIT](LICENSE). See [CONTRIBUTING.md](CONTRIBUTING.md) for development and [SECURITY.md](SECURITY.md) for private security reporting. Never publish your Plutonium key, launch scripts, live configs, logs, or unredacted screenshots.

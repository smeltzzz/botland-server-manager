# Changelog

Notable changes to botLANd Server Manager are recorded here. This project follows [Semantic Versioning](https://semver.org/).

## 1.2.7

- BO1/T5 now requires a verified public inbound UDP firewall rule instead of a LAN-only rule. Existing BO1 rules can be updated on the Overview tab; BO1's rule cannot be removed while its server is active. Public access still requires router port forwarding and does not guarantee a server-browser listing.

## 1.2.6

- Moved Cod4R DedRun and IW4x Install/Update buttons from game Overviews into the bottom-left sidebar, alongside Plutonium. Setup checklists now point there and retain the official guide links.

## 1.2.5

### Explicit CoD4 and MW2 engine setup

- Added Install/Update controls for the Cod4R DedRun server executable and the official IW4x launcher. Engine downloads are restricted to official sources, pinned to exact SHA-256 digests and sizes, and never happen automatically on Start.
- The CoD4 action updates only DedRun; use the IW3x hosting guide for required client and fast-file updates. The MW2 action invokes the IW4x launcher with `--skip-launch` after an explicit confirmation; it may update additional IW4x-managed files.
- Engine work blocks same-game Start, restart, folder changes and Bot Warfare changes. Existing unknown executables require confirmation; failed or interrupted external IW4x updates retain a journal and block Start rather than attempting an incomplete rollback.

## 1.2.4

- Fixed BO1 LAN firewall readiness and unsafe firewall-rule removal; hardened Plutonium updater integrity and concurrency and key redaction at log truncation boundaries.
- Preserved unsaved configuration/rotation drafts after an installation disappears and improved map-scan recovery, setup action availability, accessibility and narrow layouts.

## 1.2.3

### Firewall

- Fixed "The firewall change failed: Firewall rule is not owned by botLANd." after pressing Update firewall rule. Rules made by the old launcher scripts (same `botLANd <Game> UDP` name, no owner or description) can now be replaced in one click with **Replace with botLANd rule**. The replacement is created and verified as a botLANd-owned rule before the old one is removed; only a rule with that exact fingerprint qualifies, and duplicates, Group Policy rules and any other unmarked rule are still refused.
- **Remove rule** now stays available whenever a rule exists, including a mismatched or old-launcher rule. Previously it was hidden whenever the rule did not match the server's visibility and port, so such a rule could not be cleared from the app.
- The panel explains when an existing rule came from the old launcher, and that it allows connections from any address.

## 1.2.2

### Bot Warfare

- Removed previous managed versions. Install, Update and Reinstall now always provide the latest Bot Warfare and overwrite every Bot Warfare file in place, including files you edited, waypoints that already existed and unrecognized mods. Nothing is kept as a backup and the **Previous managed version** list and **Restore previous** button are gone.
- Version history folders (`.botland-versions-*`) left by earlier releases are deleted automatically the next time that game's Bot Warfare is checked, installed or removed.
- An interrupted or failed install still rolls back to the files that were there before it started. Remove still skips a managed file you edited.

## 1.2.1 (2026-11-10)

### Plutonium keys

- Fixed the unusable server-key paste when stored keys cannot be read. The key store now reports why (unreadable, damaged, or encryption unavailable), and the paste form stays available to replace an unreadable key.
- **Reset key storage** keeps a damaged `keys.json` aside instead of discarding it.
- The green **Paste key** button now explains what is wrong instead of doing nothing.
- A failed key save restores the previously stored key.

## 1.2.0 (2026-11-10)

Standalone-setup release. It also carries the bug-fix and polish work from sweeps 7 and 8; see [`docs/sweep-7-plan.md`](docs/sweep-7-plan.md). (Previously tracked here as "1.1.1 (unreleased)".)

### Standalone setup

- botLANd is now the only tool needed to set up and run servers. The legacy scripts folder setting and **Import from legacy launcher** were removed; keys are pasted on the game page. An old scripts folder saved in settings is ignored.
- Each game page has a click-by-click setup checklist (find the game, engine, Plutonium, server key, Bot Warfare, server config, maps, firewall rule, Start). Dashboard cards show **Finish setup** instead of a disabled Start.
- botLANd installs and updates Plutonium itself using the official, SHA-256-pinned updater: automatically before a Plutonium server starts (at most every six hours) and from the sidebar's **Update Plutonium** button.
- Server cards use the wide Steam hero art with the game's logo instead of a cropped portrait cover, and the game page header shows more of its artwork.
- The Configuration tab no longer overflows sideways when the config file path is long.

### Fixed

- Stop and Cancel start stay available for every server while another action (a Bot Warfare download, a firewall prompt, a folder picker) is in progress.
- An install interrupted before its journal was written no longer blocks every Bot Warfare action until a hidden folder is deleted by hand.
- A failed update check (offline or rate limited) is retried after about 10 minutes instead of being cached for 18 hours, which could also disable CoD4 development installs.
- Stray files or a half-deleted version in the Bot Warfare version history no longer break status, install, remove or restore.
- A successful Bot Warfare install is no longer reported as failed when only the final cleanup fails; real rollback failures name their cause and journal folder.
- Crash recovery works when the game folder path differs only in letter case.
- Config backups can be listed, restored and pruned for games reached through a junction (for example, moved to another drive). Symbolic or hard-linked config files are refused with a clear message instead of being silently replaced.
- MW3 and BO2 no longer fail the rotation `exec` check when their base config is saved as UTF-16.
- Config saves and backup restores of the same file can no longer interleave.
- Read-only or locked config folders report a clear message on save and restore; pruning reports how many backups were removed when some cannot be.
- A completed restore or starter-config creation is no longer reported as failed when only the status refresh fails.
- The remainder of an over-long server output line is discarded instead of being logged without its setting name, and player GUIDs in `games_mp.log` event lines are redacted.
- A UAC prompt left open past the timeout reports that the firewall change may still apply, and the rule status is re-read after any firewall error.
- Removing a firewall rule asks for confirmation, with explicit wording for Black Ops, whose rule is its only LAN guard.
- The restart panel's attempt number matches the console, and a restart blocked by preflight no longer claims the retry limit was reached.
- Key import shows why it failed and is disabled until a scripts location is chosen.
- Update-check status is shown in plain language instead of internal codes.
- The configuration tab no longer flashes an error when it opens, and offers Retry when a config cannot be opened.
- Long values in the save review wrap instead of being clipped.
- A server's own socket is no longer reported as a possible unmanaged process while it is starting or stopping.
- Remove and Restore no longer clear the Bot Warfare update badge incorrectly.
- Session logs keep working when an old log file is locked, and stop retrying after a failed write.
- Smaller wording and accessibility fixes: "Save 1 change", "Takes effect the next time the server starts", "Set up", Black Ops visibility explanation for screen readers, Console tab available for a running server whose folder disappeared, and covers that survive one unreadable image.

## 1.1.0 (2026-11-07)

Bug-fix and polish release. Full-pass error, bug, UI and UX sweep; see [`docs/sweep-5-plan.md`](docs/sweep-5-plan.md) and [`docs/sweep-6-plan.md`](docs/sweep-6-plan.md).

### Fixed

- Redact secrets printed with `seta`, `sets`, `setu`, `+seta` and quoted bare console commands in session logs, not just `set` and `+set`.
- Read and save UTF-16LE/UTF-16BE configs while preserving their BOM, byte order and line endings.
- Create missing starter configs on game folders formatted without hard-link support, such as exFAT and FAT.
- Re-arm periodic possible-orphan scanning when a quit-time stop cannot stop every server.
- Find Steam artwork when Steam is installed outside the default Program Files location.
- Accept `set KEY = VALUE` and quoted launcher assignments in addition to the original legacy syntax.
- Prompt before closing the window when a configuration or rotation draft has unsaved edits.
- Possible-unmanaged-process warnings no longer print "PID null". When the owning process
  cannot be identified (the two address families disagree, or one query failed), the
  warning now says so plainly and the snapshot type admits a missing PID.
- Dashboard server cards respond to a click again. The cards were styled as clickable and
  every control inside them stopped event propagation, but the card itself had no handler,
  so clicking the artwork, title or body did nothing.
- A renderer exception now shows a recovery screen with a reload button instead of leaving
  a blank window.
- The connect-address panel asks you to choose an interface when several are available
  instead of claiming no address exists.
- A map search with no matches no longer suggests checking your game folder.
- Cover and header artwork can be reset independently, so restoring Steam art for one no
  longer discards a custom image chosen for the other.
- The browser preview uses each title's real game mode names (CoD4/MW2 `war`, WaW/BO1
  `tdm`, IW5 ruleset names) instead of one shared list.
- The server launch control now displays a disabled "Stopping…" stop button when a server is stopping instead of abruptly flipping to a disabled "Start server" button. While a launch is being cancelled, the button now indicates "Cancelling…".
- The server console status and terminal indicator accurately report `STARTING` and `STOPPING` instead of claiming the server is `OFFLINE` and `IDLE` during startup and shutdown.
- Ambiguous UDP listeners (`pid: null`) on a port belonging to a running managed server are no longer falsely reported as unmanaged rogue processes.
- The connect address panel now correctly directs the user to "Choose an interface above" when multiple network adapters are available.
- Enforce the 18-slot limit on both player slots and bot fill targets in the configuration workspace and browser demo for MW2, MW3, and BO2.
- Clearing or backspacing an unset configuration field without a schema default is no longer falsely marked as a dirty edit.
- Localize Bot Warfare manifest and version timestamps in the UI instead of rendering raw ISO 8601 strings.
- Add dismiss buttons to configuration notices in the configuration workspace.
- Accurately track active ports in the browser preview fixture for simulated server runs and firewall checks.

### Changed

- The test suite also runs on non-Windows developer checkouts: config-fixture cleanup no
  longer leaves `LOCALAPPDATA` set to the literal string `undefined`, and the Windows path
  and registry assertions are pinned or platform-gated instead of failing off Windows.

## 1.0.0 (2026-11-05)

First public release.

- Detect installed Steam games and compatible server engines, with a manual game-folder fallback and first-run checklist.
- Launch and stop servers directly without the legacy launch scripts. Plutonium keys can be saved with Electron `safeStorage` or explicitly imported from a private launcher.
- Create missing starter base configs without overwriting existing files, including the required MW3/BO2 rotation execs.
- Install, update, reinstall, remove, and restore Bot Warfare for all six games, with official-source ZIP validation, the Cod4R `clientid` patch, per-file backups and rollback, preserved user-edited waypoints, and release-update checks.
- Edit server, bot, match, and mode settings with preview tokens, byte-for-byte backups, preserved encodings and line endings, and protection against saving over external changes. Restore or prune individual config backups on request.
- Build per-game map rotations, enforce title-specific slot caps, switch each server between LAN-only and Public launch modes, and manage matching Windows Firewall rules.
- Copy local connect addresses, follow source-labelled file logs, keep bounded redacted session logs, opt in to crash restart with backoff, use Cod4R console-first graceful stop, and show read-only possible-orphan warnings.
- Journal Bot Warfare file changes for interrupted-update recovery, stage confirmed firewall replacements before removing previously marked rules, and keep running servers controllable if an installation disappears.
- Package NSIS and portable Windows executables, published with SHA-256 checksums and GitHub build-provenance attestations.

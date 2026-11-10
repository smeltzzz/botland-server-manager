# Changelog

Notable changes to botLANd Server Manager are recorded here. This project follows [Semantic Versioning](https://semver.org/).

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

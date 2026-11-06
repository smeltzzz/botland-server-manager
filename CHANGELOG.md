# Changelog

Notable changes to botLANd Server Manager are recorded here. This project follows [Semantic Versioning](https://semver.org/).

## Unreleased

Full-pass error, bug, UI and UX sweep; see [`docs/sweep-5-plan.md`](docs/sweep-5-plan.md).

### Fixed

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

# Changelog

Notable changes to botLANd Server Manager are recorded here. This project follows [Semantic Versioning](https://semver.org/); pre-1.0 behavior may change between minor releases.

## Unreleased (1.0.0 source candidate; not published)

Phase 5 was explicitly accepted by the user for the local 0.9.0-rc.1 packaged build after reported second-machine testing of all six titles. The 1.0.0 binaries, CI checksums/attestations and public release are not yet complete.

- Begin the public-repository foundation: licensing, contribution and security guidance, automated checks, and code-quality tooling.
- Detect installed Steam games and compatible server engines, with a manual game-folder fallback and first-run checklist.
- Remove the legacy launcher requirement for starting servers. Plutonium keys can be saved with Electron safeStorage or explicitly imported from a private launcher.
- Create missing starter base configs without overwriting existing files, including required MW3/BO2 rotation execs.
- Add opt-in Bot Warfare install/update/reinstall/remove/restore for all six games, with official-source ZIP validation, Cod4R clientid patch, per-file backups/rollback, preserved user-edited waypoints, and release-update checks.
- Add per-game connection-address Copy, source-labelled file log tailing, bounded redacted session logs, opt-in crash restart with backoff, Cod4R console-first graceful stop, read-only possible-orphan warnings, and transactional config backup restore/prune.
- Journal Bot Warfare file changes for interrupted-update recovery and stage verified firewall replacements before removing previously marked rules.
- Enforce the 18-player cap for MW2, MW3 and BO2 in guided config validation; document a manual Windows Firewall/UAC integration check.
- Begin pre-1.0 polish: keyboard/focus improvements for configuration reviews, an allowlisted Copy diagnostics summary, synthetic README screenshots, and a gated release-candidate checklist. Phase 5 clean-machine acceptance remains pending.
- Harden lifecycle and save error handling: keep running servers visible and stoppable if an installation disappears, distinguish completed actions from status-refresh failures, recover cleanly when a saved config cannot be reloaded, and show a startup error when the packaged preload bridge is missing.

## 0.2.7

- Local Windows desktop manager for six Call of Duty bot servers, with guided config editing, map rotations, launch/stop controls, and firewall rules.
- Preserves config encodings and creates backups on transactional saves.
- Still requires existing game/engine installs and legacy launch scripts; first-run detection, secure key storage, and Bot Warfare installation are planned, not yet available.

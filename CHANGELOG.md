# Changelog

Notable changes to botLANd Server Manager are recorded here. This project follows [Semantic Versioning](https://semver.org/); pre-1.0 behavior may change between minor releases.

## Unreleased

- Begin the public-repository foundation: licensing, contribution and security guidance, automated checks, and code-quality tooling.
- Detect installed Steam games and compatible server engines, with a manual game-folder fallback and first-run checklist.
- Remove the legacy launcher requirement for starting servers. Plutonium keys can be saved with Electron safeStorage or explicitly imported from a private launcher.

## 0.2.7

- Local Windows desktop manager for six Call of Duty bot servers, with guided config editing, map rotations, launch/stop controls, and firewall rules.
- Preserves config encodings and creates backups on transactional saves.
- Still requires existing game/engine installs and legacy launch scripts; first-run detection, secure key storage, and Bot Warfare installation are planned, not yet available.

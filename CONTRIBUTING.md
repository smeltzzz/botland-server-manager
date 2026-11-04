# Contributing

Thanks for helping improve botLANd. Before opening a pull request, search existing issues and describe the change you propose.

## Development

- Use Windows and Node.js 22 or later. From this repository root, run `npm ci`, `npm test`, and `npm run build`. Run `npm run lint` and `npm run format:check` when available.
- Keep changes limited to this app. Do not include game installs, Plutonium/engine files, downloaded Bot Warfare mods, or private launch scripts.
- Use temporary fixtures for tests. Never use a live game install as a test target, and do not start game servers from automated tests.
- Preserve transactional config saves, byte-for-byte backups, and secret masking. New Electron IPC actions need matching preload, main-process, and renderer API changes.
- Add or update tests for behavior changes. Describe any manual verification in your PR.

## Protect private data

Legacy launcher scripts may contain plaintext Plutonium keys. Never commit them, game configs, logs, secrets, personal paths, or screenshots that expose private data. Use synthetic placeholders in issues and tests. Do not paste keys into issue comments or PRs. If you suspect a vulnerability, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Licensing

By contributing, you agree that your contributions are licensed under this repository's [MIT License](LICENSE). Credit third-party authors and respect their licenses; do not vendor game, engine, or Bot Warfare files.

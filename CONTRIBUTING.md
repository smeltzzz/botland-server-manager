# Contributing

botLANd is maintained with direct commits to `main`; pull requests are not used. Before starting work, search existing issues and describe the change you propose.

## Development

- Use Windows and Node.js 22 or later. From this repository root, run `npm ci`, then `npm run dev` for the desktop development build.
- Run `npm test`, `npm run build`, `npm run lint`, and `npm run format:check` before committing.
- Keep changes limited to this app. Do not include game installs, Plutonium/engine files, downloaded Bot Warfare mods, or private launch scripts.
- Preserve transactional config saves, byte-for-byte backups, and secret masking. New Electron IPC actions need matching preload, main-process, and renderer API changes.
- Do not commit generated `dist/` or `release/` output.

## Protect private data

Old batch launchers may contain plaintext Plutonium keys. Never commit them, game configs, logs, secrets, personal paths, or screenshots that expose private data. Use synthetic placeholders in issues and screenshots. Do not paste keys into issues or commits. If you suspect a vulnerability, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Licensing

By contributing, you agree that your contributions are licensed under this repository's [MIT License](LICENSE). Credit third-party authors and respect their licenses; do not vendor game, engine, or Bot Warfare files.

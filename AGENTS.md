# AGENTS.md — botLANd Server Manager

## Quick context

- Windows desktop app (Electron main process + React/TS renderer) that configures and launches six Call of Duty bot servers: CoD4, WaW, MW2, BO1, MW3, BO2.
- This repo is `ServerManager/` (in this checkout under `D:\GameServers`). The app is the only way servers are set up and launched: there are no batch launchers or legacy script folders, and no code reads them. It writes configs/rotations into the _installed game folder_.
- Setup is click-by-click: each game's Overview has a setup checklist driven by the snapshot's per-game `setup` flags (`folder`, `engine`, `plutonium`, `key`, `bots`, `config`, `maps`; `null` = not applicable), computed in `check()`.
- Direct commits to `main`; PRs are not used (see `CONTRIBUTING.md`). CI runs on push to `main` and tags `v*`.
- Runtime state lives in Electron `userData` under `%APPDATA%` (`settings.json`, `keys.json`, `botwarfare-sources.json`, `session-logs/`), not in the repo. Old settings in `%APPDATA%\BotLANd Server Manager` are migrated on launch (`migrateSettings` in `main.cjs`).

## Commands (repo root)

| Command                  | Purpose                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci` / `npm install` | Install deps (Node 22+).                                                                                                                          |
| `npm run dev`            | Vite on `127.0.0.1:5173` (`strictPort`) + Electron. Opening the Vite page without Electron uses `src/demo.ts` fixtures; it never launches a game. |
| `npm run build`          | `tsc --noEmit && vite build`. Typechecks only `src` + `vite.config.ts`; `electron/*.cjs` is not typechecked.                                      |
| `npm run lint`           | ESLint over `src`, `electron`, `scripts`, `tests`, `vite.config.ts`, `eslint.config.mjs`.                                                         |
| `npm run format:check`   | Prettier check limited to `.prettierrc.json`, `eslint.config.mjs`, `.github`.                                                                     |
| `npm test`               | Node test runner: `node --test tests/*.test.cjs` (no game install or network needed).                                                 |
| `npm run dist:win`       | Build + electron-builder (NSIS + portable) → `release/`, then prune old artifacts.                                                                |

- Before committing (per `CONTRIBUTING.md` + CI): `npm test`, `npm run build`, `npm run lint`, `npm run format:check`.
- Single test file: `node --test tests/core.test.cjs`
- Single case: `node --test --test-name-pattern="renders engine-specific rotations" tests/core.test.cjs`
- `npm run format` has no file glob and fails (`prettier --write` exits 2). Use `npm run format -- <paths>` or `npx prettier --write <paths>`. Source is intentionally not globally Prettier-formatted; do not reformat the repo.
- Smoke tests need `npm run build` first:
  - `node_modules\.bin\electron.cmd tests\packaged-smoke.cjs` — synthetic data, read-only IPC, never loads a real install.
  - `node_modules\.bin\electron.cmd tests\visual.cjs` — optional; uses real local setup data. Screenshots only with `BOTLAND_VISUAL_SCREENSHOTS=1`.

## Architecture

| File                    | Role                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `electron/main.cjs`     | App/window lifecycle, the single `manager:action` IPC switch, `manager:event` broadcasts      |
| `electron/manager.cjs`  | `ServerManager`: state, detection, launch/stop, config/rotation/backup/firewall orchestration |
| `electron/preload.cjs`  | `window.manager` (`ManagerApi`), context-isolated bridge                                      |
| `electron/profiles.cjs` | Per-title source of truth: config, rotation, executable, port, default mode |
| `electron/schema.cjs`   | Editable settings schema + upstream source repos                                              |
| `electron/maps.cjs`     | Map scanning, mode discovery, rotation generation                                             |
| `electron/config.cjs`   | Config parse/preview/commit, secret masking, encoding/BOM/line-ending preservation            |
| `electron/artwork.cjs`  | Steam cache artwork + custom images                                                           |

Other main-process modules, grouped by feature:

- Detection/setup: `detection.cjs` (Steam registry + `libraryfolders.vdf`), `starter-config.cjs`.
- Bot Warfare: `botwarfare-source.cjs` → `botwarfare-download.cjs` → `botwarfare-recipes.cjs` → `botwarfare-install.cjs`, plus `mod-archive.cjs`. Explicit, upstream-only, SHA-256/inspection-checked, journaled installs. Install/Update/Reinstall always overwrite every managed file with the latest version; there is deliberately no version history, snapshot or Restore (leftover `.botland-versions-*` folders from old releases are deleted). Keep the transaction journal: it only rolls back an interrupted install, it does not retain old versions.
- Plutonium: `plutonium-update.cjs` downloads the pinned official updater from `cdn.plutonium.pw` and runs `plutonium.exe -update-only` (visible window, no pipes — it hangs otherwise). It runs before a Plutonium launch at most every 6 h, is skipped while another Plutonium server or the Plutonium launcher is open, closes only the launcher process it spawned, and only blocks a launch when Plutonium is not installed.
- CoD4/MW2 engines: the **bottom-left sidebar** (not game Overviews) exposes `engine-update.cjs`'s **explicit-only** CoD4R DedRun binary installation (pinned official IW3x bytes, not client/fast files) and IW4x updating via a pinned official launcher ZIP run with `--skip-launch --no-self-update --no-shortcuts --no-connect-protocol`. Do not update either on Start. The external IW4x launcher can change additional client files outside botLANd's control; if it fails or is interrupted after starting, retain its journal and block future Start for manual inspection rather than rolling back only some files. Never bundle engine binaries or commit `.botland-engine-stage-*` recovery folders.
- Config/runtime: `config-backups.cjs`, `session-logs.cjs` + `log-tail.cjs`, `connect-address.cjs`, `orphan-detect.cjs`, `diagnostics.cjs`, `key-store.cjs`, `firewall-rule.cjs`.

Renderer:

- `src/App.tsx` is the main UI; `src/ConfigWorkspace.tsx` is the configuration editor.
- State is snapshot-driven: call `window.manager`, then rely on `manager:event` state broadcasts (`App.tsx` subscribes via `window.manager.subscribe`).
- `src/demo.ts` implements `ManagerApi` for the browser preview; `src/main.tsx` only loads it when `window.manager` is absent and `import.meta.env.DEV`.

**Adding IPC**: add the preload method, a `case` in `main.cjs`'s `manager:action` switch, and the `ManagerApi` signature in `src/types.ts`. Main also validates the sender window/frame; keep payload validation in the switch. Events use `manager:event` + `subscribe`.

## Critical invariants (do not break)

- **Transactional config saves**: `previewSettings` returns a 64-char SHA-256 token; `commitSettings` requires it, rejects writes after external edits or a changed `expectedPath`, writes a byte-for-byte `.bak-*`, and preserves encoding (UTF-8/UTF-16 with BOM), BOM and line endings. Tests cover concurrent/external edits.
- **Secrets**: Plutonium keys are pasted by the user, stored via Electron `safeStorage` (Windows DPAPI) in `keys.json`, never included in snapshots/logs/IPC responses, and fail closed if encryption is unavailable. `rcon_password` and GUIDs are masked by `config.cjs`; game configs/backups still contain plaintext secrets by game requirement.
- **Rotations**: generated on every Start and overwrite the profile's rotation file. Never hand-edit them. MW3/BO2 base configs must `exec` the generated rotation or launch preflight blocks.
- **Process management**: only processes spawned by this app are managed. Stop = Cod4R `quit` on its console pipe first, then `taskkill /T /F` for the owned PID; other engines use `taskkill`. Orphans are reported read-only and never adopted/killed. UDP conflicts are checked via `netstat -ano -p udp` for IPv4 and IPv6; auto-restart refuses an unknown port state.
- **Title-specific rules stay in profiles/schema/maps**: CoD4 `dedicated 1→2`, MW2 `sv_lanonly 1→0`, Plutonium `-lan` present/absent (BO1 has no `-lan`). BO2 needs at least two maps; MW3/BO2 mode files are `.dsr`/`gameSettings/*.cfg`; MW3 caps at 18 slots and requires `fs_game mods/bots`.
- **BO1 LAN**: cannot pass `-lan`; its Windows Firewall rule is the real LAN guard and must stay scoped to the local subnet. Firewall rules are applied through elevated PowerShell NetSecurity cmdlets; only rules named `botLANd <Game> UDP` are touched. A rule is replaced only if botLANd-marked, or (original rule only) it has the exact old-launcher fingerprint: empty Group and Description plus every filter botLANd would write. The replacement is always created and verified strictly marked before the old rule is removed; duplicates and Group Policy rules fail closed.
- **Config/launch options apply on the next Start**, not mid-match. Firewall rule changes apply immediately.
- **Single instance**: a second app instance quits and focuses the first.

## CI (`.github/workflows/ci.yml`)

On push to `main` and tags `v*`: `npm ci` → `npm test` → `npm run build` → packaged smoke → `npm run lint` → `npm run format:check` → `npm audit --audit-level=high` → Gitleaks full-history scan.

Tag releases (`v*`) additionally require the tag to equal `v<package.json version>`, run `npm run dist:win`, verify exactly two EXEs (installer + portable), write `release/SHA256SUMS.txt`, upload provenance attestations, and upload the EXEs + checksums as a workflow artifact. CI does **not** create a GitHub Release; publishing is a separate owner decision. Builds are unsigned, so SmartScreen warnings are expected. `dist/` and `release/` are generated/gitignored; use `npm run build` for routine verification mid-work, and `dist:win` only at the end of a sweep (see below).

## End of every sweep (required)

A "sweep" is a batch of fixes/features the user asks for. When one is finished, always do all of the following without being asked, in order, and stop to report if any step fails:

1. `git fetch origin`. If `origin/main` has commits that local `main` lacks, stop and ask before doing anything else (never force-push).
2. Bump the patch version: `npm version patch --no-git-tag-version` (e.g. 1.2.0 → 1.2.1). Use a minor bump only if the user asks for one.
3. Run `npm test`, `npm run build`, `npm run lint`, `npm run format:check`. All must pass.
4. Commit the sweep's changes plus `package.json`/`package-lock.json` to `main` with a descriptive "Sweep N: …" message. Never commit protected data (see below).
5. `npm run dist:win` to rebuild the installer and portable exe in `release/`.
6. Create an annotated tag matching the version: `git tag -a v<version> -m "Release <version>"`.
7. `git push origin main`, then `git push origin v<version>`. CI then builds the tag and uploads the exes + `SHA256SUMS.txt` as a workflow artifact (it does not publish a GitHub Release).
8. Confirm `git status -sb` shows `main...origin/main` with nothing ahead/behind, then report the version, the exe paths in `release/`, and the pushed commit/tag.

## Testing quirks

- Node's built-in test runner, CommonJS (`tests/*.test.cjs`); no Jest/Vitest.
- Launch/lifecycle tests intercept `node:child_process` through `Module._load`; preserve that seam.
- Temp dirs use `%LOCALAPPDATA%\Temp\opencode` with an `os.tmpdir()` fallback; tests clean up after themselves.
- `electron/*.cjs` is not typechecked, so tests are its safety net. `tsconfig.json` has `noUnusedLocals`/`noUnusedParameters`; unused code fails `npm run build`.
- The suite is expected to pass off Windows too: platform-specific paths/registry/firewall assertions are gated or pinned. Don't add unguarded Windows-only assumptions.
- `tests/packaged-smoke.cjs` and `tests/visual.cjs` are not picked up by the `*.test.cjs` glob.

## Protected data (never commit)

- Game installs, engine files, downloaded Bot Warfare mods.
- Private launch scripts (may contain plaintext Plutonium keys), live configs/backups, logs, keys, personal paths, unredacted screenshots.
- `.gitignore` already excludes `settings.json`, `keys.json`, `botwarfare-sources.json`, `session-logs/`, `.botland-stage-*`, `.botland-versions-*`, `*.bak-*`, `dist/`, and `release/`.

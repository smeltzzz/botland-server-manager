# Full-pass application sweep — November 2026

## Plan

1. Establish a clean baseline with the complete Node test suite, ESLint,
   TypeScript/Vite production build, and formatting check.
2. Review the renderer's navigation and interactions (keyboard access, focus, error
   recovery, transient lifecycle states, responsive behavior, loading/empty/error states).
3. Cross-check the Electron window/preload/IPC boundary and exercise the backend's
   behavior through its existing adversarial/integration tests: config writes
   and backups, process lifecycle/restarts, firewall changes, keys/secrets, mod archives,
   downloads, orphan detection, and path/symlink handling.
4. Fix defects with clear user-facing consequence, add regression checks, then
   rerun the full validation suite.

## Baseline

- `npm test`: 245 pass, 0 fail, 2 skipped.
- `npm run lint`: clean (ESLint).
- `npm run build`: clean (TypeScript and Vite production build).
- `npm run format:check`: clean for the repository's configured formatting scope.
- `packaged-smoke.cjs` & `visual.cjs`: passed.

## Findings and fixes

| # | Severity | Area | Finding | Resolution |
|---|---|---|---|---|
| 1 | P0 | Lifecycle / Launch Control | When a server was stopping, `launchControl` flipped abruptly to a disabled green "Start server" with a Play icon while the server process was still shutting down. When cancelling a launch, the button remained labeled "Cancel start" instead of displaying "Cancelling…". | Handled `stopping` in `launchControl`, keeping the stop-button styling with a disabled "Stopping…" label. When `cancelling === target.id`, displayed "Cancelling…". |
| 2 | P1 | UI / Console Status | While a server was starting or stopping, `.console-state` and `.terminal-live` falsely claimed the server was `OFFLINE` and `● IDLE`. | Updated `.console-state` and `.terminal-live` to accurately reflect `STARTING` ("● STARTING") and `STOPPING` ("● STOPPING") along with `RESTARTING` and `running`, adding an orange attention dot indicator. |
| 3 | P1 | Main Process / Orphan Detection | A running managed server could falsely flag itself as an unmanaged rogue process when netstat returned an ambiguous PID (`pid: null`). `owned` only checked `instance.child?.pid === orphan?.pid`, which evaluated to `false` when `orphan.pid` was `null`. | Recognized that when a managed server is running on its active port (`activePort`), an ambiguous orphan finding for that same port represents its own listening socket, filtering out the false warning. Added regression tests in `tests/sweep6-fixes.test.cjs`. |
| 4 | P2 | Connect Panel Copy | In `ConnectPanel`, when multiple network interfaces were available and none chosen, the code block read "Choose an interface below", but the select dropdown was positioned directly above it. | Updated placeholder text to "Choose an interface above". Added assertion in `tests/packaged-smoke.cjs`. |
| 5 | P2 | Config / Demo Slot Limits | In `ConfigWorkspace.tsx`, guided view only capped `sv_maxclients` at 18 for MW2/MW3/BO2, omitting `bots_manage_fill`. In `src/demo.ts`, `demoFields` allowed up to 64 for both fields. | Enforced the 18-slot engine cap for both `sv_maxclients` and `bots_manage_fill` in `ConfigWorkspace.tsx` and dynamically in `demo.ts`. |
| 6 | P2 | Config Workspace / Unset Fields | Backspacing an unconfigured field with no schema default marked the field as dirty (`changeCount = 1`) and offered to save an empty string to disk because `"" !== undefined` evaluated to `true`. | Compared `value !== (original ?? '')` so clearing an unset field is properly recognized as unmodified. |
| 7 | P2 | Bot Warfare Dates | In `BotPanel`, manifest and backup versions rendered raw unformatted ISO 8601 timestamps (e.g. `2026-10-20T12:00:00.000Z`). | Added a localized `formatDate` helper in `App.tsx` matching `backupDate` in `ConfigWorkspace.tsx`. |
| 8 | P3 | UI Status Indicators | In `StateChip` and sidebar `nav-status`, `starting` and `stopping` states fell back to `ready` (gray) or showed no indicator dot, and unavailable active games hardcoded `online` even when stopping or restarting. | Mapped `starting`, `stopping`, and `restarting` to the amber `attention` chip and indicator dot across both detected and unavailable navigation items. |
| 9 | P3 | Config Notice Dismissal | Configuration notices in `ConfigWorkspace.tsx` lacked a dismiss button, remaining permanently on screen until another action occurred. | Added a dismiss button (`<X size={15} />`) to `config-notice` and updated `config.css` with flex layout. |
| 10 | P3 | Browser Demo / Active Port | In `src/demo.ts`, starting a simulated server updated `status` and `pid`, but never set `game.activePort`, and stop never cleared it. Firewall status and apply also ignored `activePort`. | Assigned `game.activePort = game.options.port` in `start()`, cleared it in `stop()`, and updated firewall mocks to check `activePort ?? options.port`. |

## Verification

Final state after the sweep:

| Check | Before | After |
| --- | --- | --- |
| `npm test` | 245 pass / 0 fail / 2 skipped | **247 pass / 0 fail / 2 skipped** |
| `npm run lint` | clean | clean |
| `npm run build` | clean | clean |
| `npm run format:check` | clean | clean |
| `tests/packaged-smoke.cjs` | passed | passed (with new stopping, starting, and connect assertions) |
| `tests/visual.cjs` | passed | passed |

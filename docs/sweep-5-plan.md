# Full-pass error, bug, UI and UX sweep — botLANd 1.0.0

Scope: every shipped module (`electron/`, `src/`), the IPC bridge, the test suite and CI.
Goal: find real defects, fix the ones that are provably wrong, and keep the suite green.

## Method

1. **Baseline.** Install dependencies, then run `npm test`, `npm run lint`, `npm run build`.
   Record every failure before changing anything, so regressions cannot hide in a
   pre-existing red suite.
2. **Read every module end to end**, not just the diff surface: main process (manager,
   config, backups, installer, download, archive, detection, log tail, session logs, key
   store, firewall, maps, orphan detection, diagnostics), preload/IPC contract, and both
   renderers (`App.tsx`, `ConfigWorkspace.tsx`, `demo.ts`).
3. **Probe behaviour instead of trusting the comments.** Small throwaway scripts drive the
   modules with adversarial input: ambiguous `netstat` output, multiple network
   interfaces, duplicate dvars, CRLF/Latin-1 configs, unclosed block comments.
4. **Cross-check docs against code.** Every claim in `README.md`/`CHANGELOG.md` about
   firewall scope, restart backoff, redaction, retention limits and clipboard behaviour was
   matched against the implementation.
5. **Static UI review** of markup, ARIA, focus handling, copy and affordances (no browser
   runtime is available in this environment, so the renderer was reviewed by reading the
   components and the minified CSS).

## Baseline

| Check | Result |
| --- | --- |
| `npm test` | 226 pass, 6 fail (all Windows-only test assumptions), 5 skipped |
| `npm run lint` | clean |
| `npm run build` (tsc + vite) | clean |

The 6 failures are not product defects: they assert Windows path/registry semantics
(`path.isAbsolute('D:\\…')`, `%LOCALAPPDATA%`) and run on Linux here. CI runs on
`windows-latest`, where they pass. They are still worth fixing, because a suite that is
red on a developer's non-Windows checkout is a suite nobody trusts.

## Findings

Severity: **P0** wrong output/crash, **P1** misleading or unavailable recovery, **P2**
papercut, **P3** consistency. Status is updated as fixes land.

| # | Sev | Area | Finding | Status |
| --- | --- | --- | --- | --- |
| 1 | P0 | Renderer / orphan warnings | `findPossibleOrphans` deliberately returns `pid: null` when the PID is ambiguous (two families disagree, or one query failed). Three render sites print it raw, so the UI shows **"PID null"** on the game page, the dashboard banner and the server card. The type said `pid: number`, hiding the bug from `tsc`. | Fixed |
| 2 | P0 | Renderer / dashboard | Server cards use `cursor:pointer` and a hover lift, and every control inside them calls `event.stopPropagation()`, but the card itself has **no click handler**. Clicking the artwork, title or body does nothing. | Fixed |
| 3 | P1 | Renderer / crash recovery | There is no React error boundary. Any render-time exception leaves a blank dark window with no message and no recovery path. | Fixed |
| 4 | P2 | Renderer / connect panel | With more than one candidate interface and none chosen, the address box reads **"No address available"** even though the select directly above lists several. | Fixed |
| 5 | P2 | Renderer / maps | When a map search matches nothing, the empty state says **"Check your game folder"** — misleading, because the folder is fine; the filter simply matched nothing. | Fixed |
| 6 | P2 | Renderer / artwork | "Use Steam art" silently resets **both** the cover and the header, so resetting one custom image destroys the other. Per-kind reset was already supported by the main process. | Fixed |
| 7 | P3 | Renderer / browser preview | The Vite demo returns the same mode list for every game, so CoD4/MW2 offer `tdm` and never `war`; the desktop app offers `war`. Previewing the UI teaches the wrong model. | Fixed |
| 8 | P3 | Tests | `tests/phase2.test.cjs` assumes `%LOCALAPPDATA%` exists; `tests/core.test.cjs` and `tests/detection.test.cjs` assume Windows path semantics on every platform. | Fixed |

### Verified sound (no change)

These were probed or traced and behaved as documented:

- **Config writes.** Duplicate dvars update only the last (effective) assignment; comment
  suffixes, line endings, BOM and Latin-1 are preserved; adding to a file without a
  trailing newline does not glue lines together; an unterminated `/*` refuses the save
  rather than hiding the edit.
- **Secret handling.** `key`, `*_key`, `*guid`, `rcon*`, `*password*` are masked in the
  document, the preview and the change list; log redaction covers `set`/`+set`, `name=value`
  and `Authorization:` headers, plus literal key substitution.
- **Restart policy.** Five backoff steps, a ten-minute crash window, cutoff, suppression on
  deliberate Stop, and no retry when an install is busy — all match the README.
- **Firewall.** Read status uses enum values (display-language independent), duplicates are
  reported as drift, staging/rollback is fail-closed, and BO1 is always LAN-scoped.
- **Port checks.** Both address families are queried; a single successful query can prove
  occupancy; a fully failed query blocks automatic restart but allows manual start.
- **Bot Warfare installs.** Journal validation, `before`/`after` hashing, symlink refusal,
  waypoint preservation and manifest ownership rules held up under inspection.
- **IPC.** The single `manager:action` channel validates sender frame, payload shape and
  every game id through `profileFor`.

## Verification

Final state after the sweep:

| Check | Before | After |
| --- | --- | --- |
| `npm test` | 226 pass / 6 fail / 5 skipped | **236 pass / 0 fail / 6 skipped** |
| `npm run lint` | clean | clean |
| `npm run build` | clean | clean |
| `npm run format:check` | clean | clean |

- New regression tests in `tests/sweep5-fixes.test.cjs`:
  - an ambiguous orphan keeps its warning with an explicitly unknown PID, and `null`
    survives snapshot serialization;
  - an orphan whose PID matches a managed server is still filtered out;
  - resetting one artwork kind leaves the other custom image in place;
  - per-title gametype names stay distinct (CoD4/MW2 `war`, WaW/BO1 `tdm`) so the
    browser preview can mirror them.
- The renderer changes are typechecked and reviewed against the packaged smoke test
  (`tests/packaged-smoke.cjs`), which drives the real built renderer in CI: the card
  click relies on the existing `stopPropagation()` calls in the Start/Stop and Manage
  buttons, and the error boundary only renders on a caught exception, so the smoke
  selectors are unchanged.
- Electron cannot run in this environment (no display server), so the UI was verified by
  static review plus `tsc`; the Windows CI job runs the packaged renderer smoke test.

## Suggested follow-up (not changed here)

- `snapshot()` re-reads every game config and rescans map folders on each broadcast; the
  once-a-minute orphan refresh therefore does a full scan. Caching per game path would cut
  idle CPU, but it is a behavioural change worth measuring first.
- `ConfigWorkspace` and `App` each carry a private copy of the IPC error-unwrapping regex;
  a shared helper would prevent them drifting apart.

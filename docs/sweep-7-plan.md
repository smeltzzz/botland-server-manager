# Full-pass application sweep 7 — November 2026

## Plan

1. Commit the outstanding sweep 6 work separately, then record a clean baseline.
2. Review the backend in parallel: process lifecycle and IPC; config saves and backups;
   Bot Warfare download, install, journal recovery and update checks.
3. Review the renderer for bugs, wrong state labels, missing confirmations, accessibility
   and wording.
4. Fix every confirmed defect with user impact, plus smaller polish and refactors. Add
   regression tests and rerun the full validation suite.

## Baseline

- `npm test`: 249 tests, 247 pass, 0 fail, 2 skipped.
- `npm run lint`, `npm run build`, `npm run format:check`: clean.
- `tests/packaged-smoke.cjs`: passed.

## Findings and fixes

| # | Severity | Area | Finding | Resolution |
|---|---|---|---|---|
| 1 | P1 | Bot Warfare / Recovery | A stage folder abandoned before its journal was written (crash, or a failed cleanup after an early error) made every later status, install, remove and restore fail with "Invalid transaction journal" until the hidden folder was deleted by hand. | A stage with no journal and only preparation entries is deleted on recovery, since no game file was touched yet. Anything unexpected still fails closed, and the error now names the folder. Early-cleanup failures no longer hide the original error. |
| 2 | P1 | Bot Warfare / Update checks | A failed check (offline, rate limited) was cached as fresh for 18 hours. At startup without network this hid update badges, and for CoD4 development it disabled install with no way to retry. | Only successful checks advance the cache time; failures retry after about 10 minutes. The settings text no longer claims checks are skipped offline. |
| 3 | P1 | Renderer / Stop | Every action shared one busy flag, so a long Bot Warfare download, a firewall UAC prompt or a folder picker disabled Stop (and could swallow a Stop click) for every running server. | Stop and Cancel start are tracked per game and never wait on the global busy flag. The button shows "Stopping…" while a stop is in flight. |
| 4 | P2 | Bot Warfare / History | A file such as `desktop.ini` or a half-pruned version in the version-history folder broke status and every Bot Warfare action, including Remove. | Unrecognised or damaged history entries are skipped. Pruning moves an old version into the disposable `.done` namespace before deleting it. |
| 5 | P2 | Bot Warfare / Commit | A failed deletion of the resolved journal after a successful commit was reported as a failed install, and a successful rollback could be reported as "rollback failed". | Deleting the resolved `.done` folder is best effort (recovery already retries it). A real rollback failure now reports both causes and the journal location. |
| 6 | P2 | Config / Junctions | Saves worked through a junctioned game folder (common for games moved to another drive), but the backups panel refused those paths, so every save created a backup that could never be listed, restored or pruned. | Backup operations resolve the folder's real location first. Saves refuse symbolic or hard-linked config files with a clear message instead of silently replacing the link. |
| 7 | P2 | Config / Launch preflight | The MW3/BO2 rotation `exec` check read the base config as UTF-8, so a correct UTF-16 config blocked Start. | The check decodes the file the same way the editor does. |
| 8 | P2 | Config / Concurrency | Saves and backup restores of the same file used separate queues, leaving a check-then-rename gap between them. | Both share one per-file queue (`withConfigLock`). |
| 9 | P2 | Bot Warfare / Recovery | The journal's folder was compared case-sensitively, so a crash followed by a differently cased game path made recovery impossible. | Paths are compared case-insensitively on Windows. |
| 10 | P2 | Logs / Redaction | When an over-long server output line was cut, its remainder was logged as a separate line, which could expose a secret without its setting name. | The rest of an omitted line is discarded up to the next newline, as the file tail already did. |
| 11 | P2 | Logs / Redaction | Player GUIDs in `games_mp.log` event lines (`J;<guid>;…`, `K;…`) were not redacted, though the README promises GUID redaction. | Hex GUID fields in join, quit, kill, damage, weapon and chat event lines are redacted. |
| 12 | P2 | Firewall | A UAC prompt left open past the 2-minute timeout was reported as a plain failure even though approving it later still changes the rule. | The timeout is reported as "the change may still apply"; the renderer re-reads the rule status after any firewall error. |
| 13 | P2 | Firewall / BO1 | Remove rule had no confirmation; for BO1 it removes the only LAN guard immediately. | Removal asks for confirmation, with explicit wording for BO1. |
| 14 | P2 | Renderer / Restart panel | The panel showed "Restart attempt N+1" while the console said attempt N, and showed "Retry limit reached" even when a retry was blocked by preflight, a port check or a spawn error. | The attempt number matches the console; the cutoff text says automatic restart stopped and points to the console for the reason. |
| 15 | P2 | Renderer / Key import | Import showed a generic failure for "no scripts folder" and "no key found", and was enabled without a scripts location. | The main process's fixed guidance is shown; Import is disabled with a hint until a scripts location is chosen. |
| 16 | P2 | Renderer / Update status | Internal codes (`cached`, `not-modified`, `rate-limited`, `disabled`…) were shown to users. | Mapped to plain-language status text in the settings list and the Bot Warfare panel. |
| 17 | P2 | Renderer / Config | The configuration tab flashed "could not be opened" on every open, and that message pointed to a folder "above" that is not on the tab. | Starts in the loading state; the failure message points to the Overview tab and offers Retry. |
| 18 | P2 | Renderer / Review dialog | Long values in the save review were clipped with no way to see them. | Values wrap and carry a tooltip. |
| 19 | P3 | Config | Backup write failures (read-only folder) and restore failures showed raw `EPERM` text; a failed refresh after a restore or starter-config creation reported the completed write as failed; pruning stopped at the first locked backup without saying how many were removed. | Friendly read-only/in-use messages, refresh failures ignored after a completed write, and pruning reports "Removed X of N". |
| 20 | P3 | Config | The save token was not bound to the file path, so two byte-identical mode files shared a token. Invalid UTF-16 files threw a raw `TypeError`. | The token includes the resolved path; invalid UTF-16 reports a readable message. |
| 21 | P3 | Bot Warfare | Remove and Restore cleared the "update available" badge; the SHA-256 mismatch message gave no next step. | The badge becomes unknown and is rechecked in the background; the mismatch message says nothing was installed and to retry. |
| 22 | P3 | Lifecycle | The exit line was logged after the restart message; session cleanup was registered only after the instance slot was freed, so an immediate Start could lose its session log; a failed disk append kept retrying on every line; a locked old session file disabled disk logging for the new session. | Exit logged first; cleanup registered before the slot is released; a failed append ends disk logging for that session; retention pruning is best effort. |
| 23 | P3 | Orphan detection | Only `running` servers owned their port, so a scan during start or stop could flag the server's own socket; the snapshot check used the wrong game's port as a fallback. | One `ownsListener` helper treats starting, running and stopping instances as owners and is used by both the scan and the snapshot. |
| 24 | P3 | IPC | Copying a connect address with a malformed payload said "Start this server"; the copy check used a different network-interface source than the displayed list. | Separate "Invalid connect address" error; both use the manager's interface source. |
| 25 | P3 | Renderer polish | Bot Warfare status errors hid the real reason; a failed mod action did not refresh the panel; "Save 1 changes"; "Restart the server to apply" also shown for stopped servers; "Setup" used as a verb; Console tab locked for a running server whose folder disappeared; one failed cover image dropped every cover and covers were not re-read after a rescan; BO1 "PUBLIC ONLY" explanation only in a tooltip; BO1 start log said "LAN"; the Update button gave no reason when disabled; the update list said "Not checked yet" with checks off. | All corrected. |

### Not changed

- Bare executable names (`netstat.exe`, `taskkill.exe`, `powershell.exe`, `reg`): existing tests pin these names through the `child_process` seam; resolving full System32 paths is left for a dedicated change.
- An "exited unexpectedly" status field and showing the running server's active visibility need new snapshot fields; deferred.

## Verification

| Check | Before | After |
| --- | --- | --- |
| `npm test` | 247 pass / 0 fail / 2 skipped | **255 pass / 0 fail / 2 skipped** |
| `npm run lint` | clean | clean |
| `npm run build` | clean | clean |
| `npm run format:check` | clean | clean |
| `tests/packaged-smoke.cjs` | passed | passed |
| `tests/visual.cjs` | — | passed |

New and updated regression tests: `tests/sweep7-fixes.test.cjs`, plus cases in
`tests/botwarfare-install.test.cjs`, `tests/botwarfare-source.test.cjs`,
`tests/session-logs.test.cjs`, `tests/config-backups.test.cjs` (junction behaviour),
`tests/phase4-integration.test.cjs` and `tests/phase4-ipc.test.cjs`.

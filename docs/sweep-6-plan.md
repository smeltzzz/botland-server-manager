# Full-pass application sweep — November 2026

## Plan

1. Establish a clean baseline with `npm ci`, the complete Node test suite, ESLint,
   TypeScript/Vite production build, formatting check, and dependency audit.
2. Review the renderer's navigation and interactions (keyboard access, focus, error
   recovery, responsive behavior, loading/empty/error states, and irreversible actions).
3. Cross-check the Electron window/preload/IPC boundary and exercise the backend's
   high-risk behavior through its existing adversarial/integration tests: config writes
   and backups, process lifecycle/restarts, firewall changes, keys/secrets, mod archives,
   downloads, and path/symlink handling.
4. Fix only defects with a clear user-facing consequence, add a regression check, then
   rerun the full validation suite. Do not apply broad dependency downgrades or reformat
   the repository as part of a product UX sweep.

## Baseline

After installing the lockfile with `npm ci`:

- `npm test`: 236 passed, 0 failed, 6 skipped.
- `npm run lint`: clean.
- `npm run build`: clean (TypeScript and Vite production build).
- `npm run format:check`: clean for the repository's configured formatting scope.
- `npm audit --omit=dev`: 0 production dependency vulnerabilities.
- Full `npm audit`: 15 moderate advisories in development/build tooling (no high or
  critical advisories). npm's suggested automatic fix requires a breaking downgrade;
  the production dependency tree is clean, so the sweep does not force a tooling
  downgrade without compatibility testing.

## Finding and fix

| Severity | Area | Finding | Resolution |
| --- | --- | --- | --- |
| P2 | Dashboard accessibility | Server cards respond to pointer clicks, but the card surface itself was not keyboard-focusable or keyboard-activatable. The nested Manage button worked, but keyboard users could not use the card's broader click target, and its pointer affordance had no focus equivalent. | Made the card a labelled focusable group, added Enter/Space activation and a visible focus ring. Extended the packaged renderer smoke test to assert its role/label/tab stop and both keyboard activations. |

## Reviewed and retained

- The startup fallback and React error boundary provide recovery instead of a blank window.
- The packaged smoke suite already exercises the 640-DIP layout, navigation focus,
  dialog focus trap/return, refresh failures, running servers whose install disappears,
  and map-cache invalidation.
- Renderer actions surface recoverable errors and avoid exposing key-related IPC errors.
- The Electron window keeps context isolation, sandboxing, denied navigation/new windows,
  permission denial, and a sender/frame-validated single IPC entry point.
- Existing tests cover transactional config writes and restores, secret masking, stale
  previews, process lifecycle races, restart policy, port checks, firewall scope,
  archive validation/rollback, and download host/size/hash restrictions.

## Verification limitations

The packaged Electron smoke test requires a desktop display. This environment has no
`Xvfb`/display server, so the changed smoke scenario is added for the Windows CI desktop
run; local validation uses TypeScript, lint, and the complete Node test suite. No real game
processes or user configuration files were launched or changed during this sweep.

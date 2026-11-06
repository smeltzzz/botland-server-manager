# 1.0.0 release checklist (published 2026-11-05)

The [Phase 5 record](clean-machine-verification.md#user-reported-phase-5-acceptance-2026-11-04) documents the user's explicit acceptance of the local 0.9.0-rc.1 packaged build. The published 1.0.0 artifacts are CI-built. The owner authorized their publication without a second-machine rerun of the post-acceptance lifecycle/config-save changes. This page records the completed checks and the remaining limitations.

## Published artifacts

- Release: https://github.com/smeltzzz/botland-server-manager/releases/tag/v1.0.0
- Source: tag `v1.0.0`, commit `fabe21c3a124dbfd7d5ca9ad2d4e28d9b17656c7`
- CI run: https://github.com/smeltzzz/botland-server-manager/actions/runs/41966682348
- Installer SHA-256: `645d72e1fd49ebd97d2c35c52133d4929643c2d2badcd513a4c8a85ab634a4b5`
- Portable SHA-256: `b0559340cc66390b60f8e42de2f1952d41fa4729d9a263aad1f3e430010892fb`
- `SHA256SUMS.txt` SHA-256: `302502987a032e7e34aac63b2b9b7867ebd6a830a7f943f75b31be597e921c41`

## Completed before publication

- [x] Reviewed the app-only diff, images and docs for secrets, personal paths and bundled game/engine/mod files. CI scanned the full Git history with Gitleaks.
- [x] Committed the 1.0.0 source with matching `package.json`/lockfile versions and recorded commit `fabe21c3a124dbfd7d5ca9ad2d4e28d9b17656c7`. The owner explicitly authorized the public push and tag.
- [x] The Windows CI `verify` job passed install, tests (2 skipped), typecheck/build, the synthetic built-renderer smoke, lint, workflow/tooling format check, audit and secret-history scan.
- [x] Created the public GitHub repository and made it public so GitHub build-provenance attestations could be persisted.
- [x] The owner chose to ship 1.0.0 **unsigned**, with SmartScreen disclosure, SHA-256 checksums and CI attestations. Signing remains unconfigured.
- [x] The tagged `windows-release` job produced exactly one matching NSIS installer, one portable EXE, `SHA256SUMS.txt`, and build-provenance attestations.
- [x] Downloaded all three files from the same successful tagged run. Recomputed both EXE hashes against `SHA256SUMS.txt` and verified both with `gh attestation verify`, confirming repository, workflow, tag and source commit.
- [x] Prepared a **draft** release with exactly those three files and re-downloaded the uploaded assets to confirm the hashes again.
- [x] The owner authorized publication of the CI-verified installer, portable EXE and checksum file and waived the second-machine rerun below.
- [x] Published the release and re-downloaded the public assets; both EXE hashes and the checksum file hash still match.

## Explicitly waived or still open

- [ ] Install and run the final 1.0.0 EXEs on a second Windows PC/VM. Not performed. Phase 5 covers only the 0.9.0-rc.1 build.
- [ ] Rerun the post-acceptance lifecycle and config-save journeys on a second machine. Not performed; automated tests and the synthetic packaged smoke cover those paths, but they are not a clean-machine functional pass. The [rerun packet](second-machine-rerun-1.0.0.md) remains available.
- [ ] Code signing. SignPath/Authenticode signing is not configured. Checksums and provenance attestations are not a code signature.
- [ ] Repository hardening items beyond public visibility (branch/tag protection, private vulnerability reporting, maintainer MFA) were not verified as part of this publication.

## Post-publication

- [x] Published the GitHub release and verified the public downloads.
- [x] Updated `README.md` and `CHANGELOG.md` from candidate/not-published status.
- [ ] Announce the release externally, if desired.

Never request or publish Plutonium keys, private launchers, process command lines, configs, unredacted logs/screenshots or copied game installs as release evidence.

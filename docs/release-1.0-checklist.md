# 1.0.0 release checklist (not yet published)

The [Phase 5 record](clean-machine-verification.md#user-reported-phase-5-acceptance-2026-11-04) documents the user's explicit acceptance of the **local 0.9.0-rc.1 build**, based on reported separate-Windows-machine testing. It is not evidence that a 1.0.0 binary or a GitHub CI artifact has been tested. Keep this checklist open until the actual release bytes and public repository are verified.

## Freeze the source

- [ ] Review the app-only diff, images and docs for secrets, personal paths and bundled game/engine/mod files. Run a redacted Gitleaks scan over committed history **and** the working tree. Do not include legacy launchers or live installations.
- [ ] Commit the approved 1.0.0 source, including matching `package.json` and lockfile versions. Record the source commit. No tag or public push without the owner's explicit authorization.
- [ ] On clean Windows/Node 22 dependencies, pass tests, typecheck/build, lint, workflow/tooling format check, audit and the synthetic built-renderer smoke. Run the optional read-only desktop smoke. Record skipped tests; do not describe them as passes.
- [ ] Review changes relative to the tested 0.9.0-rc.1 build. If install, launch, config, mod or networking behavior changed, rerun affected real-game journeys on a separate Windows PC/VM and have the user review the redacted outcomes.

## Repository, signing and candidate bytes

- [ ] Choose the GitHub account/organization and enable private vulnerability reporting, branch protection, release-tag protection and MFA for maintainers. Publish **only** this app repository after owner review; the current repository has no remote.
- [x] The owner chose to ship the first public 1.0.0 **unsigned**, with prominent SmartScreen disclosure, SHA-256 checksums and CI attestations. Signing remains unconfigured; pursue [SignPath eligibility and prerequisites](code-signing-readiness.md) separately. Do not call checksums/attestations a code signature.
- [ ] Build the frozen candidate and review the exact NSIS and portable EXEs. The local isolated package smoke is useful but is **not** a second-machine installer test and has no GitHub provenance.
- [ ] After the authorized source push, verify the Windows CI `verify` job for the frozen commit. Create `v1.0.0` **only** when the owner approves; the tag must match `package.json`. The tag's `windows-release` job must produce exactly the matching installer, portable EXE, `SHA256SUMS.txt`, and build-provenance attestations. CI uploads an Actions artifact; it does not publish a GitHub Release.
- [ ] Download all three files from the **same** successful tagged CI run. Recompute SHA-256 for each EXE and compare to its line in `SHA256SUMS.txt`; verify each EXE with `gh attestation verify '<file>.exe' --repo OWNER/REPO` and inspect repository, workflow and source commit/tag. These checks do not establish functional correctness.
- [x] The owner explicitly approved carrying Phase 5 acceptance from the tested 0.9.0-rc.1 build across the reviewed version-only runtime delta to the local 1.0.0 source candidate. The final 1.0.0 EXEs have **not** been installed on a second machine; see the [acceptance record](clean-machine-verification.md#user-reported-phase-5-acceptance-2026-11-04). The candidate now also contains lifecycle and error-handling fixes, so rerun the affected UI and config-save journeys before publishing; the earlier carry-over does not cover those later changes.
- [ ] The owner must still review and approve the **exact final CI-built bytes**, matching checksums and attestations before the public release. Approval of the version-only delta is not approval of an unknown future binary.

## Publish only after approval

- [ ] With the owner's approval, prepare a **draft** GitHub Release for `v1.0.0`, attach the verified CI installer, portable EXE and checksum file **without rebuilding**, and describe the unsigned/signing state and requirements. Verify the uploaded file hashes again before making the draft public.
- [ ] Publish the release, then update the changelog and README from “candidate/not published” to the real version/date and download link. Announce only after the public release and artifact verification are complete. Preserve a known-good prior candidate and a rollback plan.

Never request or publish Plutonium keys, private launchers, process command lines, configs, unredacted logs/screenshots or copied game installs as release evidence.

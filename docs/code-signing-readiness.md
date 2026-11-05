# Code-signing readiness (not configured)

botLANd's current builds are **unsigned**. SHA-256 checksums and GitHub build-provenance attestations, when produced by a tagged CI run, identify bytes and build origin; they are not Authenticode signatures. Do not describe a local build as signed or attested.

[SignPath Foundation's current public terms](https://signpath.org/terms) and [application page](https://signpath.org/apply) were reviewed for planning on 2026-11-04. The site describes free signing for qualifying open-source projects, **not** automatic eligibility or guaranteed acceptance. Among its conditions: a project already released in the form to be signed, an owned source repository and verifiable reputation, maintained OSI-licensed source, documented functionality, MFA, defined author/reviewer/approver roles, a public **Code signing policy** and privacy disclosure, enforced binary metadata, reproducible source-to-binary origin, and manual approval of each signing request. The terms can change; review them again before applying.

## Before applying

- [ ] Choose the public GitHub repository owner and publish only the app repository after a full-history secret scan. Never publish legacy launchers, keys, live configs, logs, game installs, or unredacted screenshots.
- [ ] Release and test a pre-1.0 candidate in the same installer/portable form that would be signed. Keep the [Phase 5 clean-machine acceptance](clean-machine-verification.md) independent from SignPath approval.
- [ ] Have the repository owner review eligibility, configure MFA and private security reporting, assign signing roles, and decide whether the project's network/update-check behavior needs additional privacy or installer disclosures under SignPath's policy.
- [ ] Publish a project-specific code-signing policy with the actual team roles and required attribution only after those roles and the signing arrangement are real. Do not claim SignPath coverage before approval.
- [ ] If approved, integrate signing through protected CI credentials and an approval gate. Verify Authenticode on both final EXEs, **then** hash and attest the final signed bytes. Re-test exactly those signed artifacts on a separate Windows machine.

No application has been submitted and no account, credential, signature, or approval has been configured. The owner chose an **unsigned first 1.0.0 release** with explicit SmartScreen disclosure, SHA-256 checksums and CI attestations after all remaining release gates pass. This is not approval to publish an unverified local build. Pursue SignPath separately once the public project meets its conditions.

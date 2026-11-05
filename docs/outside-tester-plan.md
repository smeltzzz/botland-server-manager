# Outside-tester plan (for regressions and future candidates)

The user has now [accepted Phase 5](clean-machine-verification.md#user-reported-phase-5-acceptance-2026-11-04) for the local 0.9.0-rc.1 build after reporting separate-Windows-machine results for all six titles. Keep this plan for future candidates and any required reruns: a local port-bind smoke or synthetic UI check never substitutes for an in-game bot join. A tester can cover multiple titles, or several testers can divide them, but each affected title needs a second-machine result if installation or launch behavior changes.

## Recruit without sharing private data

Ask volunteers whether they have Windows 10+, an owned Steam install, a working compatible engine, and a client capable of joining a LAN server for the titles they can cover. They must use **their own** Plutonium server keys. The engines are Cod4R/IW3x for CoD4 (not CoD4x), IW4x for MW2, and Plutonium for WaW, BO1, MW3 and BO2. Do not send them the author's game files, engine files, private launchers, keys, configs, logs, or a copy of a live installation.

Suggested invitation (adapt before sending):

> I am testing a pre-1.0 Windows desktop app for hosting bot matches. Do you have an owned Steam copy of CoD4, WaW, MW2, BO1, MW3 or BO2 and its compatible server engine already set up? I am looking for a fresh-PC/VM install-and-play check. You would use your own Plutonium key if applicable, install Bot Warfare only after clicking in the app, join from a compatible client, and visually confirm whether bots enter a match. Please do not share any keys, launchers, private paths, IPs or raw logs. I can provide a checklist and an unsigned candidate once we agree on a trustworthy delivery method.

## Deliver the candidate deliberately

- As of 2026-11-04, no GitHub remote, public push, tagged CI artifact, or attestation exists. The local `0.9.0-rc.1` package is **unsigned** and is not a public release or a CI-attested artifact. Do not redistribute it further without the owner's approval and a trustworthy delivery method.
- Before sharing a frozen build, record its source commit, exact version, installer/portable SHA-256 digests, and whether it came from a tagged CI run. Send the checksum through a separately authenticated channel if possible. Never claim GitHub provenance for a local build.
- Tell testers that SmartScreen may warn on unsigned builds and that a matching checksum does not prove the program is safe. Let each tester decide whether to proceed. Do not request a bypass of their security controls.
- Give each tester the [release-candidate checklist](release-candidate-checklist.md), [clean-machine verification steps](clean-machine-verification.md), and a private reporting route. Do not make a 1.0 claim or publish a release merely to recruit testers.

## Redacted result template (one row per title)

| Title | Windows version | Engine detected | Mod/config/starter | Port bound | Client connected | Bots seen in match | Guided edit + backup | Stop/port released | Firewall/UAC | Blocker and rerun |
|---|---|---|---|---|---|---|---|---|---|---|
| CoD4 / WaW / MW2 / BO1 / MW3 / BO2 | | | | | | | | | | |

Use yes/no/not tested and a short symptom only. Mark a check **not tested** rather than inferring it from another result. Redact machine/user paths, IPs, hostnames, GUIDs, process arguments, tokens and passwords. Ask the owner to review any blockers, fix them reproducibly, and rerun failed steps on a second machine. Only then ask for explicit Phase 5 acceptance.

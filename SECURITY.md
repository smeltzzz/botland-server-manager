# Security policy

## Reporting a vulnerability

Do not disclose vulnerabilities or secrets in a public issue. Use GitHub's **Report a vulnerability** (private vulnerability reporting) for this repository if enabled. If it is not enabled, contact the maintainers privately through the repository owner's profile and ask for a secure reporting channel before sharing details. Do not email a key or upload a private launcher to a public tracker.

Include the affected version, impact, and a minimal reproduction with synthetic data. Allow the maintainer time to investigate before publishing details. If a server key has been exposed, rotate it with the provider immediately; deleting a post or commit does not invalidate the key.

## Supported versions

Security fixes target the latest release. Always run the latest published version.

## Threat model note

Plutonium keys saved in botLANd are encrypted for the current Windows user with Electron `safeStorage` and kept separate from ordinary preferences. Legacy private launch scripts are read only after an explicit key-import request; importing does not remove their plaintext contents. Plutonium still requires the key on the game process command line, so keep launchers, process diagnostics, and screenshots private.

Bot Warfare downloads happen only after a user action and use the official ineedbots GitHub repositories and GitHub's release-asset CDN. Archives are size-limited, hash checked, and rejected for unsafe ZIP paths. Existing unmanaged files are backed up before replacement; edited waypoints and unrelated files are preserved. Updates publish individual files with in-process rollback. Updates are still per-file rather than a single atomic directory swap, but a durable adjacent journal lets the next status/action recover interrupted changes. A damaged journal or a conflicting external edit fails closed; inspect the retained backup/staging files before retrying. Windows cannot guarantee directory-entry durability after sudden power loss.

Engine output is also tailed from known log files and saved in bounded per-session files under Electron userData. Keys and common password/GUID fields are redacted before display or disk writes, but log redaction is best effort and can miss unusual formats or secrets split across multiple lines. Never upload raw session logs or config backups (which may contain plaintext engine secrets) without reviewing them.

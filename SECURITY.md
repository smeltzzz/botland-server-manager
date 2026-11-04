# Security policy

## Reporting a vulnerability

Do not disclose vulnerabilities or secrets in a public issue. Use GitHub's **Report a vulnerability** (private vulnerability reporting) for this repository if enabled. If it is not enabled, contact the maintainers privately through the repository owner's profile and ask for a secure reporting channel before sharing details. Do not email a key or upload a private launcher to a public tracker.

Include the affected version, impact, and a minimal reproduction with synthetic data. Allow maintainers time to investigate before publishing details. If a server key has been exposed, rotate it with the provider immediately; deleting a post or commit does not invalidate the key.

## Supported versions

Security fixes target the latest release. Versions before 1.0 are in active development and may require upgrading to receive fixes.

## Threat model note

Plutonium keys saved in botLANd are encrypted for the current Windows user with Electron `safeStorage` and kept separate from ordinary preferences. Legacy private launch scripts are read only after an explicit key-import request; importing does not remove their plaintext contents. Plutonium still requires the key on the game process command line, so keep launchers, process diagnostics, and screenshots private.

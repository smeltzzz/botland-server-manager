# Security policy

## Reporting a vulnerability

Do not disclose vulnerabilities or secrets in a public issue. Use GitHub's **Report a vulnerability** (private vulnerability reporting) for this repository if enabled. If it is not enabled, contact the maintainers privately through the repository owner's profile and ask for a secure reporting channel before sharing details. Do not email a key or upload a private launcher to a public tracker.

Include the affected version, impact, and a minimal reproduction with synthetic data. Allow maintainers time to investigate before publishing details. If a server key has been exposed, rotate it with the provider immediately; deleting a post or commit does not invalidate the key.

## Supported versions

Security fixes target the latest release. Versions before 1.0 are in active development and may require upgrading to receive fixes.

## Threat model note

The current pre-1.0 release reads Plutonium keys from existing private launch scripts in memory and passes them on the game process command line. Keep those files and process diagnostics private. App-managed encrypted key storage is planned but does not change the game engine's command-line requirement.

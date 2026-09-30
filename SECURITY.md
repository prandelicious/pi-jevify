# Security policy

## Reporting a vulnerability

Please use GitHub's **Report a vulnerability** action in the repository's Security tab when private vulnerability reporting is enabled. This creates a private report for the maintainers. Do not open a public issue for an unpatched vulnerability. The repository owner can enable private vulnerability reporting in the repository's security settings.

Include the affected version, impact, reproduction steps, and any suggested mitigation. Please avoid including real credentials or private user data in the report.

## Supported versions

Security fixes target the latest release. There are no earlier supported release branches yet.

The extension writes local metrics to `.traces/pi-jevify.jsonl` by default. Review the telemetry fields and destination before sharing trace files; the project does not intentionally record prompts, credentials, tool arguments, or source bodies.

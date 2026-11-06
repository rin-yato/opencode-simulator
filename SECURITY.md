# Security

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's
[security advisory form](https://github.com/rin-yato/opencode-simulator/security/advisories/new).
If the form is unavailable, email chearithorn@gmail.com. Do not open a public
issue for a vulnerability.

Include the affected version, a minimal reproduction, and the impact you
expect. We will acknowledge the report and coordinate a fix and release.

## Supported versions

Security fixes target the latest published version. Older versions are not
maintained.

## Scope

The plugin runs with the permissions of the local OpenCode process and drives
the local iOS Simulator. Reports about command execution, local file access,
the loopback stream, or the bundled skill are in scope. Vulnerabilities in
Xcode, iOS, OpenCode, `expo-device-hub`, or the user's Node installation should
go to their respective projects.

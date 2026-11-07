# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/rin-yato/opencode-simulator/security/advisories/new).
Do not open a public issue.

Include the plugin version, your macOS and Xcode versions, and steps to reproduce.

## Scope

This plugin runs locally. It drives the iOS Simulator and streams its screen to
OpenCode Desktop over a loopback-only (`127.0.0.1`) connection. It sends no
telemetry and makes no outbound requests.

Reports about the plugin's own code are in scope. Issues in OpenCode, Xcode, AXe,
or serve-sim belong with those projects.

## Supported versions

Only the latest published release receives fixes.

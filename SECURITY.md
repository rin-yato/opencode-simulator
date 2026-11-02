# Security policy

## Supported versions

The latest release on the default branch receives security fixes.

## Reporting a vulnerability

Use the repository's **private security advisory** form rather than a public
issue. Include:

- the affected version or commit
- a reproduction, command, or tool call
- the impact you observed
- whether the plugin was running with a simulator that contained sensitive data

If the issue is in `serve-sim`, `expo-device-hub`, AXe, or Xcode, report it to
that project as well. This plugin only wraps those tools.

## Scope

The plugin is designed to be local-only. Reports are especially useful for:

- a path where a shell string is built instead of an argument array
- a way a tool reaches a simulator other than the one the session requested
- a network listener that binds beyond `127.0.0.1`
- a file written outside the documented temporary and plugin-storage paths
- an unexpected outbound request
- a way `sim_delete` removes a device without the ownership check

The full list of subprocesses, files, and stored state is in the
[README security section](README.md#security-and-privacy).

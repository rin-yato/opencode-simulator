# opencode-simulator

## 0.2.0

### Minor Changes

- 788f1bd: Share one simulator pool across projects, so two projects can no longer claim the same device or shut down each other's. `sim_start()` now works with nothing booted, `from` picks a model, and a session gets its last device back.

## 0.1.1

### Patch Changes

- Automated patch release.

## 0.1.0

### Initial release

- A live iOS Simulator panel inside OpenCode Desktop.
- Session-scoped managed simulators, with 23 `sim_*` tools for lifecycle, apps,
  inspection, input, screenshots, and UI settings.
- WebRTC streaming with an HTTP fallback.
- A bundled simulator skill for the agent.

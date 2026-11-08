# opencode-simulator

## 0.5.0

### Minor Changes

- f59cce5: Agents now call `sim_idle` when they are done instead of releasing. The device keeps its session, stops being protected from other sessions, and its name changes from `· in use` to `· idle`; using it again makes it active. `sim_release` is replaced by `sim_idle`. Switching to another tab or session no longer destroys the simulator panel's stream: it stays alive, hidden, for up to 10 minutes, so coming back is instant instead of taking 5 to 10 seconds.

## 0.4.0

### Minor Changes

- 032087c: A session keeps its simulator after its turn ends or its panel closes. `sim_release` now only ends a hold. Another session takes an idle device over before a new one is created; a running turn, open panel, or hold protects a device.

## 0.3.0

### Minor Changes

- 043dea2: Rework how the panel starts serve-sim. A cold first boot no longer times out after 20 seconds and drops the stream to HTTP: the hub now waits as long as its process lives. The preview drops the Share button, the hub environment is cleaned, and slow startup phases are logged. The panel follows OpenCode's light and dark scheme, and switching it restyles the preview without reloading the stream.

## 0.2.3

### Patch Changes

- Automated patch release.

## 0.2.2

### Patch Changes

- Automated patch release.

## 0.2.1

### Patch Changes

- 1c05f95: Fix "serve-sim CLI not found" in the panel. The desktop app runs the GUI bundle with a `require` that cannot resolve packages, so the server now tells the window where it found serve-sim.

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

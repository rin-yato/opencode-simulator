# Architecture

The plugin has a server part, a GUI window part, and a GUI main-process part.
They share types but run in different processes.

```text
agent
  |  sim_* tool call (sessionID, signal)
  v
server part (src/index.ts, src/server/)
  |  xcrun simctl / axe / serve-sim CLI       -> simulator
  |  open RPC event { request, sessionID, udid }
  |  <-> device / panel state / released / deleted
  v
GUI window part (src/gui.tsx)
  |  open tab in the calling session's strip
  |  IPC register { key, device }
  v
GUI main part (src/gui/main.ts)
  |  one WebContentsView per window + session
  |  one serve-sim process per device
  v
serve-sim (127.0.0.1:<port>) -> live stream + input
```

## Parts

### Server

`src/index.ts` registers:

- the `sim` tool namespace (`src/server/tools/`)
- the bundled `simulator` skill from `src/skills/simulator.md`
- the portable RPC contract in `src/rpc.ts`: an `open` event, an `opened`
  acknowledgement, a `panel` method, and a `released` event

`sim_start` emits `open` with the calling `sessionID` and waits up to eight
seconds for an `opened: true` acknowledgement. Only the window that owns that
session's tab acknowledges. A window without the session answers nothing, so
another window can still open it. The same window reports panel state through
`panel`; the server emits `released` when a claim returns to the pool.

### GUI window

`src/gui.tsx` registers the panel, menu item, and command. It subscribes to the
`open` event and:

1. finds the session by `sessionID` (never the focused session)
2. records the requested device for that session in `localStorage`
3. opens the tab with `background: true`
4. acknowledges the request

The panel (`src/gui/panel.tsx`) asks the server for the session's authoritative
device over the `device` method, then asks the main process to register a pane
for `{ sessionKey, device }` and renders the returned embed. A retry button
appears if the hub fails. With no device it shows an empty state instead of
streaming whichever simulator booted first.

The same setup watches `ctx.sessions.list()` and `ctx.layout.state` and pushes
`{ sessionID, udid, state, window }` to the server over the `panel` method.
Entries are 30-second leases refreshed by a 10-second heartbeat. When the server
releases a claim it emits `released` (`force` for `sim_release`) and the window
clears that session's device; a `deleted` event clears every window and stops
the device's hub.

### GUI main

`src/gui/main.ts` owns panes. A pane is keyed by `windowId + sessionKey`, so two
sessions in one window and the same session in two windows are independent. The
same session switching devices disposes the old view and attaches a new one.
The embedded view uses a dedicated sandboxed session that denies permissions,
and `will-navigate`/`will-redirect` only allow the hub's origin.

`src/gui/hub.ts` owns hub slots, keyed by device UDID. Each slot runs one
`serve-sim` process with:

```sh
node .../serve-sim.js --host 127.0.0.1 --port <ephemeral> --single-device <udid>
```

`--single-device` is what keeps a panel from streaming whichever simulator
booted first. A hub start waits for the device to boot (serve-sim boots it when
needed), so the panel can open before `sim_start` finishes. Startup races
`error`, `close`, and `exit` so a missing Node fails immediately instead of
waiting for the readiness timeout. Releasing the pane aborts that wait and stops
the child; `ensure` and `release` are serialized per device so a reopen cannot
leave two serve-sim processes. Hubs restart with exponential backoff if the
process exits unexpectedly.

`src/gui/serve-sim.ts` contains the process-level helpers: CLI resolution, port
reservation, readiness polling, child shutdown, and the optional hiding of
Simulator.app.

## Session and device scoping

A simulator is a UDID. Two sessions on one UDID share the screen, app state,
and input. The plugin does not try to multiplex them.

`sim_start` claims its device for the calling session. The claim is atomic
inside the plugin process: it checks ownership and writes the session entry
without awaiting, so two sessions starting at once cannot both adopt one
simulator. Without a udid it:

1. reuses the managed device this session already started, even when shut down;
2. takes the first free managed device of the same model and runtime;
3. creates `<model> N` from an external/reference device when none is free;
4. refuses to grow past five managed devices per model/runtime.

The pool is managed-only. `ManagedDevices` stores the devices the plugin
created. External simulators are used as a model/runtime and app source but are
never auto-claimed, auto-refreshed, or auto-shut down. They are only borrowed
through an explicit `udid`. A managed device is free when no session owns it, no
panel shows it, no lease holds it, and no running session uses it. Devices are
never auto-deleted; `sim_delete` requires an exact name/UDID and forgets the
claim, managed record, panels, and hub.

A managed device's name follows its claim: while a session holds it the name
ends with ` · in use`, and the mark is stripped when the claim is released. It
is cosmetic — matching, numbering, and deletion key on the UDID and the plain
name stored in `simulator-managed`. Renames are serialized per device, skipped
when already applied, and reconciled at startup so a crash cannot leave a stale
mark. External simulators are never renamed.

The panel is the usage signal. The window reports each session's panel state
(`visible`, `active`, `open`, `closed`) per window over the `panel` RPC method.
Each panel entry is a 30-second lease; a dead window stops refreshing and is
released by the server sweep. A `hold` keeps a claim past the turn end until
`sim_release`, session close, or its TTL. The server seeds agent turns from
`Session.Info.time.busy/idle` at startup and on stream reconnect, then tracks
`session.execution.*` and `session.idle`. A device is busy while a panel is
open, a hold is active, or its session is running. When those are gone the
claim is released, and a managed device shuts down after a minute (data stays).

An explicit `udid` is honored even when another session owns it; sharing
requires `share: true`. `sim_create` creates a managed device and records it;
it bypasses the automatic cap only with `force: true`. `sim_delete` removes it
and emits a deleted event so every window clears the device and stops its hub.

What is scoped:

| Scope | Where | Bound |
|---|---|---|
| Session → device | server storage `session-devices` | 500 entries |
| Session → requested device | window `localStorage` `opencode-simulator.devices` | 500 entries |
| Managed device | server storage `simulator-managed` | 200 entries |
| Window + session → panel | server memory `Activity` | 30s lease, refreshed by heartbeat |
| Session → hold | server memory `Activity` | explicit or bounded TTL |
| Session → running | server memory `Activity` | running sessions only |
| Window + session → pane | GUI main memory | closed with the tab/window |
| Device → hub | GUI main memory + storage `hubs` | released 30s after the last pane |
| Pane → embed | GUI main memory | disposed with the pane |

`sim_start` and `sim_boot` write the session default. Every tool that omits
`udid` reads it. A session with no device is told to run `sim_start` or pass
`udid`; it never falls back to another session's simulator.

When a session has no memory, `sim_start` picks an external device as the
model/runtime reference and creates a managed device from it. When everything is
shut down, one model/runtime is unambiguous; several require an explicit
`udid`.

## Lifecycle and cleanup

There is no explicit "session ended" event. The window watches
`ctx.sessions.list()` and the simulator tab's layout state, and pushes them to
the server. For a tab that is still open:

- Panel `closed` and session idle → release the claim.
- Panel `closed` and session running → keep the claim until `session.idle`.
- Any open panel state (`visible`, `active`, `open`) → keep the claim.
- A hold → keep until `sim_release`, session close, or TTL.
- A panel lease not refreshed for 30s → drop it and release when idle.
- Session removed from the window → release it when the session is idle.

The server also listens for `session.deleted` and `session.archived` as a
safety net, seeds running turns from `Session.Info.time` after startup and every
activity-stream reconnect, and reconciles claims against `Session.Info` every
30 seconds. A dropped idle event cannot pin a device forever.

A released managed device keeps its data. After 60 seconds with no claim, the
server shuts it down to reclaim RAM. A new `sim_start` cancels that timer and
boots it again. External devices are never shut down by the pool.

Deleting a device emits a `deleted` event. Each window clears its stored copy
and stops the device's hub immediately; `Activity` also tombstones the UDID so a
late heartbeat cannot re-claim it.

Process lifecycle:

- Closing the tab, deleting the session, or closing the window disposes the
  native view and starts a 30-second idle timer for that device's hub.
- Another pane on the same device cancels the timer. The hub stops only when no
  pane uses it.
- Quitting OpenCode stops every hub. After a crash, the next launch reads the
  stored pids, checks them with `ps`, and terminates them.
- serve-sim gets SIGTERM, then SIGKILL after two seconds.

Bounded local state:

- `session-devices` and `opencode-simulator.devices` are capped at 500 entries.
  Each entry is a session id and a UDID.
- `simulator-managed` is capped at 200 devices; the automatic pool is capped at
  five per model/runtime.
- `Activity` stores panel leases, holds, running sessions, and a 200-entry
  deleted tombstone. Expired leases are swept every 10 seconds.
- Screenshots in `$TMPDIR/opencode-simulator/` use random names, `0600` files,
  and a `0700` directory; they are pruned to 24 hours and 200 files on capture.
- serve-sim state files in `$TMPDIR/serve-sim/` whose pid is dead are removed
  when the server plugin loads. Logs older than a week are removed.
- `sim_status` ignores a serve-sim state file whose pid is gone.

`sim_create` and pool devices are real multi-gigabyte images and are never
deleted automatically; `sim_delete` is explicit. Releasing a claim does not
delete the device, and no automatic sweep does either.

## Why serve-sim runs under Node

serve-sim loads a native capture addon signed by Expo. Electron's hardened
runtime refuses to map a binary with a different Team ID. Running it under
Electron produces `Stream unavailable — retrying…`.

The hub therefore spawns the user's `node` (or `OPENCODE_SIMULATOR_NODE`). It
checks common Homebrew and version-manager locations before falling back to
`node` on `PATH`, because a Finder-launched app may not inherit a shell PATH. It
does not use `process.execPath`, `ELECTRON_RUN_AS_NODE`, or `npx`.

## Code map

| Path | Responsibility |
|---|---|
| `src/index.ts` | Server entry: skill, RPC, tool registration |
| `src/rpc.ts` | Portable `open`, `device`, `panel`, `released`, and `deleted` contract |
| `src/server/tools/context.ts` | Tool context, result helpers, device resolution |
| `src/server/tools/lifecycle.ts` | `devices`, `boot`, `create`, `delete`, `start`, `release`, `install`, `apps`, `uninstall`, `erase`, `launch` |
| `src/server/tools/inspect.ts` | `status`, `ui`, `wait`, `screenshot` |
| `src/server/tools/input.ts` | `tap`, `scroll`, `type`, `button`, `rotate` |
| `src/server/tools/settings.ts` | `settings`, `keyboard`, `statusbar` |
| `src/server/devices.ts` | `simctl` list, match, boot, create, shutdown, delete, app install |
| `src/server/pool.ts` | Pool selection, model matching, `<model> N` names |
| `src/server/simulator-pool.ts` | Single owner of claims, hooks, managed records, activity |
| `src/server/managed.ts` | Devices the plugin created; external devices are excluded |
| `src/server/names.ts` | Cosmetic ` · in use` mark on claimed managed devices |
| `src/server/activity.ts` | Panel leases, holds, running sessions, release, shutdown |
| `src/node-path.ts` | System Node resolution for Finder-launched apps |
| `src/server/accessibility.ts` | AX tree parsing and compaction |
| `src/server/actions.ts` | Input actions and app launch |
| `src/server/screenshot.ts` | Capture, resize, retention |
| `src/server/ui-settings.ts` | Settings, software keyboard, status bar |
| `src/server/serve-sim.ts` | serve-sim CLI fallback and state files |
| `src/server/session-devices.ts` | Bounded session → device store |
| `src/server/exec.ts` | Argument-array subprocess helpers |
| `src/gui.tsx` | Panel, menu, command, `open`/`released`/`deleted` events, panel leases |
| `src/gui/main.ts` | Panes, embeds, idle release, navigation allowlist |
| `src/gui/hub.ts` | One serve-sim slot per device, serialized release |
| `src/gui/serve-sim.ts` | CLI resolution and child-process helpers |
| `src/gui/panel.tsx` | Embedded preview and retry state |
| `src/gui/requests.ts` | Session → requested device in `localStorage` |
| `src/gui/contract.ts` | Main ↔ window IPC schema |
| `src/skills/simulator.md` | Bundled agent skill |

## Tests

Bun tests cover the pure pieces: device matching and size formatting, pool
selection and naming, managed-device storage, panel leases and holds, release
and tombstones, simulator-pool claims, session-device cap/claim/forget, and the
localStorage session cap and removal. There is no automated test for serve-sim
or Electron; those require a real macOS session.

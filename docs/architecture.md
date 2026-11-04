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
  |  <-> panel state / released events
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

The panel (`src/gui/panel.tsx`) reads the recorded device, asks the main process
to register a pane for `{ sessionKey, device }`, and renders the returned embed.
A retry button appears if the hub fails. With no recorded device it shows an
empty state instead of streaming whichever simulator booted first.

The same setup watches `ctx.sessions.list()` and `ctx.layout.state` and pushes
`{ sessionID, udid, state }` to the server over the `panel` method. When the
server releases a claim it emits `released`; the window clears that session's
recorded device, unless the panel is open again.

### GUI main

`src/gui/main.ts` owns panes. A pane is keyed by `windowId + sessionKey`, so two
sessions in one window and the same session in two windows are independent. The
same session switching devices disposes the old view and attaches a new one.

`src/gui/hub.ts` owns hub slots, keyed by device UDID. Each slot runs one
`serve-sim` process with:

```sh
node .../serve-sim.js --host 127.0.0.1 --port <ephemeral> --single-device <udid>
```

`--single-device` is what keeps a panel from streaming whichever simulator
booted first. A hub start waits for the device to boot (serve-sim boots it when
needed), so the panel can open before `sim_start` finishes. Releasing the pane
aborts that wait and stops the child. Hubs restart with exponential backoff if
the process exits unexpectedly.

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

1. reuses the device this session already started, even when it is shut down;
2. takes the first free device of the same model and runtime;
3. creates `<model> #N` when every device is busy;
4. refuses to grow past five devices per model/runtime.

Every device of the same model and runtime is in one pool. A device is free when
no session owns it, no panel shows it, and no running session uses it. Devices
are never auto-deleted; delete one with `sim_delete`.

The panel is the usage signal. The window reports each session's panel state
(`visible`, `active`, `open`, `closed`) over the `panel` RPC method. The server
also tracks agent turns from `session.execution.*` and `session.idle`. A device
is busy while its panel is open or its session is running. When the panel closes
and the session goes idle, the claim is released; after a minute with no new
claim the device shuts down (its data stays).

An explicit `udid` is honored even when another session owns it: sharing is a
deliberate choice. `sim_create` creates an explicitly named device and claims it;
it bypasses the automatic cap but still joins the model pool for reuse.
`sim_delete` removes it and forgets every claim.

What is scoped:

| Scope | Where | Bound |
|---|---|---|
| Session → device | server storage `session-devices` | 500 entries |
| Session → requested device | window `localStorage` `opencode-simulator.devices` | 500 entries |
| Session → panel state | server memory `Activity` | open sessions only |
| Session → running | server memory `Activity` | running sessions only |
| Window + session → pane | GUI main memory | closed with the tab/window |
| Device → hub | GUI main memory + storage `hubs` | released 30s after the last pane |
| Pane → embed | GUI main memory | disposed with the pane |

`sim_start` and `sim_boot` write the session default. Every tool that omits
`udid` reads it. A session with no device is told to run `sim_start` or pass
`udid`; it never falls back to another session's simulator.

When a session has no memory and every booted device belongs to another
session, `sim_start` uses one of them as the model/runtime reference, then
allocates a free device from that pool. When everything is shut down, one
model/runtime is unambiguous; several require an explicit `udid`.

## Lifecycle and cleanup

There is no explicit "session ended" event. The window watches
`ctx.sessions.list()` and the simulator tab's layout state, and pushes them to
the server. For a tab that is still open:

- Panel `closed` and session idle → release the claim.
- Panel `closed` and session running → keep the claim until `session.idle`.
- Any open panel state (`visible`, `active`, `open`) → keep the claim.
- Session removed from the window → release it when the session is idle.

The server also listens for `session.deleted` and `session.archived` as a
safety net.

A released device keeps its data. After 60 seconds with no claim, the server
shuts it down to reclaim RAM. A new `sim_start` cancels that timer and boots it
again.

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
- The pool is capped at five devices per model/runtime.
- `Activity` only stores open panels and running sessions, so it is bounded by
  the sessions that are actually alive.
- Screenshots in `$TMPDIR/opencode-simulator/` are pruned to 24 hours and 200
  files on capture.
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
does not use `process.execPath`, `ELECTRON_RUN_AS_NODE`, or `npx`.

## Code map

| Path | Responsibility |
|---|---|
| `src/index.ts` | Server entry: skill, RPC, tool registration |
| `src/rpc.ts` | Portable `open`, `opened`, `panel`, and `released` contract |
| `src/server/tools/context.ts` | Tool context, result helpers, device resolution |
| `src/server/tools/lifecycle.ts` | `devices`, `boot`, `create`, `delete`, `start`, `launch` |
| `src/server/tools/inspect.ts` | `status`, `ui`, `wait`, `screenshot` |
| `src/server/tools/input.ts` | `tap`, `scroll`, `type`, `button`, `rotate` |
| `src/server/tools/settings.ts` | `settings`, `keyboard`, `statusbar` |
| `src/server/devices.ts` | `simctl` list, match, boot, create, shutdown, delete, app install |
| `src/server/pool.ts` | Pool selection, model matching, `<model> #N` names |
| `src/server/activity.ts` | Panel state, running sessions, claim release, delayed shutdown |
| `src/server/accessibility.ts` | AX tree parsing and compaction |
| `src/server/actions.ts` | Input actions and app launch |
| `src/server/screenshot.ts` | Capture, resize, retention |
| `src/server/ui-settings.ts` | Settings, software keyboard, status bar |
| `src/server/serve-sim.ts` | serve-sim CLI fallback and state files |
| `src/server/session-devices.ts` | Bounded session → device store |
| `src/server/exec.ts` | Argument-array subprocess helpers |
| `src/gui.tsx` | Panel, menu, command, `open`/`released` events, panel state |
| `src/gui/main.ts` | Panes, embeds, idle release |
| `src/gui/hub.ts` | One serve-sim slot per device |
| `src/gui/serve-sim.ts` | CLI resolution and child-process helpers |
| `src/gui/panel.tsx` | Embedded preview and retry state |
| `src/gui/requests.ts` | Session → requested device in `localStorage` |
| `src/gui/contract.ts` | Main ↔ window IPC schema |
| `src/skills/simulator.md` | Bundled agent skill |

## Tests

Bun tests cover the pure pieces: device matching and size formatting, pool
selection and naming, activity release, session-device cap/claim/forget, and the
localStorage session cap and removal. There is no automated test for serve-sim
or Electron; those require a real macOS session.

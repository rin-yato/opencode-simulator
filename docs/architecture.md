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
- the portable RPC contract in `src/rpc.ts`: an `open` event and an `opened`
  acknowledgement

`sim_start` emits `open` with the calling `sessionID` and waits up to eight
seconds for an `opened: true` acknowledgement. Only the window that owns that
session's tab acknowledges. A window without the session answers nothing, so
another window can still open it.

### GUI window

`src/gui.tsx` registers the panel, menu item, and command. It subscribes to the
`open` event and:

1. finds the session by `sessionID` (never the focused session)
2. records the requested device for that session in `localStorage`
3. opens the tab with `background: true`
4. acknowledges the request

The panel (`src/gui/panel.tsx`) reads the recorded device, asks the main process
to register a pane for `{ sessionKey, device }`, and renders the returned embed.
A retry button appears if the hub fails.

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
booted first. Hubs restart with exponential backoff if the process exits
unexpectedly.

`src/gui/serve-sim.ts` contains the process-level helpers: CLI resolution, port
reservation, readiness polling, child shutdown, and the optional hiding of
Simulator.app.

## Session and device scoping

A simulator is a UDID. Two sessions on one UDID share the screen, app state,
and input. The plugin does not try to multiplex them.

`sim_start` claims its device for the calling session. The claim is atomic
inside the plugin process: it checks ownership and writes the session entry
without awaiting, so two sessions starting at once cannot both adopt one
simulator. When the chosen device is already owned by another session,
`sim_start` creates a copy with the same model and runtime, installs the
requested app bundle from the source, and claims the copy. A `label` such as
`create order flow` names the copy `<model> — <label>` instead of `<source>
Copy`; without one, the session title is used when available. An explicit
`udid` skips the check, so sharing is a deliberate choice.

What is scoped:

| Scope | Where | Bound |
|---|---|---|
| Session → device | server storage `session-devices` | 500 entries |
| Session → requested device | window `localStorage` `opencode-simulator.devices` | 500 entries |
| Window + session → pane | GUI main memory | closed with the tab/window |
| Device → hub | GUI main memory + storage `hubs` | released 30s after the last pane |
| Pane → embed | GUI main memory | disposed with the pane |

`sim_start` and `sim_boot` write the session default. Every tool that omits
`udid` reads it before falling back to the only booted simulator.

For parallel work on the same model, `sim_start` creates a copy automatically
when another session owns the candidate device. `sim_create` does the same
explicitly, with a chosen source and name. It copies the device type and
runtime, boots the copy, and installs the requested app bundle from the source.
It does not copy app data: `simctl clone` would, but it requires the source to
be shut down.

## Lifecycle and cleanup

There is no explicit "session ended" event. Cleanup hangs off panels and
processes:

- Closing the tab, deleting the session, or closing the window disposes the
  native view and starts a 30-second idle timer for that device's hub.
- Another pane on the same device cancels the timer. The hub stops only when no
  pane uses it.
- Quitting OpenCode stops every hub. After a crash, the next launch reads the
  stored pids, checks them with `ps`, and terminates them.
- serve-sim gets SIGTERM, then SIGKILL after two seconds. Simulator.app and its
  booted devices stay as they are.

Bounded local state:

- `session-devices` and `opencode-simulator.devices` are capped at 500 entries.
  Each entry is a session id and a UDID.
- Screenshots in `$TMPDIR/opencode-simulator/` are pruned to 24 hours and 200
  files on capture.
- serve-sim state files in `$TMPDIR/serve-sim/` whose pid is dead are removed
  when the server plugin loads. Logs older than a week are removed.
- `sim_status` ignores a serve-sim state file whose pid is gone.

Created simulators are the exception. `sim_create` and the automatic copy in
`sim_start` make a real multi-gigabyte device image. It is never deleted
automatically; `sim_delete` is explicit.

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
| `src/rpc.ts` | Portable `open`/`opened` contract |
| `src/server/tools/context.ts` | Tool context, result helpers, device resolution |
| `src/server/tools/lifecycle.ts` | `devices`, `boot`, `create`, `delete`, `start`, `launch` |
| `src/server/tools/inspect.ts` | `status`, `ui`, `wait`, `screenshot` |
| `src/server/tools/input.ts` | `tap`, `scroll`, `type`, `button`, `rotate` |
| `src/server/tools/settings.ts` | `settings`, `keyboard`, `statusbar` |
| `src/server/devices.ts` | `simctl` device list, match, boot, create, delete |
| `src/server/copy-name.ts` | Semantic copy names from a device and label |
| `src/server/accessibility.ts` | AX tree parsing and compaction |
| `src/server/actions.ts` | Input actions and app launch |
| `src/server/screenshot.ts` | Capture, resize, retention |
| `src/server/ui-settings.ts` | Settings, software keyboard, status bar |
| `src/server/serve-sim.ts` | serve-sim CLI fallback and state files |
| `src/server/session-devices.ts` | Bounded session → device store |
| `src/server/exec.ts` | Argument-array subprocess helpers |
| `src/gui.tsx` | Panel, menu, command, `open` event handling |
| `src/gui/main.ts` | Panes, embeds, idle release |
| `src/gui/hub.ts` | One serve-sim slot per device |
| `src/gui/serve-sim.ts` | CLI resolution and child-process helpers |
| `src/gui/panel.tsx` | Embedded preview and retry state |
| `src/gui/requests.ts` | Session → requested device in `localStorage` |
| `src/gui/contract.ts` | Main ↔ window IPC schema |
| `src/skills/simulator.md` | Bundled agent skill |

## Tests

Bun tests cover the pure pieces: device matching, copy naming, the
session-device cap, claim and forget behavior, and the localStorage session
cap. There is no automated test for serve-sim or Electron; those require a real
macOS session.

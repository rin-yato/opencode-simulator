# opencode-simulator

Embed a live iOS Simulator in OpenCode Desktop and let the agent drive it.

- **Live panel.** The simulator streams into a side-panel tab. Tap, drag, type,
  rotate, and press hardware buttons directly in the panel.
- **Agent tools.** Eighteen `sim_*` tools cover device lifecycle, accessibility
  reads, input, UI settings, screenshots, and waits.
- **Session-scoped.** Each session remembers its simulator. Two sessions can
  test two devices at once, including two copies of the same iPhone model.
- **Bundled skill.** The plugin teaches agents to use the tools instead of
  `xcrun simctl`, Xcode, `axe`, or generated shell scripts.
- **Local only.** No telemetry and no hosted service. Every subprocess and file
  write is listed under [Security and privacy](#security-and-privacy).

## Requirements

- macOS with Xcode and at least one installed iOS Simulator runtime.
- OpenCode Desktop 2.2 or newer.
- Node.js 22 or newer on `PATH`. The simulator stream runs under your Node, not
  Electron. Set `OPENCODE_SIMULATOR_NODE` to an absolute path if the desktop app
  cannot find it.
- [AXe](https://github.com/cameroncooke/AXe) 1.8 or newer is recommended for
  accessibility reads and input. Without it, reads fall back to serve-sim's
  accessibility endpoint and input falls back to serve-sim gestures.

## Install

### From a local checkout

```sh
git clone https://github.com/rin-yato/opencode-simulator.git
cd opencode-simulator
bun install
bun run build
```

Add the checkout to your global `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-simulator"]
}
```

The plugin finds the `serve-sim` CLI inside its own
`node_modules/expo-device-hub`. If you use a non-standard layout, point at the
CLI explicitly:

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-simulator",
      "options": {
        "hubCli": "/absolute/path/to/node_modules/expo-device-hub/vendor/serve-sim/dist/serve-sim.js"
      }
    }
  ]
}
```

### From npm

Once the package is published:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-simulator"]
}
```

OpenCode reloads the plugin when the config changes. GUI changes need a fresh
bundle: run `bun run build` after editing panel code.

### Options

| Option | Default | Purpose |
|---|---|---|
| `hubCli` | vendored `serve-sim` | Absolute path to the serve-sim CLI |
| `showSimulator` | `false` | Keep Simulator.app visible instead of hiding it after the stream starts |

Environment equivalents: `OPENCODE_SIMULATOR_HUB`,
`OPENCODE_SIMULATOR_SHOW_SIMULATOR=1`, and `OPENCODE_SIMULATOR_NODE`.

## Use

1. Ask the agent to start the simulator, or call `sim_start` yourself:
   `sim_start({ app: "com.example.app" })`.
2. The panel opens in the **session that called the tool**. You can also open it
   from the side-panel `+` menu or the **Open Simulator** command.
3. Work in the panel or let the agent call `sim_ui`, `sim_tap`, `sim_type`, and
   the other tools.

`sim_start` boots the device, launches the app if you pass a bundle id, and
streams that exact device even when other simulators are booted. Closing the
panel disposes the view; the simulator keeps running, and its stream stops 30
seconds after the last panel closes.

### Parallel sessions

A simulator is one UDID. Two sessions that target the same UDID share one
screen, one app state, and one set of taps, so they will fight.

To run the same model twice, give each session its own simulator:

```text
sim_create({ from: "iPhone 17 Pro", app: "com.example.app" })
sim_start()
```

`sim_create` creates a device with the source's model and runtime, boots it,
installs the app bundle from the source, and makes the new UDID the session's
default. App data is not copied, so the copy starts fresh. Delete it when the
parallel work is done:

```text
sim_delete({ udid: "iPhone 17 Pro Copy" })
```

`sim_delete` shuts the device down first and refuses if another session still
owns it unless you pass `force: true`.

## Tools

Tools are registered in the `sim` namespace. In Code Mode they are
`tools.sim.<name>`.

| Tool | Use |
|---|---|
| `sim_devices` | List simulators, states, runtimes, and UDIDs |
| `sim_boot` | Boot a device headlessly |
| `sim_create` | Create a same-model copy, optionally installing an app from the source |
| `sim_delete` | Shut down and delete a simulator |
| `sim_start` | Boot, optionally launch an app, and open the panel |
| `sim_launch` | Terminate and relaunch an app by bundle id |
| `sim_status` | Device, app, screen size, AXe version, serve-sim port |
| `sim_ui` | Compact accessibility table; `find` for one control |
| `sim_tap` | Tap by `text`, `id`, `label`, `value`, or normalized `x`/`y` |
| `sim_scroll` | Swipe `up` or `down`, optionally multiple times |
| `sim_type` | Type into the focused field; `submit: true` presses Return |
| `sim_button` | `home`, `lock`, `side-button`, `siri`, `apple-pay` |
| `sim_rotate` | Portrait or landscape |
| `sim_settings` | Read or change appearance, text size, contrast, motion, and more |
| `sim_keyboard` | Show, hide, or toggle the software keyboard |
| `sim_statusbar` | Override the status bar for deterministic screenshots |
| `sim_screenshot` | Small JPEG (800 px by default) for visual checks |
| `sim_wait` | Wait for text and return PASS or FAIL |

`udid` accepts a UDID, an exact device name, or a unique name fragment.
Ambiguous matches fail instead of guessing. Omitting it targets the device the
session started, then the only booted simulator.

See [docs/tools.md](docs/tools.md) for arguments, return values, and failure
modes.

Typical loop:

```text
sim_start({ app: "com.example.app" })
sim_ui({ mode: "interactive" })
sim_tap({ text: "Products" })
sim_wait({ text: "Products" })
sim_scroll({ direction: "down" })
sim_screenshot({ width: 500 })
```

Prefer `sim_ui` and `sim_wait` over screenshots. A compact text read is a few
hundred tokens; an image costs far more.

## How it works

The package has three parts:

- **Server** (`src/index.ts`, `src/server/`) registers the `sim` tools and the
  bundled `simulator` skill, and implements the `open` RPC event.
- **GUI window** (`src/gui.tsx`) registers the panel, menu item, and command.
  It records the device each session asked for and opens the tab in that
  session's strip.
- **GUI main** (`src/gui/main.ts`, `src/gui/hub.ts`) owns one native
  `WebContentsView` per window and session, and one `serve-sim` process per
  device, locked with `--single-device`.

`src/gui/panel.tsx` renders the embedded preview. `src/server/accessibility.ts`
compacts the AX tree, `src/server/actions.ts` performs input, and
`src/server/devices.ts` wraps `simctl`.

The architecture and lifecycle notes are in
[docs/architecture.md](docs/architecture.md).

## Security and privacy

The plugin is meant to be auditable. This is the complete list of external
commands it can run:

| Command | Why |
|---|---|
| `xcrun simctl list/boot/bootstatus/shutdown/create/delete/install/get_app_container/launch/terminate/io/status_bar` | Device lifecycle, app install, screenshots, status bar |
| `axe describe-ui/tap/swipe/type/key/button/--version` | Accessibility reads and input when AXe is installed |
| `node .../serve-sim.js` | Streaming preview, gestures, settings, software keyboard |
| `osascript` | Hide Simulator.app after a stream starts (skipped with `showSimulator`) |
| `sips` | Resize screenshots |
| `open -a Simulator` | Focus Simulator.app before an AXe hardware-button fallback |
| `ps` | Identify a hub process left behind by a crash |

Every command uses `execFile`/`spawn` with an argument array. The plugin does
not build shell strings.

Data touched:

- **Read:** simulator list, accessibility tree, app containers for `sim_create`,
  and the serve-sim port files.
- **Written:** screenshots in `$TMPDIR/opencode-simulator/` (last 24 hours, max
  200 files), serve-sim state in `$TMPDIR/serve-sim/`, the plugin storage key
  `session-devices` (capped at 500 entries), GUI storage key `hubs`, and
  `localStorage` key `opencode-simulator.devices` in the desktop window.
- **Created on disk:** `sim_create` makes a real simulator image. It is not
  auto-deleted; use `sim_delete`.
- **Deleted:** `sim_delete` removes the simulator and all its data.

The plugin does not send telemetry. serve-sim binds to `127.0.0.1` and is not
exposed on the network. No credentials are read or stored.

Report a vulnerability through the repository's private security advisory
form. See [SECURITY.md](SECURITY.md).

## Troubleshooting

**`Stream unavailable — retrying…`**
serve-sim is running under Electron. Its native addon is signed by Expo and
Electron's hardened runtime rejects it. Set `OPENCODE_SIMULATOR_NODE` to a
system Node 22+ path.

**The panel is empty or shows old UI**
Run `bun run build`. The GUI bundle at `dist/gui-experimental.cjs` must be
rebuilt after panel changes. If a mounted panel still has stale code, restart
OpenCode once.

**`serve-sim=not running`**
The simulator tab has not been shown yet. Open the tab in the calling session,
or use the AXe-backed tools (`status`, `ui`, `tap`, `scroll`, `type`, `wait`,
`screenshot`), which work without a hub.

**Multiple booted simulators**
Pass `udid` to the tool, or start the device in the session first. The session
default is remembered across reloads.

**The Simulator window is visible**
Set `options.showSimulator` or `OPENCODE_SIMULATOR_SHOW_SIMULATOR=1` only if you
want that. Otherwise the first hide may ask for Automation access to System
Events.

## Development

```sh
bun install
bun run check      # typecheck + tests
bun run build      # GUI bundle
bun run dev        # GUI watch mode
bun run format
```

The server part is loaded from `src/`; the GUI is bundled to
`dist/gui-experimental.cjs`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the code
map and pull-request checklist.

## License

MIT

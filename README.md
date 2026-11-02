# opencode-simulator

A personal OpenCode Desktop plugin that embeds an iOS Simulator in a side-panel
tab and registers simulator tools the agent can call directly.

The plugin starts `serve-sim` on loopback and places its preview in a native
`WebContentsView` through `ctx.embeds`. The simulator itself stays on the Mac;
the panel is the live stream and input surface.

It also has a server part that registers a `sim` tool namespace with OpenCode:
`status`, `ui`, `tap`, `scroll`, `type`, `button`, `rotate`, `screenshot`,
`wait`, and `launch`. No MCP server is involved.

`serve-sim` is run with the system `node`, not Electron. Its native capture
addon is signed by Expo, and Electron's hardened runtime refuses to map a
foreign Team ID. Running it under Electron is what produces:
`Stream unavailable — retrying…`.

## Requirements

- macOS with Xcode and at least one iOS Simulator runtime.
- OpenCode Desktop 2.2.x.
- Node.js 22 or newer on `PATH`. Set `OPENCODE_SIMULATOR_NODE` to an absolute
  Node path if the desktop app cannot find it.
- `expo-device-hub` installed in this package; the plugin uses its vendored
  `serve-sim`.
- [AXe](https://github.com/cameroncooke/AXe) (`axe`) 1.8+ is recommended for
  accessibility reads and selector taps. Without it, reads fall back to
  serve-sim's `/ax` endpoint and input falls back to serve-sim gestures.

## Install

```sh
cd /Users/yato/Documents/dev/opencode-simulator
bun install
bun run build
```

Add the plugin to the global `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugins": [
    {
      "package": "/Users/yato/Documents/dev/opencode-simulator",
      "options": {
        "hubCli": "/Users/yato/Documents/dev/opencode-simulator/node_modules/expo-device-hub/vendor/serve-sim/dist/serve-sim.js"
      }
    }
  ]
}
```

OpenCode watches config and rebuilds the GUI bundle. A rebuild also reloads the
plugin in every window and in the Electron main process.

## Use

- Boot a simulator in Xcode or Simulator.app first.
- Open the right side panel and choose **Simulator** from the `+` menu, or run
  **Open Simulator** from the command palette.
- The panel shows the serve-sim preview for the booted device. It is
  interactive: tap, drag, type, rotate, home, and the tools work as in
  serve-sim.
- Closing the panel disposes the native view; the simulator keeps running.

`serve-sim` targets booted simulators by default. If none are booted, boot one
with Xcode/Simulator.app or `xcrun simctl boot <udid>`, then reopen the panel.

## Agent tools

The server part registers a `sim` namespace. Tools are available immediately;
no MCP server and no extra config.

| Tool | Use |
|---|---|
| `sim_status` | Device, app, screen size, AXe version, serve-sim port |
| `sim_ui` | Compact action table; `find` for one control, `mode: "interactive"` for the next action |
| `sim_tap` | Tap by `text`, `id`, `label`, `value`, or normalized `x`/`y` |
| `sim_scroll` | Swipe `up` or `down`, optionally multiple times |
| `sim_type` | Type into the focused field; `submit: true` presses Return |
| `sim_button` | `home`, `lock`, `side-button`, `siri`, `apple-pay` |
| `sim_rotate` | Portrait or landscape |
| `sim_screenshot` | Small JPEG (800px default) for visual checks |
| `sim_wait` | Wait for text, return PASS/FAIL |
| `sim_launch` | Terminate and relaunch an app by bundle id |

Typical loop:

```text
sim_ui({ mode: "interactive" })
sim_tap({ text: "Products" })
sim_wait({ text: "Products" })
sim_scroll({ direction: "down" })
sim_ui({ find: "Afnan 9pm" })
```

Prefer `sim_ui` and `sim_wait` over screenshots. Screenshots cost image tokens;
a compact text read is a few hundred.

## How it works

- `src/gui.tsx` registers the panel, menu item, and command.
- `src/gui/main.ts` owns the `WebContentsView` and the hub process.
- `src/gui/hub.ts` spawns `serve-sim`, waits for `/readyz`, and reconnects the
  pane when the hub restarts on a new port.
- `src/gui/panel.tsx` renders the embed and its retry state.
- `src/index.ts` is the server part. It registers the `sim` tools with
  `ctx.tool.transform`.
- `src/server/ax.ts` reads and compacts the accessibility tree.
- `src/server/actions.ts` taps, scrolls, types, presses buttons, and captures.
- `src/server/serve-sim.ts` resolves the hub CLI and falls back to its gestures.
- The GUI is one prebuilt CommonJS bundle at `dist/gui-experimental.cjs`, built
  with `@opencode/plugin/gui/vite`.

## Development

```sh
bun run dev        # vite build --watch
bun run typecheck
```

Server tool code is loaded from `src/`; after changing it, touch
`~/.config/opencode/opencode.jsonc` to force OpenCode to reload the plugin.

## Uninstall

Remove the plugin entry from the global config. If a serve-sim process is left
behind after a crash, the next plugin start reaps it by the stored pid/port.

## Notes

- This is desktop-only and macOS-only. The plugin declares `os: ["macos"]`.
- serve-sim binds `127.0.0.1`; it is never exposed on the network.
- Do not spawn serve-sim with `process.execPath` / `ELECTRON_RUN_AS_NODE`; the
  native addon will fail to load under Electron's hardened runtime.

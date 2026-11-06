<div align="center">
  <br />
  <br />
  <h3>opencode-simulator</h3>
  <p>A live iOS Simulator inside OpenCode Desktop, with tools your agent can drive.</p>
  <br />
  <br />
</div>

<p align="center">
  <a href="https://www.npmjs.com/package/opencode-simulator"><img alt="npm version" src="https://img.shields.io/npm/v/opencode-simulator.svg" /></a>
</p>

<p align="center">
  <img src="https://unpkg.com/opencode-simulator/screenshot.png" alt="An agent driving an iOS app in the Simulator panel" width="900" />
</p>

## What you get

- **A real simulator, in the panel.** The iOS Simulator streams into a side tab.
  Tap, drag, type, rotate, and press hardware buttons without leaving OpenCode.
  The panel is dark, like the simulator's own preview.
- **WebRTC by default.** The stream uses H.264 hardware encoding at 60 fps and
  up to 16 Mbps, with an automatic HTTP fallback.
- **Tools the agent can use.** 23 `sim_*` tools cover device lifecycle, app
  install/uninstall/erase, accessibility reads, input, UI settings, screenshots,
  waits, and explicit release.
- **Session-scoped.** Every session remembers its simulator, and the panel opens
  in the session that called the tool, never a different one.
- **Parallel by default.** Two sessions can run two simulators at once,
  including two of the same iPhone model.
- **Managed pool.** The plugin creates and reuses its own simulators. Your
  existing devices are never auto-claimed, auto-refreshed, or auto-shut down;
  they are only a model/app reference unless you pass their UDID explicitly.
  The pool keeps up to five managed devices per model and runtime.
- **Bundled skill.** The plugin teaches the agent to use `sim_*` instead of
  `xcrun simctl`, Xcode, `axe`, or generated shell scripts. The skill's own
  frontmatter says when to load it, so it triggers on the word "simulator" and
  on any work that involves driving one.
- **Local only.** The stream binds to `127.0.0.1`. No telemetry, no hosted
  service. WebRTC is given a loopback STUN address so the preview never falls
  back to a public STUN server.

## Install

Requires macOS with Xcode and an iOS runtime, OpenCode Desktop 2.2+, and Node
22+ on `PATH`.

Install it with the OpenCode CLI:

```sh
opencode plugin add opencode-simulator
```

Or add the plugin to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-simulator"]
}
```

Using a checkout instead:

<details>
<summary>Local checkout</summary>

```sh
bun install
bun run build
```

Then add the checkout's absolute path to `plugins`.

</details>

AXe 1.8+ is recommended for accessibility reads and input. Without it, the
plugin falls back to serve-sim.

## Use

Start a managed simulator and open its panel:

```text
sim_start({ app: "com.example.app" })
```

The plugin creates or reuses a managed pool device. Your existing simulators are
not claimed automatically: the first call creates `<model> 1` and uses the
installed device only as the model/runtime and app source. The panel opens in
the calling session, on that exact device. While a device is held, its name ends
with ` · in use`; the mark is removed when it returns to the pool.

Install a fresh build you already produced:

```text
sim_install({ path: "/path/to/MyApp.app" })
sim_launch({ bundleId: "com.example.app" })
```

Then drive it:

```text
sim_ui({ mode: "interactive" })
sim_tap({ text: "Products" })
sim_wait({ text: "Products" })
sim_screenshot({ width: 500 })
```

You can also open **Simulator** from the side-panel menu or the command palette.
It shows the session's current device, or an empty state after that device has
been returned to the pool.

### Streaming

Streams use WebRTC by default, with H.264 hardware encoding, a 16 Mbps ceiling,
and 60 fps. The bitrate is a ceiling: WebRTC backs off when the simulator is
idle, so a static screen stays cheap. If WebRTC cannot start, the hub falls
back to HTTP for that device. To trade quality for CPU, add options to the
plugin entry:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-simulator",
      "options": {
        "streamFps": 30,
        "streamBitrate": 12000000,
        "streamMaxDimension": 1206
      }
    }
  ]
}
```

`streamBitrate` and `streamFps` apply to WebRTC; `streamTransport` and
`streamMaxDimension` apply to both transports. To force HTTP, set
`streamTransport` to `"http"` and omit the WebRTC quality options.

`streamMaxDimension: 0` (the default) keeps the simulator's native resolution.
`streamBitrate` accepts 100000–16000000; `streamFps` accepts 1–140;
`streamMaxDimension` accepts 0–4096.

The panel lives in OpenCode's side region, so its width is the app's: drag the
region's edge to give the chat more room. OpenCode remembers that width per
session.

### Two sessions, same iPhone model

A simulator is a UDID. Two sessions on the same UDID share one screen, app
state, and set of taps. `sim_start` gives each session its own managed device:

```text
sim_start({ app: "com.example.app" })   # iPhone 17 Pro 1
sim_start({ app: "com.example.app" })   # iPhone 17 Pro 2, or a free managed device
```

The first session creates `1` from your installed iPhone 17 Pro. The second
creates `2`, or reuses a free managed device. The pool keeps up to five managed
devices per model and runtime. The first time a device is created it pays the
cold boot (minutes); after that it stays in the pool and later sessions reuse
it. The panel opens immediately and shows its loader during the boot. Reused
devices keep their installed apps and app data; when `sim_start` assigns a
managed device, it installs or refreshes the app from the reference device or
another managed simulator without resetting existing data. External devices are
read-only sources.

Close the panel or call `sim_release` when you are done. If the agent session is
idle, the device returns to the pool and shuts down after about a minute to
reclaim RAM; its data stays on disk. If the agent is still working, the device
stays with that session until the turn ends. To keep a device across turns, pass
`hold` or `holdMinutes`; `sim_release` ends the hold:

```text
sim_start({ app: "com.example.app", holdMinutes: 30 })
sim_release()
```

Use your own simulator explicitly; it is never auto-shut down by the pool:

```text
sim_start({ udid: "iPhone 17 Pro" })
```

Drive a simulator another session owns only with `share: true`:

```text
sim_start({ udid: "iPhone 17 Pro 1", share: true })
```

To create an explicitly named managed device, use `sim_create` first:

```text
sim_create({ from: "iPhone 17 Pro", app: "com.example.app" })
sim_start()
```

List devices with sizes and owner labels, and delete one when you no longer need
it (exact name or UDID; external/panel-owned devices need `force`):

```text
sim_devices({ disk: true })
sim_delete({ udid: "iPhone 17 Pro 1" })
```

## Tools

| Tools | What they do |
|---|---|
| `sim_devices` `sim_boot` `sim_start` `sim_create` `sim_delete` `sim_release` | Device lifecycle and pool ownership |
| `sim_install` `sim_apps` `sim_uninstall` `sim_erase` `sim_launch` | App lifecycle |
| `sim_status` `sim_ui` `sim_wait` `sim_screenshot` | Inspect the screen |
| `sim_tap` `sim_scroll` `sim_type` `sim_button` `sim_rotate` | Input and gestures |
| `sim_settings` `sim_keyboard` `sim_statusbar` | UI settings |

Arguments, return values, and failure modes live in
[docs/tools.md](https://unpkg.com/opencode-simulator/docs/tools.md).

## How it works

The server part registers the tools and the bundled skill. The GUI part owns
the panel and one `serve-sim` process per device. `sim_start` asks the window to
open the tab in the calling session, and the main process streams the device
that session requested. The window also reports whether the panel is open; the
server uses that plus the agent's run state to decide when a device returns to
the pool.

More detail: [docs/architecture.md](https://unpkg.com/opencode-simulator/docs/architecture.md).

## Notes

- `serve-sim` must run under system Node, not Electron. If the stream says
  `Stream unavailable`, set `OPENCODE_SIMULATOR_NODE` to a Node 22+ path.
- Closing the panel stops its stream after 30 seconds. When the agent session is
  idle, the device returns to the pool and shuts down after about a minute. Its
  data stays on disk.
- The pool keeps at most five managed devices per model and runtime. At the cap,
  `sim_start` reports that all are in use instead of creating a sixth; call
  `sim_release` or delete a device to free one.
- External simulators are never auto-claimed, auto-refreshed, or auto-shut down.
  Pass their UDID to use one explicitly.
- An open panel keeps the device with its session even when the agent is idle.
  `hold` keeps it without a panel; `sim_release` returns it.
- The pool only sees the embedded panel. If you interact with Simulator.app
  directly, keep the panel open or hold the device.
- `sim_delete` requires an exact name or UDID. External and panel-owned devices
  need `force: true`; deletion is destructive and removes all data.

## License

MIT

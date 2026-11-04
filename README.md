<div align="center">
  <br />
  <br />
  <h3>opencode-simulator</h3>
  <p>A live iOS Simulator inside OpenCode Desktop, with tools your agent can drive.</p>
  <br />
  <br />
</div>

<p align="center">
  <img src="./screenshot.png" alt="An agent driving an iOS app in the Simulator panel" width="900" />
</p>

## What you get

- **A real simulator, in the panel.** The iOS Simulator streams into a side tab.
  Tap, drag, type, rotate, and press hardware buttons without leaving OpenCode.
- **Tools the agent can use.** 18 `sim_*` tools cover device lifecycle,
  accessibility reads, input, UI settings, screenshots, and waits.
- **Session-scoped.** Every session remembers its simulator, and the panel opens
  in the session that called the tool, never a different one.
- **Parallel by default.** Two sessions can run two simulators at once,
  including two of the same iPhone model.
- **Pooled devices.** Each model keeps up to five simulators. A free one is
  reused; a new `<model> #N` is created only when all are in use. A device
  returns to the pool when its panel is closed and the agent session is idle.
- **Bundled skill.** The plugin teaches the agent to use `sim_*` instead of
  `xcrun simctl`, Xcode, `axe`, or generated shell scripts.
- **Local only.** The stream binds to `127.0.0.1`. No telemetry, no hosted
  service.

## Install

Requires macOS with Xcode and an iOS runtime, OpenCode Desktop 2.2+, and Node
22+ on `PATH`.

Add the plugin to `~/.config/opencode/opencode.jsonc`:

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

Start a device and open its panel:

```text
sim_start({ app: "com.example.app" })
```

The panel opens in the calling session, on that exact device. Then drive it:

```text
sim_ui({ mode: "interactive" })
sim_tap({ text: "Products" })
sim_wait({ text: "Products" })
sim_screenshot({ width: 500 })
```

You can also open **Simulator** from the side-panel menu or the command palette.
It shows the session's current device, or an empty state after that device has
been returned to the pool.

### Two sessions, same iPhone model

A simulator is a UDID. Two sessions on the same UDID share one screen, app
state, and set of taps. You do not have to manage that: `sim_start` gives each
session a free device.

```text
sim_start({ app: "com.example.app" })   # session 1
sim_start({ app: "com.example.app" })   # session 2
```

The first session uses the free iPhone 17 Pro. The second gets the next free
one, or the plugin creates `iPhone 17 Pro #2` if every device is in use. The
pool keeps up to five per model and runtime. The first time a device is created
it pays the cold boot (minutes); after that it stays in the pool and later
sessions reuse it. The panel opens immediately and shows its loader during the
boot. Reused devices keep their installed apps and app data; when `sim_start`
assigns a pool device, it installs or refreshes the app from the reference
device or another booted simulator without resetting existing data. Reusing the
session's own device just launches the app.

Close the Simulator panel when you are done. If the agent session is idle, the
device returns to the pool and shuts down after about a minute to reclaim RAM;
its data stays on disk. If the agent is still working, the device stays with
that session until the turn ends. Run `sim_start` again after a release to get
a device back.

To create an explicitly named device, use `sim_create` first:

```text
sim_create({ from: "iPhone 17 Pro", app: "com.example.app" })
sim_start()
```

List devices with sizes and free/in-use tags, and delete one when you no longer
need it:

```text
sim_devices({ disk: true })
sim_delete({ udid: "iPhone 17 Pro #2" })
```

Passing the same `udid` to both sessions is still possible; that is an explicit
choice to share.

## Tools

| Tools | What they do |
|---|---|
| `sim_devices` `sim_boot` `sim_start` `sim_create` `sim_delete` `sim_launch` | Device and app lifecycle |
| `sim_status` `sim_ui` `sim_wait` `sim_screenshot` | Inspect the screen |
| `sim_tap` `sim_scroll` `sim_type` `sim_button` `sim_rotate` | Input and gestures |
| `sim_settings` `sim_keyboard` `sim_statusbar` | UI settings |

Arguments, return values, and failure modes live in
[docs/tools.md](docs/tools.md).

## How it works

The server part registers the tools and the bundled skill. The GUI part owns
the panel and one `serve-sim` process per device. `sim_start` asks the window to
open the tab in the calling session, and the main process streams the device
that session requested. The window also reports whether the panel is open; the
server uses that plus the agent's run state to decide when a device returns to
the pool.

More detail: [docs/architecture.md](docs/architecture.md).

## Notes

- `serve-sim` must run under system Node, not Electron. If the stream says
  `Stream unavailable`, set `OPENCODE_SIMULATOR_NODE` to a Node 22+ path.
- Closing the panel stops its stream after 30 seconds. When the agent session is
  idle, the device returns to the pool and shuts down after about a minute. Its
  data stays on disk.
- The pool keeps at most five devices per model and runtime. At the cap,
  `sim_start` reports that all are in use instead of creating a sixth; close a
  panel or delete a device to free one.
- An open panel keeps the device with its session even when the agent is idle.
  This is deliberate: you may still be reading the screen or tapping it.
- The pool only sees the embedded panel. If you interact with Simulator.app
  directly, keep the panel open or the device may be returned to the pool.
- `sim_delete` is destructive: it removes the simulator and all its data.

## License

MIT

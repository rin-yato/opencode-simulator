# Handoff

Date: 2026-11-02
Repo: `/Users/yato/Documents/dev/opencode-simulator`
Status: working local plugin; 16 agent tools, session-scoped GUI panel.
Working tree: clean after the session-scoping commit.

## Where we stopped

`sim.start` boots, optionally launches an app, and asks the window entry to
open the Simulator tab **for the session that called the tool**. The RPC
event carries `sessionID` and a per-call `request` id, and the window entry
matches `ctx.sessions.list()` by session id instead of using whichever session
is focused when the event arrives. This fixes the panel landing in an unrelated
session when the user switches away mid-call.

The entry also answers `opened: false` when the calling session's tab is not in
that window; the server ignores false acks so another window can still claim
the request. The ack budget is 8s (cold panel + serve-sim start exceeded the
old 3s).

**Known limit:** if the calling session is not the routed one, the tab is
stored in its strip but not mounted, so serve-sim does not start until the user
opens that session. The panel then connects and streams normally. AXe/simctl
tools keep working in the meantime; serve-sim-only features (rotate, software
keyboard, button fallback) wait for the panel.

The running app is left with iPhone 17 Pro booted, Melis running, and
Simulator.app hidden by the hub.

## What this is

A personal OpenCode Desktop plugin with two parts:

1. **GUI** — a right-side-panel tab that embeds a live iOS Simulator preview
   using serve-sim in a native `WebContentsView`.
2. **Server** — a `sim` tool namespace the agent can call directly. No MCP
   server is involved.

The simulator itself runs on the Mac. The plugin does not stream to a remote
machine and does not support remote OpenCode servers.

## Current environment

- OpenCode Desktop 2.2.x; `@opencode/plugin` 2.2.5.
- `expo-device-hub` 0.19.1, which vendors `serve-sim` 0.13.0.
- AXe `axe` 1.8.0 at `/opt/homebrew/bin/axe`.
- iOS 26.5 simulator: iPhone 17 Pro, UDID
  `1F177DA7-EDA4-4A7C-9466-CF24599B48F5`.
- Test app: Melis (`com.melis.app`), currently running.

## Important paths

- Plugin: `/Users/yato/Documents/dev/opencode-simulator`
- Global config: `/Users/yato/Documents/dev/dotfiles/config/opencode/opencode.jsonc`
  (also reachable as `~/.config/opencode/opencode.jsonc`)
- serve-sim CLI:
  `/Users/yato/Documents/dev/opencode-simulator/node_modules/expo-device-hub/vendor/serve-sim/dist/serve-sim.js`
- GUI bundle: `dist/gui-experimental.cjs`
- Screenshots: `$TMPDIR/opencode-simulator/*.jpg`

## Architecture

- `src/index.ts` — server plugin entry; registers the RPC definition and the
  tools with `ctx.tool.transform`.
- `src/server/tools.ts` — the 16 `sim` tool definitions and JSON schemas.
- `src/server/ax.ts` — reads `axe describe-ui`, compacts it to a small action
  table, matches rows, and formats output. Falls back to serve-sim's
  `/helper/<udid>/ax` endpoint if AXe is missing.
- `src/server/actions.ts` — tap, swipe/scroll, type, button, rotate,
  screenshot, launch.
- `src/server/settings.ts` — simulator UI settings, software keyboard, and
  status bar overrides.
- `src/server/devices.ts` — lists, matches, and boots devices; refuses
  ambiguous booted devices.
- `src/server/serve-sim.ts` — resolves the hub CLI, reads its state file, and
  falls back to serve-sim gestures/input.
- `src/server/exec.ts` — `execFile`/stdin helpers.
- `src/rpc.ts` — shared RPC definition: `open` event from the server tool to the
  window entry, and an `opened` method as the acknowledgement.
- `src/gui.tsx`, `src/gui/main.ts`, `src/gui/hub.ts`, `src/gui/panel.tsx` — the
  existing GUI panel and serve-sim lifecycle. `src/gui.tsx` listens for `open`
  and calls `ctx.layout.open`.

Backends, in order:

1. `axe` for accessibility reads, selector taps, swipes, typing, keys.
2. serve-sim for preview, buttons, rotation, fallback input, UI settings, and
   the software keyboard.
3. `xcrun simctl` for device lifecycle, status bar overrides, and screenshots.

The GUI hub hides Simulator.app once the stream is ready. serve-sim always
opens it after boot, so this is a one-time hide; later `open -g` calls do not
un-hide it. Capture and input work while hidden. Set
`options.showSimulator: true` or `OPENCODE_SIMULATOR_SHOW_SIMULATOR=1` to opt
out.

## Tools

Namespace `sim`; Code Mode sees them as `tools.sim.<name>`.

- `sim.devices` — list simulators with state, runtime, and UDID.
- `sim.boot` — boot a device headlessly; defaults to the only booted/installed
  device.
- `sim.start` — boot if needed, optionally launch an app, then open the
  Simulator panel and wait for serve-sim.
- `sim.status` — device, app, screen, axe version, serve-sim port.
- `sim.ui` — compact table; `find`, `mode: visible|interactive|all`, `max`.
- `sim.tap` — by `text`, `id`, `label`, `value`, or normalized `x`/`y`.
- `sim.scroll` — `up`/`down`, `amount` 1–5.
- `sim.type` — text; `submit` presses Return.
- `sim.button` — home, lock, side-button, siri, apple-pay.
- `sim.rotate` — portrait/landscape via serve-sim.
- `sim.settings` — read/change appearance, text-size, reduce-motion, contrast,
  color-filter, voiceover, hardware keyboard, liquid glass.
- `sim.keyboard` — `show`/`hide`/`toggle` the software keyboard.
- `sim.statusbar` — override/clear time, battery, wifi/cellular bars, carrier.
- `sim.screenshot` — 800px JPEG by default; returns a path.
- `sim.wait` — poll for text; PASS/FAIL.
- `sim.launch` — terminate + relaunch by bundle id.

Typical loop:

```ts
sim_ui({ mode: "interactive" })
sim_tap({ text: "Products" })
sim_wait({ text: "Products" })
sim_scroll({ direction: "down" })
sim_screenshot({ width: 500 })
```

The old Melis `use-simulator` skill's `ui.py` compacting logic was ported into
`src/server/ax.ts`. Its scripts are no longer needed for this plugin.

## Verified

- `sim.status` reads device/app/screen correctly.
- `sim.ui` returned 6 interactive rows (~400 bytes) on Orders.
- Tapping `Products` worked; `sim.wait` passed.
- Scrolling down advanced the product list.
- Tapping the search field and typing `Afnan` worked; `sim.wait` found
  "Afnan 9pm".
- Screenshot produced a readable JPEG.
- `sim.launch("com.melis.app")` relaunched the app.
- `sim.button("home")` reached SpringBoard.
- `sim.devices` lists all 11 installed simulators with clean runtime strings.
- `sim.boot` booted `iPhone 17e` from shutdown in ~33s, then it was shut down
  again to clean up. `sim.boot` on an already-booted device is a no-op.
- `sim.start` boots and launches the app. Verified after the session-scoping
  change: called while another session was on screen, the tab appeared only in
  the calling session's strip (`panel=opened`), and the serve-sim port came up
  once that session was shown.
- `sim.settings()` lists all settings; setting `appearance=dark` changed the
  live screen, and reading it back returned `dark`.
- `sim.statusbar()` overrode time/battery/signal, listed the overrides, and
  cleared them.
- `sim.keyboard` show/hide/toggle worked against a focused field. `show`/`hide`
  are idempotent; visibility is detected from the AX keyboard keys.
- Headless verified: with Simulator.app hidden, native capture, screenshots,
  AXe taps, typing, software keyboard, and appearance changes all work.
- serve-sim has an undocumented `GET /helper/<udid>/ax` endpoint and a
  `/foreground` endpoint. Its tree is smaller (19 nodes vs axe's 83 on Orders)
  and slower (~0.8–1.1s vs ~0.4s), so axe remains the primary reader.
- `sim.rotate("landscape_left")` returned success, but Melis stayed portrait.
  Likely the app is portrait-only; rotation has not been verified against
  SpringBoard or a rotatable app.
- Auto-hide verified end to end: unhid Simulator, killed serve-sim, the hub
  restarted on a new port, and Simulator became hidden while the stream kept
  running.

## Gotchas

- **Never spawn serve-sim with Electron-as-Node.** Its native addon is signed
  by Expo; Electron's hardened runtime rejects it with different Team IDs. Use
  system `node`; override with `OPENCODE_SIMULATOR_NODE`.
- **We use serve-sim directly**, vendored inside `expo-device-hub`, not the
  Expo Device Hub wrapper UI (`dist/server/cli.mjs`).
- **`axe button` needs Simulator.app frontmost.** Without focus it exits 0 and
  does nothing. `sim.button` prefers serve-sim, then activates Simulator before
  falling back to AXe.
- **serve-sim is owned by the GUI hub.** It starts when the panel first
  registers and keeps running after the panel view closes; only plugin cleanup
  or window close stops it. So `sim.rotate`, `sim.keyboard`, and button
  fallbacks work with the panel closed once it has started at least once.
  `sim.settings` and `sim.statusbar` work even without it because they call the
  serve-sim CLI/simctl directly.
- **serve-sim always opens Simulator.app after boot.** The hub hides it after
  `/readyz`; do not quit Simulator.app, since quitting it shuts down the booted
  device. First hide may prompt for Automation access to System Events.
- **`sim.keyboard` needs a focused text field** and the panel open. It detects
  visibility from the AX keyboard keys, so `show`/`hide` are idempotent.
- **After changing server tool code, touch the global `opencode.jsonc`** to
  force a plugin reload. The GUI bundle and the window entry reload with the
  plugin in current OpenCode builds; if a window keeps stale code, restart
  OpenCode once.
- **`sim.start` is session-scoped.** The `open` event carries the calling
  `sessionID` and a per-call `request` id. The window entry opens the tab for
  that session only, with `background: true`; it never falls back to the
  focused session. A window that does not own the session answers
  `opened: false`, and the server ignores false acks because another window may
  own it. The ack budget is 8s.
- **If the calling session is not the routed one**, the tab is stored but not
  mounted, so serve-sim does not start until the user opens that session. AXe
  and simctl tools still work; serve-sim-only features wait for the panel.
- **Subagent sessions have no shell tab**, so `sim.start` called from a
  subagent cannot open a panel today. It starts the device but returns
  `panel=requested`.
- **`sim.screenshot` returns a file path**; in Code Mode the image is not
  auto-attached, so read the JPEG path.
- **Transient empty AX ids right after launch.** Re-read `sim.ui` once.
- **Device matching is exact-name or UDID.** `iPhone 17 Pro` does not
  accidentally match `iPhone 17 Pro 2`.
- **Accessibility defaults** (from the original skill) may still be needed for
  third-party apps; `axe describe-ui` currently works on Melis without
  re-running that preflight.

## Development

```sh
cd /Users/yato/Documents/dev/opencode-simulator
bun install
bun run typecheck
bun run build          # GUI bundle
bun run dev            # GUI watch mode
```

The server part is loaded from `src/`; it is not bundled. After editing
`src/server/*` or `src/index.ts`, touch
`/Users/yato/Documents/dev/dotfiles/config/opencode/opencode.jsonc`.
Window-entry changes (`src/gui.tsx`, `src/gui/panel.tsx`) need an OpenCode
restart; touching config only reloads the server and main process.

## Next steps

1. Resolve a subagent's session to its parent tab so `sim.start` from a
   subagent opens the panel in the owning session.
2. Verify `sim.rotate` on SpringBoard or a rotatable app; otherwise remove or
   document it as serve-sim-only.
3. Decide whether `sim.start` should target one device (`--single-device`) when
   several are already booted; today the hub serves every booted device.
4. Rewrite the Melis `use-simulator` skill to call `sim_*` tools and delete
   `ui.py`/`scroll.sh`/`shot.sh`.
5. Consider `sim.batch` for multi-step flows in one tool call.
6. Consider lazily starting serve-sim from the server part so `sim.rotate`,
   `sim.keyboard`, and button fallbacks work without a mounted panel.
7. Consider returning the screenshot as attached image content reliably; today
   Code Mode only surfaces the text path.
8. Add a small smoke-test script for `status`/`ui`/`tap`/`wait`.

## Fresh-session checklist

1. `cd /Users/yato/Documents/dev/opencode-simulator`
2. `bun run typecheck && bun run build`
3. Confirm the global plugin entry points at
   `/Users/yato/Documents/dev/opencode-simulator`.
4. Use `sim_start` to boot a device and open the **Simulator** panel, or open
   it manually.
5. Call `sim.status`; expect the device, app, screen, and a serve-sim URL.
6. If GUI window changes are missing, restart OpenCode. Touching config only
   reloads the server and main process.
7. If tools are missing after a code edit, touch the global config and retry.
8. Do not use a remote debugging port unless actively needed.

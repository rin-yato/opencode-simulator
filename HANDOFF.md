# Handoff

Date: 2026-11-02
Repo: `/Users/yato/Documents/dev/opencode-simulator`
Status: working local plugin; GUI panel + agent tools are implemented and tested.

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
- Test app: Melis (`com.melis.app`), currently on the Orders screen.

## Important paths

- Plugin: `/Users/yato/Documents/dev/opencode-simulator`
- Global config: `/Users/yato/Documents/dev/dotfiles/config/opencode/opencode.jsonc`
  (also reachable as `~/.config/opencode/opencode.jsonc`)
- serve-sim CLI:
  `/Users/yato/Documents/dev/opencode-simulator/node_modules/expo-device-hub/vendor/serve-sim/dist/serve-sim.js`
- GUI bundle: `dist/gui-experimental.cjs`
- Screenshots: `$TMPDIR/opencode-simulator/*.jpg`

## Architecture

- `src/index.ts` — server plugin entry; registers tools with
  `ctx.tool.transform`.
- `src/server/tools.ts` — the 10 `sim` tool definitions and JSON schemas.
- `src/server/ax.ts` — reads `axe describe-ui`, compacts it to a small action
  table, matches rows, and formats output.
- `src/server/actions.ts` — tap, swipe/scroll, type, button, rotate,
  screenshot, launch.
- `src/server/devices.ts` — resolves a UDID or name; refuses ambiguous booted
  devices.
- `src/server/serve-sim.ts` — resolves the hub CLI, reads its state file, and
  falls back to serve-sim gestures/input.
- `src/server/exec.ts` — `execFile`/stdin helpers.
- `src/gui.tsx`, `src/gui/main.ts`, `src/gui/hub.ts`, `src/gui/panel.tsx` — the
  existing GUI panel and serve-sim lifecycle.

Backends, in order:

1. `axe` for accessibility reads, selector taps, swipes, typing, keys.
2. serve-sim for preview, buttons, rotation, and fallback input.
3. `xcrun simctl` for device lifecycle and screenshots.

## Tools

Namespace `sim`; Code Mode sees them as `tools.sim.<name>`.

- `sim.status` — device, app, screen, axe version, serve-sim port.
- `sim.ui` — compact table; `find`, `mode: visible|interactive|all`, `max`.
- `sim.tap` — by `text`, `id`, `label`, `value`, or normalized `x`/`y`.
- `sim.scroll` — `up`/`down`, `amount` 1–5.
- `sim.type` — text; `submit` presses Return.
- `sim.button` — home, lock, side-button, siri, apple-pay.
- `sim.rotate` — portrait/landscape via serve-sim.
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
- `sim.rotate("landscape_left")` returned success, but Melis stayed portrait.
  Likely the app is portrait-only; rotation has not been verified against
  SpringBoard or a rotatable app.

## Gotchas

- **Never spawn serve-sim with Electron-as-Node.** Its native addon is signed
  by Expo; Electron's hardened runtime rejects it with different Team IDs. Use
  system `node`; override with `OPENCODE_SIMULATOR_NODE`.
- **We use serve-sim directly**, vendored inside `expo-device-hub`, not the
  Expo Device Hub wrapper UI (`dist/server/cli.mjs`).
- **`axe button` needs Simulator.app frontmost.** Without focus it exits 0 and
  does nothing. `sim.button` prefers serve-sim, then activates Simulator before
  falling back to AXe.
- **serve-sim only runs while the panel is active** (the GUI hub owns it).
  Tools that only use AXe/simctl still work with the panel closed. `sim.rotate`
  currently requires serve-sim.
- **After changing server tool code, touch the global `opencode.jsonc`** to
  force a plugin reload. GUI bundle changes reload on build; server source
  changes may stay cached.
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

## Next steps

1. Verify `sim.rotate` on SpringBoard or a rotatable app; otherwise remove or
   document it as serve-sim-only.
2. Rewrite the Melis `use-simulator` skill to call `sim_*` tools and delete
   `ui.py`/`scroll.sh`/`shot.sh`.
3. Consider `sim.batch` for multi-step flows in one tool call.
4. Consider lazily starting serve-sim from the server part so `sim.rotate` and
   button fallbacks work with the panel closed.
5. Consider returning the screenshot as attached image content reliably; today
   Code Mode only surfaces the text path.
6. Add a small smoke-test script for `status`/`ui`/`tap`/`wait`.

## Fresh-session checklist

1. `cd /Users/yato/Documents/dev/opencode-simulator`
2. `bun run typecheck && bun run build`
3. Confirm the global plugin entry points at
   `/Users/yato/Documents/dev/opencode-simulator`.
4. Boot a simulator; open the **Simulator** panel.
5. Call `sim.status`; expect the device, app, screen, and a serve-sim URL.
6. If tools are missing after a code edit, touch the global config and retry.
7. Do not use a remote debugging port unless actively needed.

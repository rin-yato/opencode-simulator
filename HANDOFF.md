# Handoff

Date: 2026-11-02
Repo: `/Users/yato/Documents/dev/opencode-simulator`
Status: working local plugin; 16 agent tools, session-scoped GUI panel, bundled
`simulator` skill.
Working tree: uncommitted; panel now targets the requested device.

## Where we stopped

`sim.start` boots, optionally launches an app, and asks the window entry to
open the Simulator tab **for the session that called the tool**, **on the
device it booted**. The RPC event carries `sessionID`, `udid`, and a per-call
`request` id. The window entry matches `ctx.sessions.list()` by session id and
records the device for that session before mounting the tab.

The panel asks the main process for a hub **locked to that device** with
serve-sim's `--single-device <udid>`. Before this, serve-sim started with no
device and streamed whichever simulator booted first, so a panel could show an
unrelated device. Each device now gets its own serve-sim process; a hub is
released 30s after its last panel closes. The requested device is also kept in
`localStorage` per session, so a window or plugin reload reopens the same
simulator instead of falling back to the first booted one.

Multiple sessions and devices are independent: panes are keyed by window and
session, hubs by device, and the device request by session. Switching sessions
reattaches the panel to that session's device. Two windows can stream two
devices at once (verified with two concurrent serve-sim processes, each
`--single-device` on a different booted simulator). The server part also
remembers each session's device in plugin storage, so omitting `udid` on
`sim_ui`, `sim_tap`, `sim.status`, etc. targets that session's simulator even
when several are booted.

Two sessions on the **same UDID** are one simulator: shared screen, shared app
state, shared taps. `sim.create` handles the parallel case: it creates a device
with the source's device type and runtime, boots it if an app is requested,
installs that app from the source (bundle only, not data), and makes the new
UDID the session's default. The source stays running. `sim.start` adds a
`note=this simulator is also used by another session` line when another session
already owns the UDID.

The entry answers `opened: false` when the calling session's tab is not in that
window; the server ignores false acks so another window can still claim the
request. The ack budget is 8s (cold panel + serve-sim start exceeded the old
3s).

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
3. **Skill** — a bundled `simulator` skill registered by the server part. It
   teaches the agent to use `sim_*` instead of `xcrun simctl`, Xcode, or
   ad-hoc scripts. It ships with the plugin, so every project gets it.

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

- `src/index.ts` — server plugin entry; registers the `sim` tools, the
  `simulator` skill, and the `open` RPC.
- `src/skills/simulator.md` — the bundled skill body.
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
- `sim.boot` — boot a device headlessly; defaults to this session's device,
  then the only booted/installed device.
- `sim.create` — create and (when installing an app) boot a same-model device;
  install the app from a source simulator; make it this session's default.
- `sim.delete` — shut down and delete a simulator; refuses if another session
  owns it unless `force: true`.
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
- Device targeting verified with two booted simulators: the panel was showing
  iPhone 17 Pro, `sim.start({ udid: "iPhone 17e" })` switched the same tab to
  iPhone 17e (`--single-device D867…`), and a plugin reload restored 17e from
  `localStorage` instead of the first booted device. The unused hub was released
  after 30s.
- Concurrent serving verified: two serve-sim instances, each
  `--single-device` on a different booted simulator, both reached `/readyz` and
  reported their own device in `__SIM_PREVIEW__` while running together.
- Per-session default verified with both simulators booted:
  `sim_start({ udid: "iPhone 17e" })` then `sim_status()` (no udid) reported
  17e, and switching back to 17 Pro made it report 17 Pro. The GUI tab followed
  the same device.
- Parallel same-model devices verified: `sim_create({ from: "iPhone 17 Pro",
  app: "com.melis.app" })` made "iPhone 17 Pro Parallel", booted it, and
  installed Melis. Both 17 Pros stayed booted; the panel showed the fresh Melis
  onboarding on the copy while the original kept its Orders state. The test
  device was shut down and deleted afterwards.
- `sim.status` now degrades gracefully when a freshly booted device rejects
  `axe describe-ui`; it reports the device, app, screen (if known), AXe version,
  and serve-sim port with a `UI read failed` note instead of failing outright.
- The bundled `simulator` skill is registered through `ctx.skill.transform`,
  appears in the model's skill list, and loads with the full guidance. Its
  description explicitly forbids `xcrun simctl`, Xcode, and ad-hoc scripts.
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
- `sim.delete` shut down and removed a create-only test device, and cleared
  its `session-devices` entries so `sim.status` fell back to the booted 17 Pro.
- Screenshot pruning ran on capture (no old files yet); stale serve-sim state
  for a deleted UDID was removed on the next server load.

## Lifecycle and cleanup

There is no explicit "session ended" event in the plugin. Resources are tied to
panels and processes, so ending a session cleans up the visible things:

- Closing the Simulator tab, deleting the session, or closing the window
  unmounts the panel, disposes its `WebContentsView`, and starts the 30s idle
  timer for that device's hub.
- If another pane still uses the same device (another window), the hub stays.
- Quitting OpenCode stops every hub; a crash is recovered next launch because
  `hubs` stores the child pids and `reapStale` kills them.
- serve-sim gets SIGTERM and stops its capture/helper children; Simulator.app
  stays open, and its booted devices stay booted until shut down or deleted.

Small state persists by design and is bounded:

- Window `localStorage` `opencode-simulator.devices` (session key -> UDID) and
  server storage `session-devices` in `~/.local/share/opencode/opencode.db`
  (`kv` table). Both cap at 500 entries; each entry is ~50 bytes.
- Hubs store pids/ports/devices in GUI storage; entries are replaced on start
  and cleared on stop or exit.
- Screenshots in `$TMPDIR/opencode-simulator/` are pruned to 24h and 200 files.
- serve-sim state files (`$TMPDIR/serve-sim/server-<udid>.json`) for dead pids
  are removed when the server plugin loads; `sim.status` ignores a state file
  whose pid is gone.
- **Created simulators are the exception.** `sim.create` makes a real device
  with its own disk image (hundreds of MB to GBs). It is not auto-deleted;
  `sim.delete` is explicit.

## Gotchas

- **Never spawn serve-sim with Electron-as-Node.** Its native addon is signed
  by Expo; Electron's hardened runtime rejects it with different Team IDs. Use
  system `node`; override with `OPENCODE_SIMULATOR_NODE`.
- **We use serve-sim directly**, vendored inside `expo-device-hub`, not the
  Expo Device Hub wrapper UI (`dist/server/cli.mjs`).
- **`axe button` needs Simulator.app frontmost.** Without focus it exits 0 and
  does nothing. `sim.button` prefers serve-sim, then activates Simulator before
  falling back to AXe.
- **serve-sim is owned by the GUI hub, one process per device.** It starts when
  a panel for that device mounts and is locked with `--single-device <udid>`, so
  it can never stream a different booted simulator. A hub stops 30s after its
  last panel closes; plugin cleanup stops all of them. `sim.rotate`,
  `sim.keyboard`, and button fallbacks work while a panel has been open at
  least once. `sim.settings` and `sim.statusbar` call the serve-sim CLI/simctl
  directly and need no hub.
- **serve-sim always opens Simulator.app after boot.** The hub hides it after
  `/readyz`; do not quit Simulator.app, since quitting it shuts down the booted
  device. First hide may prompt for Automation access to System Events.
- **`sim.keyboard` needs a focused text field** and the panel open. It detects
  visibility from the AX keyboard keys, so `show`/`hide` are idempotent.
- **Reloading:** after server tool changes, touch the global `opencode.jsonc` to
  reload the plugin server. After GUI changes, `bun run build` reloads the main
  process and the window entries. Touching the config alone did not reliably
  reload the main/window code in this build; if a mounted panel keeps stale
  code, rebuild or restart OpenCode once.
- **`sim.start` is session- and device-scoped.** The `open` event carries the
  calling `sessionID`, the `udid`, and a per-call `request` id. The window entry
  opens the tab for that session only, with `background: true`, and records the
  device for it; it never falls back to the focused session. A window that does
  not own the session answers `opened: false`, and the server ignores false acks
  because another window may own it. The ack budget is 8s.
- **The panel is locked to one simulator per session.** serve-sim runs with
  `--single-device <udid>`, so booting another device does not change what the
  tab streams. The requested device is persisted per session in
  `localStorage`; reopening the tab after a reload restores the last device.
  A manual open (`Open Simulator` command/menu) with no recorded device falls
  back to the first booted simulator.
- **Multiple sessions are independent.** Panes are keyed by window+session and
  hubs by device. `sim.start` in session B never changes session A's tab.
  Switching sessions reattaches the panel to that session's device. Only the
  routed session's panel is mounted in a window, so background sessions keep
  working through AXe-backed tools; `sim.rotate`/`sim.keyboard` in a
  background session still need its tab shown once.
- **Tools default to the session's device.** `sim_boot` and `sim_start` store
  the UDID under `session-devices` in the plugin server storage. Every tool
  that omits `udid` resolves that device first, then falls back to the only
  booted simulator. This is what keeps two sessions from grabbing each other's
  simulator when both are booted.
- **Same UDID means the same simulator.** Two sessions on one UDID share the
  screen, app state, and taps; the panel hub is shared on purpose. For parallel
  sessions on the same model, `sim.create` makes a new device of the same type
  and runtime (booting it to install the requested app from the source) and
  makes it the session's default. `simctl clone` would copy data but requires
  the source to be shutdown, so the tool uses create + install instead.
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
GUI changes (`src/gui.tsx`, `src/gui/*`) need `bun run build`; it reloads the
main process and the window entries in this build. If a mounted panel keeps
stale code, restart OpenCode once.

## Next steps

1. Resolve a subagent's session to its parent tab so `sim.start` from a
   subagent opens the panel in the owning session.
2. Verify `sim.rotate` on SpringBoard or a rotatable app; otherwise remove or
   document it as serve-sim-only.
3. Remove the old project-local Melis `use-simulator` skill now that the plugin
   ships `simulator`; keep only project-specific notes if any remain.
4. Consider `sim.batch` for multi-step flows in one tool call.
5. Consider lazily starting serve-sim from the server part so `sim.rotate`,
   `sim.keyboard`, and button fallbacks work without a mounted panel.
6. Consider returning the screenshot as attached image content reliably; today
   Code Mode only surfaces the text path.
7. Add a small smoke-test script for `status`/`ui`/`tap`/`wait`.

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

---
name: Simulator
description: >-
  Drive and test the local iOS Simulator with the sim_* tools: start devices, read the
  accessibility tree, tap, scroll, type, screenshot, install and launch apps. Use whenever
  the user says "simulator" or "simulate", names an iPhone or iPad simulator, mentions
  simctl or AXe, asks to run, open, install, or launch an app on a simulator, or asks to
  test, debug, or automate an iOS app UI. Use the sim_* tools, never raw simctl, axe, Xcode,
  idb, AppleScript, or scripts.
metadata:
  opencode/autoinvoke: true
---

Use the `sim_*` tools for everything on the simulator. In Code Mode they are
`tools.sim.<name>` (`sim_ui` is `tools.sim.ui`).

Never use `xcrun simctl`, `axe`, `idb`, AppleScript, Xcode UI, or shell scripts to drive
the simulator. Build with the project's normal build command, then
`sim_install({ path })`. If a tool fails, report its output. Do not fall back to raw
commands.

## Loop

```
sim_start()
sim_install({ path: "/path/to/MyApp.app" })
sim_launch({ bundleId: "com.example.app" })
sim_ui({ mode: "interactive" })
sim_tap({ text: "Products" })
sim_wait({ text: "Products" })
sim_ui({ mode: "interactive" })
```

Use `sim_start({ app })` instead of install and launch when the app is already on a
simulator. Take a screenshot only for a visual question, one per state. Use `sim_ui`
for structure.

## Pick a device

Call `sim_start()` with no arguments unless you need a specific model. It keeps this
session's device, else the last one it used, else takes a free managed device, else
creates one.

- `from: "iPhone 17 Pro"` picks the model and gives you a managed device of it.
- `udid` targets one exact device, including the user's own. The user's devices are
  never claimed otherwise.
- `share: true` drives a device another session owns. Use it only on purpose.
- Pass the plain name or UDID, never a name with the ` · in use` mark.
- Skip `sim_boot` unless the panel must stay closed.

## Lifetime

Your device stays yours after your turn ends. The user may keep testing it, so when you
are done, call `sim_idle()` as the last simulator step. It marks the device idle (its name
ends with ` · idle`, while an active one ends with ` · in use`) and keeps it with this
session. Never delete or release it. Another session that needs a simulator takes an idle
one over (no running turn, no open panel, no `hold`) before a new one is created, and
`sim_start()` gives you a device again. If you forget, the end of your turn marks it idle
anyway. Using a `sim_*` tool again makes it active.

Apps and data survive, and an unused device shuts down after about 30 minutes and wakes
when the panel reopens. `hold` or `holdMinutes` pins the device against takeover and
shutdown until `sim_idle` or the session closes.

Nothing is deleted automatically. Do not delete the user's own simulators unless asked.

## Fresh data

`sim_launch` resets memory only. `sim_erase({ force: true })` wipes data and leaves the
device shut down, so call `sim_start` after.

## Panel only

`sim_keyboard`, `sim_rotate`, and `sim_settings` need the panel open (serve-sim). If
one fails, call `sim_start` to open it. `sim_keyboard` also needs a focused text field.
`sim_statusbar` does not need the panel.

## Reading and acting

- Read `sim_ui` before tapping. Never guess coordinates from an image.
- Ids can be empty right after launch. Re-read once before calling an element missing.
- Off-screen target: `sim_scroll`, then re-read.
- After a missed tap, re-read. Layout shifts after the keyboard or a transition.
- Tap a field before `sim_type`.
- Use `sim_wait` after navigation or submit. Do not sleep.

## Debugging and setup

- Crash or odd behavior: `sim_crash()` first (newest crash summary, `list: true` for more,
  filter with `bundleId`), then `sim_logs({ bundleId, since: 120, grep: "error" })`.
  Logs are bounded: narrow with `process`, `since`, or `grep` and raise `level` to
  `info` or `debug` only when needed.
- Deep links and universal links: `sim_open_url({ url: "myapp://item/1" })`. Include the scheme.
- Permissions: before a flow that would show a prompt, `sim_permissions({ action: "grant",
  service: "photos", bundleId })`. `revoke` and `reset` may terminate the app, so relaunch
  it. Notifications cannot be set this way; tap the system alert instead.

## Failures

- A rotate can succeed while the app stays portrait-only.
- All five managed devices for a model are busy (running turn, open panel, or hold): call `sim_idle` on devices you are done with, ask the user to close a panel, or `sim_delete` one.
- The first device of a model pays a cold boot (minutes). Later ones reuse it.

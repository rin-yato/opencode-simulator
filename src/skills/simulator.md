Use the `sim` tools to boot, inspect, and drive the local iOS Simulator. They
wrap AXe, serve-sim, and simctl behind one small API and keep working while the
Simulator.app window is hidden. They are the supported way to test an iOS app in
this environment.

## Hard rules

- **Do not use `xcrun simctl`, `axe`, `idb`, AppleScript, or Xcode for UI work.**
  The `sim` tools already wrap them, and raw commands bypass the scoped panel
  and the compact accessibility reader.
- Do not write tap/scroll/screenshot shell scripts. Call the tools.
- Build the app with the project's normal build command when needed, but never
  drive UI with `xcrun simctl`, `axe`, Xcode's UI, or AppleScript. Install a
  produced bundle with `sim_install({ path })`.
- Never guess a tap coordinate from an image when the element has text, a
  label, or an id. Read the UI first and tap by identifier.
- If a tool fails, report its output. Do not silently fall back to Xcode
  command-line tools.

Tool names below are the agent-facing aliases. In Code Mode they are
`tools.sim.<name>` (`sim_ui` is `tools.sim.ui`).

## Start

1. `sim_devices` — list simulators with state, runtime, UDID, and owner
   (`in use (self)`, `in use (other)`, `free`, `external`). Add `{ disk: true }`
   for sizes.
2. `sim_start({ udid?, app?, share?, hold?, holdMinutes? })` — boot a **managed**
   device, launch the
   app by bundle id, and open the Simulator panel **in the calling session**. It
   returns `panel=...`, `release=...`, and the serve-sim URL. The panel opens
   before boot finishes, so a slow first boot shows the panel loader.
3. `sim_install({ path })` — install a fresh `.app` build if you have one, then
   `sim_launch({ bundleId })`.
4. `sim_status` — confirm device, panel/release state, app, screen size, AXe,
   and serve-sim.

`udid` accepts a UDID, an exact device name, or a unique name fragment.
Ambiguous fragments fail instead of guessing. Every tool remembers the device
this session started. If the device was returned to the pool, the tool tells you
to run `sim_start` or pass `udid`; it never falls back to another session's
simulator. Without a `udid`, `sim_start` reuses the session's managed device,
then takes the first free managed device of the same model and runtime, then
creates `<model> N`. External simulators are never auto-claimed; the first call
creates `1` from your installed device. Pass `udid` to use an external device.
Pass `share: true` with a UDID another session owns; without it the tool
refuses.

The first time a device is created it pays the simulator's cold boot (minutes).
It stays in the managed pool after that, so later sessions reuse it and boot in
seconds. The pool keeps up to five managed devices per model/runtime. When more
than one model/runtime is installed and none is booted, pass `udid` so the pool
knows which one to use.

While a session holds a managed device its name ends with ` · in use`; the mark
is removed when the claim is released. It is cosmetic: pass the plain name or
the UDID to `udid`, never the marked one.

## Parallel devices

A simulator is one UDID. Two sessions targeting the same UDID share one screen,
one app state, and one set of taps: they will fight. `sim_start` prevents that
by default:

```
sim_start({ app: "com.example.app" })   # creates iPhone 17 Pro 1
sim_start({ app: "com.example.app" })   # creates iPhone 17 Pro 2, or reuses a free managed one
```

The first session creates a managed `1` from your installed device. The second
creates `2`, or reuses a free managed device. When `app` is given and
`sim_start` assigns a managed device, it is installed or refreshed from the
reference device or another managed simulator when possible; existing app data
is kept, and data is not copied from the source. Reusing the session's own or an
external device just launches. Reused devices keep their installed apps and app
data between sessions. If several simulators are already booted, an unowned one
is preferred as the reference.

When all five managed devices for a model/runtime are in use, `sim_start` fails
instead of creating a sixth. Call `sim_release` or delete a device to free one.

Use `sim_create` when you want to choose the source or name yourself:

```
sim_create({ from: "iPhone 17 Pro", app: "com.example.app" })
sim_start()
```

The source keeps running and its data is untouched. If you pass a `udid` that
another session owns, pass `share: true`; the result then includes
`note=this simulator is also used by another session`.

## Apps

- `sim_install({ path })` — install a local `.app` bundle. Boots the device if
  needed.
- `sim_apps()` — list installed bundle ids and names.
- `sim_uninstall({ bundleId })` — remove an app.
- `sim_erase({ force: true })` — wipe all device data. Destructive; the device
  is left shut down.
- `sim_launch({ bundleId })` — terminate and relaunch. This resets in-memory
  state, not app data; use `sim_erase` or a new device for a clean data state.

## Returning a device

Close the Simulator panel when the parallel work is done. If the agent session
is idle, the device returns to the pool and shuts down after about a minute;
its data stays on disk. If the agent is still running, the device stays with the
session until the turn ends. An open panel keeps the device even when the agent
is idle, because the user may still be reading or tapping it.

Use `hold: true` or `holdMinutes` when a device must survive the turn boundary,
and `sim_release` when done:

```
sim_start({ app: "com.example.app", holdMinutes: 30 })
sim_release()
```

Nothing is deleted automatically. Use `sim_delete({ udid })` with an exact name
or UDID to remove a device; external, panel-owned, or other-session devices need
`force: true`. Do not delete the user's main simulator unless they ask.

The panel is session-scoped. It appears in the strip of the session that called
the tool, even if the user has switched to another session. It is also
device-scoped: it streams the simulator `sim_start` was given, even when other
simulators are already booted. Each session keeps its own device, so two
sessions can test two simulators independently. If the session is not on
screen, serve-sim starts when the panel mounts; AXe-backed tools work without
it.

## Read the UI

`sim_ui` returns a compact table of the accessibility tree. `mode` defaults to
`visible`; pass `interactive` for the next action:

- `mode: "interactive"` — all controls, including off-screen ones. Best for
  choosing a tap target.
- `mode: "visible"` — on-screen rows only.
- `mode: "all"` — full debug dump.
- `find` — filter by case-insensitive text across label, id, and value.
- `max` — cap the number of rows (default 40).

Each row has an index, element type, label, id, value, and a tap point in
logical points. Prefer `text` or `id` from this table. `sim_tap` accepts the
printed logical point directly, or normalized `x`/`y` when both are `0..1`.

After launching, AX ids can be empty for a moment. Re-read `sim_ui` once before
concluding an element is missing. If the target is below the fold, scroll and
read again.

## Act

- `sim_tap({ text | id | label | value | x, y, nth?, wait? })` — tap one target.
  `text` is a substring over label/id/value and is the friendliest. If several
  visible controls match, pass `nth` or a more specific id/label. `wait` waits
  for the target. Off-screen targets fail; scroll first.
- `sim_scroll({ direction: "up" | "down", amount?: 1..5 })` — scroll the
  focused scroll view.
- `sim_type({ text, submit? })` — type into the focused field. Tap the field
  first. `submit: true` presses Return.
- `sim_wait({ text, timeout? })` — poll until the text appears. PASS includes a
  tap point; FAIL returns `ok: false`. Use it after navigation or a submit
  instead of sleeping.
- `sim_button({ button })` — `home`, `lock`, `side-button`, `siri`, or
  `apple-pay`. `duration` uses the AXe path with Simulator.app focused.
- `sim_launch({ bundleId })` — terminate and relaunch by bundle id. In-memory
  state resets; app data persists.
- `sim_screenshot({ width? })` — 800px JPEG by default, returns a file path.
  Read the JPEG when a visual check matters; prefer `sim_ui` for structure
  because screenshots cost image tokens.

## Settings and input

- `sim_settings()` — list every setting. `sim_settings({ setting })` reads one;
  `sim_settings({ setting, value })` changes it. Requires the Simulator panel
  (serve-sim), like `sim_keyboard` and `sim_rotate`. Settings: `appearance`,
  `liquid-glass`, `text-size`, `reduce-motion`, `increase-contrast`,
  `reduce-transparency`, `color-filter`, `show-borders`, `voiceover`,
  `hardware-keyboard`. Values include `dark`, `light`, `large`, `on`, `off`,
  `grayscale`, `tinted`.
- `sim_statusbar({ time?, batteryState?, batteryLevel?, wifiBars?,
  cellularBars?, dataNetwork?, operatorName? })` — override the status bar for
  deterministic screenshots. `sim_statusbar()` lists overrides;
  `sim_statusbar({ clear: true })` removes them.
- `sim_keyboard({ state: "show" | "hide" | "toggle" })` — the software keyboard,
  default `show`. Focus a text field first; the panel must be open.
- `sim_rotate({ orientation })` — `portrait`, `portrait_upside_down`,
  `landscape_left`, or `landscape_right` via serve-sim. Some apps are
  portrait-only; a success result does not guarantee the app rotated.

## The test loop

```
sim_start()
sim_install({ path: "/path/to/MyApp.app" })
sim_launch({ bundleId: "com.example.app" })
sim_status()
sim_ui({ mode: "interactive" })
sim_tap({ text: "Products" })
sim_wait({ text: "Products" })
sim_ui({ mode: "interactive", find: "search" })
sim_tap({ text: "Search" })
sim_type({ text: "query", submit: true })
sim_wait({ text: "Result" })
sim_screenshot({ width: 500 })
```

For a clean data state, `sim_erase({ force: true })` (the device is shut down),
then `sim_start`, or start a fresh managed device. `sim_launch` only resets
in-memory state. For a form, tap each field, type, then use `sim_wait` for the
next screen. For a visual review, take one screenshot per state and describe
what changed; do not stream screenshots between every tap.

## Failure handling

- Ambiguous or missing device — ask which one, or pass the UDID from
  `sim_devices`. If the session has no simulator, run `sim_start`.
- `serve-sim=not running` — the panel has not been shown yet. Open the
  Simulator tab in the calling session, or use AXe-backed tools (status, UI,
  tap, scroll, type, wait, screenshot) which do not need it.
- The panel shows a different simulator — call `sim_start({ udid })` again with
  the device you want; the tab follows that device. Add `share: true` if another
  session owns it.
- `note=this simulator is also used by another session` — you passed `share:
  true` for a UDID another session owns, so sharing is intentional. Omit `udid`
  next time to let `sim_start` take an independent managed device.
- All five managed simulators are in use — call `sim_release`, close a panel, or
  delete a device with `sim_delete`. The cap prevents the pool from growing
  forever.
- The panel shows no simulator — its device was returned to the pool. Run
  `sim_start` again; it takes the next free device or creates one.
- `pool=created ...` — this call paid the cold boot for a new managed device.
  Later sessions reuse it.
- `sim_settings`/`sim_rotate`/`sim_keyboard` fails — open the Simulator panel so
  serve-sim is running, and focus a text field for the keyboard.
- `sim_start` needs a held device — pass `hold`/`holdMinutes`, then
  `sim_release` when done.
- Tap misses — re-read `sim_ui`; layouts can shift after the keyboard or a
  transition. Prefer text/id over stored coordinates.
- AXe missing — the server falls back to serve-sim's accessibility endpoint.
  `sim_status` reports which is available.

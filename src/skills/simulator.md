Use the `sim` tools to boot, inspect, and drive the local iOS Simulator. They
wrap AXe, serve-sim, and simctl behind one small API and keep working while the
Simulator.app window is hidden. They are the supported way to test an iOS app in
this environment.

## Hard rules

- **Do not use `xcrun simctl`, `axe`, `idb`, AppleScript, or Xcode for UI work.**
  The `sim` tools already wrap them, and raw commands bypass the scoped panel
  and the compact accessibility reader.
- Do not write tap/scroll/screenshot shell scripts. Call the tools.
- Do not build or run the app through Xcode. `sim_start` boots and opens the
  panel; `sim_launch` relaunches an installed app by bundle id.
- Never guess a tap coordinate from an image when the element has text, a
  label, or an id. Read the UI first and tap by identifier.
- If a tool fails, report its output. Do not silently fall back to Xcode
  command-line tools.

Tool names below are the agent-facing aliases. In Code Mode they are
`tools.sim.<name>` (`sim_ui` is `tools.sim.ui`).

## Start

1. `sim_devices` — list simulators, state, runtime, and UDID. Add
   `{ disk: true }` for size and a `free`/`in use` tag.
2. `sim_start({ udid?, app? })` — boot if needed, launch the app by bundle id,
   and open the Simulator panel **in the calling session**. It returns
   `panel=...` and the serve-sim URL. The panel opens before boot finishes, so a
   slow first boot shows the panel loader.
3. `sim_status` — confirm device, panel state, session state, app, screen size,
   AXe, and serve-sim.

`udid` accepts a UDID, an exact device name, or a unique name fragment.
Ambiguous fragments fail instead of guessing, so `iPhone 17` will not silently
pick one of two devices. Every tool remembers the device this session started.
If the device was returned to the pool, the tool tells you to run `sim_start` or
pass `udid`; it never falls back to another session's simulator. Without a
`udid`, `sim_start` reuses the session's device, then takes the first free
device of the same model and runtime, then creates `<model> #N`. It claims the
device, so two sessions never share one screen by accident. Pass `udid` only to
target a specific device; passing a UDID another session owns is an explicit
choice to share it. `sim_boot` boots without opening the panel; its claim is
released when the session goes idle, so use `sim_start` when the device must
stay across turns.

The first time a device is created it pays the simulator's cold boot (minutes).
It stays in the pool after that, so later sessions reuse it and boot in seconds.
The pool keeps up to five devices per model/runtime. When more than one
model/runtime is installed and none is booted, pass `udid` so the pool knows
which one to use.

## Parallel devices

A simulator is one UDID. Two sessions targeting the same UDID share one screen,
one app state, and one set of taps: they will fight. `sim_start` prevents that
by default:

```
sim_start({ app: "com.example.app" })   # first free iPhone 17 Pro
sim_start({ app: "com.example.app" })   # next free, or iPhone 17 Pro #2
```

The first session takes a free device. The second takes the next free one, or
the plugin creates `<model> #2` when all are busy. When `app` is given and
`sim_start` assigns a pool device, it is installed or refreshed from the
reference device or another booted simulator when possible; existing app data is
kept, and data is not copied from the source. Reusing the session's own device
just launches. Reused devices keep their installed apps and app data between
sessions. If several simulators are already booted, an unowned one is preferred;
when all belong to other sessions, the first booted device supplies the model
and runtime.

When all five devices for a model/runtime are in use, `sim_start` fails instead
of creating a sixth. Close a Simulator panel or delete a device to free one.

Use `sim_create` when you want to choose the source or name yourself:

```
sim_create({ from: "iPhone 17 Pro", app: "com.example.app" })
sim_start()
```

The source keeps running and its data is untouched. If you pass a `udid` that
another session owns, `sim_start` answers
`note=this simulator is also used by another session`; that is intentional
sharing.

## Returning a device

Close the Simulator panel when the parallel work is done. If the agent session
is idle, the device returns to the pool and shuts down after about a minute;
its data stays on disk. If the agent is still running, the device stays with the
session until the turn ends. An open panel keeps the device even when the agent
is idle, because the user may still be reading or tapping it.

Nothing is deleted automatically. Use `sim_delete({ udid })` to remove a device;
it shuts the device down first and refuses if another session still owns it
unless `force: true`. Do not delete the user's main simulator unless they ask.

The panel is session-scoped. It appears in the strip of the session that called
the tool, even if the user has switched to another session. It is also
device-scoped: it streams the simulator `sim_start` was given, even when other
simulators are already booted. Each session keeps its own device, so two
sessions can test two simulators independently. If the session is not on
screen, serve-sim does not start until its tab is shown; AXe-backed tools still
work in the meantime.

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
logical points. Prefer `text` or `id` from this table. The printed tap point is
for reading, not a `sim_tap` argument: `sim_tap` takes normalized `x`/`y` in
0..1 when you must tap a coordinate.

After launching, AX ids can be empty for a moment. Re-read `sim_ui` once before
concluding an element is missing. If the target is below the fold, scroll and
read again.

## Act

- `sim_tap({ text | id | label | value | x, y })` — tap one target. `text` is a
  substring over label/id/value and is the friendliest. Off-screen targets
  fail; scroll first.
- `sim_scroll({ direction: "up" | "down", amount?: 1..5 })` — scroll the
  focused scroll view.
- `sim_type({ text, submit? })` — type into the focused field. Tap the field
  first. `submit: true` presses Return.
- `sim_wait({ text, timeout? })` — poll until the text appears; returns PASS or
  FAIL. Use it after navigation or a submit instead of sleeping.
- `sim_button({ button })` — `home`, `lock`, `side-button`, `siri`, or
  `apple-pay`.
- `sim_launch({ bundleId })` — terminate and relaunch by bundle id, for a clean
  state.
- `sim_screenshot({ width? })` — 800px JPEG by default, returns a file path.
  Read the JPEG when a visual check matters; prefer `sim_ui` for structure
  because screenshots cost image tokens.

## Settings and input

- `sim_settings()` — list every setting. `sim_settings({ setting })` reads one;
  `sim_settings({ setting, value })` changes it. Settings: `appearance`,
  `liquid-glass`, `text-size`, `reduce-motion`, `increase-contrast`,
  `reduce-transparency`, `color-filter`, `show-borders`, `voiceover`,
  `hardware-keyboard`. Values include `dark`, `light`, `large`, `on`, `off`,
  `grayscale`, `tinted`.
- `sim_statusbar({ time?, batteryState?, batteryLevel?, wifiBars?,
  cellularBars?, dataNetwork?, operatorName? })` — override the status bar for
  deterministic screenshots. `sim_statusbar()` lists overrides;
  `sim_statusbar({ clear: true })` removes them.
- `sim_keyboard({ state: "show" | "hide" | "toggle" })` — the software
  keyboard. Focus a text field first; the panel must be open.
- `sim_rotate({ orientation })` — `portrait`, `portrait_upside_down`,
  `landscape_left`, or `landscape_right` via serve-sim. Some apps are
  portrait-only; a success result does not guarantee the app rotated.

## The test loop

```
sim_start({ app: "com.example.app" })
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

For a fresh state, `sim_launch({ bundleId })` before the loop. For a form, tap
each field, type, then use `sim_wait` for the next screen. For a visual review,
take one screenshot per state and describe what changed; do not stream
screenshots between every tap.

## Failure handling

- Ambiguous or missing device — ask which one, or pass the UDID from
  `sim_devices`. If the session has no simulator, run `sim_start`.
- `serve-sim=not running` — the panel has not been shown yet. Open the
  Simulator tab in the calling session, or use AXe-backed tools (status, UI,
  tap, scroll, type, wait, screenshot) which do not need it.
- The panel shows a different simulator — call `sim_start({ udid })` again with
  the device you want; the tab follows that device.
- `note=this simulator is also used by another session` — you passed a UDID that
  another session owns, so sharing is intentional. Omit `udid` next time to let
  `sim_start` take an independent device.
- All five simulators are in use — close a Simulator panel in another session or
  delete a device with `sim_delete`. The cap prevents the pool from growing
  forever.
- The panel shows no simulator — its device was returned to the pool. Run
  `sim_start` again; it takes the next free device or creates one.
- `pool=created ...` — this call paid the cold boot for a new pool device. Later
  sessions reuse it.
- `sim_keyboard` fails — focus a text field with `sim_tap` first.
- Tap misses — re-read `sim_ui`; layouts can shift after the keyboard or a
  transition. Prefer text/id over stored coordinates.
- AXe missing — the server falls back to serve-sim's accessibility endpoint.
  `sim_status` reports which is available.

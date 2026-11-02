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

1. `sim_devices` — list simulators, state, runtime, and UDID.
2. `sim_start({ udid?, app? })` — boot if needed, launch the app by bundle id,
   and open the Simulator panel **in the calling session**. It returns
   `panel=...` and the serve-sim URL.
3. `sim_status` — confirm device, app, screen size, AXe, and serve-sim.

`udid` accepts an exact device name (for example `iPhone 17 Pro`) or a UDID. It
never fuzzy-matches, so `iPhone 17 Pro` will not pick `iPhone 17 Pro 2`.
`sim_boot` boots without opening the panel. `sim_start` is the normal entry.

The panel is session-scoped. It appears in the strip of the session that
called the tool, even if the user has switched to another session. If that
session is not on screen, serve-sim does not start until its tab is shown;
AXe-backed tools still work in the meantime.

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
  `sim_devices`.
- `serve-sim=not running` — the panel has not been shown yet. Open the
  Simulator tab in the calling session, or use AXe-backed tools (status, UI,
  tap, scroll, type, wait, screenshot) which do not need it.
- `sim_keyboard` fails — focus a text field with `sim_tap` first.
- Tap misses — re-read `sim_ui`; layouts can shift after the keyboard or a
  transition. Prefer text/id over stored coordinates.
- AXe missing — the server falls back to serve-sim's accessibility endpoint.
  `sim_status` reports which is available.

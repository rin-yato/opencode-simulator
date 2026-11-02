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
   `{ disk: true }` for size and `copy`/`template` tags.
2. `sim_start({ udid?, app?, label? })` — boot if needed, launch the app by
   bundle id, and open the Simulator panel **in the calling session**. It
   returns `panel=...` and the serve-sim URL. The panel opens before boot
   finishes, so a slow first boot shows the panel loader.
3. `sim_status` — confirm device, app, screen size, AXe, and serve-sim.

`udid` accepts a UDID, an exact device name, or a unique name fragment.
Ambiguous fragments fail instead of guessing, so `iPhone 17` will not silently
pick one of two copies. Every tool remembers the device this session started.
`sim_start` also claims its device for the session: when the only candidate is
already owned by another session, it creates a copy automatically and installs
`app` from the source, so two sessions never share one screen by accident.
Pass `label` with a short purpose from the task (`"create order flow"`,
`"store profile settings"`) to name that copy semantically; the device becomes
`iPhone 17 Pro — create order flow`. If `label` is omitted, the session title is
used when available, falling back to `<source> Copy`. Pass `udid` only to
target a specific device; passing a UDID another session owns is an explicit
choice to share it. `sim_boot` boots without opening the panel. `sim_start` is
the normal entry.

The first cold copy can take minutes because a never-booted simulator prepares
its data volume. While that session runs, the plugin prepares a shut-down
`<model> — template` device. Later copies clone it and boot in seconds. If
`sim_start` says `template=preparing`, the next session benefits; if it says
`template=used`, the fast path was used.

## Parallel devices

A simulator is one UDID. Two sessions targeting the same UDID share one screen,
one app state, and one set of taps: they will fight. `sim_start` prevents that
by default:

```
sim_start({ app: "com.example.app", label: "create order flow" })
sim_start({ app: "com.example.app", label: "store profile settings" })
```

The session that already owns the device keeps it; the other session gets a
copy named after its `label`, or after the session title when no label is given.
The copy uses the candidate's model and runtime, installs `app` from it, and
becomes that session's default. It clones a warm template when one is ready, so
the first cold copy is the only slow one. App data is not copied from the
source; the copy starts with a fresh app install. If several simulators are
already booted, an unowned one is preferred; when all belong to other sessions,
the first booted device is the copy source.

Choose a label from what the session is actually testing. It should be short,
specific, and readable in `sim_devices`: `"create order flow"`,
`"store profile settings"`, `"checkout with coupon"`. Avoid `"test"`,
`"copy"`, or repeating the model name.

Use `sim_create` when you want to choose the source or name yourself:

```
sim_create({ from: "iPhone 17 Pro", app: "com.example.app" })
sim_start()
```

The source keeps running and its data is untouched. If you pass a `udid` that
another session owns, `sim_start` answers
`note=this simulator is also used by another session`; that is intentional
sharing.

When the parallel work is done, delete the copy with
`sim_delete({ udid })`. It shuts the device down first and refuses if another
session still owns it unless `force: true`. Do not delete the user's main
simulator unless they ask.

## Cleanup

Automatic copies are leased and cleaned up after 14 days idle. Only shut-down,
plugin-created copies are eligible; booted devices, templates, and `sim_create`
devices are not. Check space and tags, then prune early if needed:

```
sim_devices({ disk: true })
sim_prune({ olderThanDays: 7, dryRun: true })   # list
sim_prune({ olderThanDays: 7, dryRun: false })  # delete
```

`sim_prune` defaults to a dry run, so passing `dryRun: false` is required to
delete. The plugin runs the same sweep on startup. A `<model> — template`
device is the warm base for copies; do not delete one unless you want the next
copy to be slow again (`sim_delete` is safe and the template is recreated).

The panel is session-scoped. It appears in the strip of the session that
called the tool, even if the user has switched to another session. It is also
device-scoped: it streams the simulator `sim_start` was given, even when other
simulators are already booted. Each session keeps its own device, so two
sessions can test two simulators independently; switching sessions switches the
panel to that session's device. `sim_start` only affects the session that calls
it. If the session is not on screen, serve-sim does not start until its tab is
shown; AXe-backed tools still work in the meantime.

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
- The panel shows a different simulator — call `sim_start({ udid })` again with
  the device you want; the tab follows that device.
- `note=this simulator is also used by another session` — you passed a UDID that
  another session owns, so sharing is intentional. Omit `udid` next time to let
  `sim_start` create an independent copy.
- `template=preparing` — the first cold copy is booting and a warm template is
  being prepared in the background. Do not wait for it; the next session copies
  in seconds. `template=used` means the fast path ran.
- `<model> — template` in `sim_devices` is the warm base, not a session device.
  Omit `udid` to clone it; `sim_start({ udid: "<template>" })` is refused.
- `sim_prune` deletes nothing unless `dryRun: false` is passed. It only touches
  shut-down automatic copies, never templates or user devices.
- `sim_keyboard` fails — focus a text field with `sim_tap` first.
- Tap misses — re-read `sim_ui`; layouts can shift after the keyboard or a
  transition. Prefer text/id over stored coordinates.
- AXe missing — the server falls back to serve-sim's accessibility endpoint.
  `sim_status` reports which is available.

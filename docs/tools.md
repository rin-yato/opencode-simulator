# Tool reference

All tools are in the `sim` namespace. In Code Mode call them as
`tools.sim.<name>`.

## Common behavior

- `udid` accepts a UDID, an exact device name, or a unique name fragment.
  Ambiguous matches fail and list the candidates.
- Omitting `udid` targets the device the session started (`sim_start` or
  `sim_boot`), then the only booted simulator.
- Failures return `ERROR: <message>` in the content and `metadata.ok: false`.
  They do not throw across the tool boundary.
- Every result includes `metadata.udid` when a device was resolved.

## Lifecycle

### `sim_devices`

List simulators. Booted devices come first.

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `all` | boolean | `false` | Include unavailable devices |

Returns a tab-separated table: name, state, runtime, UDID.

### `sim_boot`

Boot a device without opening the panel.

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `udid` | string | session device | Device to boot |

The device becomes the session's default. Uses `bootstatus -b`, so it returns
after the simulator is ready.

### `sim_create`

Create a clean simulator from a source device's model and runtime.

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `from` | string | session device | Source simulator |
| `name` | string | `<source> Copy` | Name for the new device |
| `app` | string | none | Bundle id to install from the source |

When `app` is passed, the new device is booted and the app bundle is installed
from the source. App data is not copied. The new device becomes the session's
default.

The source keeps running. If the source app has no installed bundle for that id,
the device is still created and the install error is reported.

### `sim_delete`

Shut down and delete a simulator. **Destructive:** the device and all its data
are removed.

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `udid` | string | required | Device to delete |
| `force` | boolean | `false` | Delete even if another session owns it |

Also clears `session-devices` entries for that UDID. Use it for `sim_create`
copies; do not delete a user's main simulator unless they ask.

### `sim_start`

Boot, optionally launch an app, and open the panel in the calling session.

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `udid` | string | session device | Device to start |
| `app` | string | none | Bundle id to launch after boot |

Returns the boot result, the launched app when requested, and one of:

- `panel=opened serve-sim=http://127.0.0.1:<port>`
- `panel=opened; serve-sim starts when the Simulator tab is shown...`
- `panel=requested...` when the calling session is not mounted

When another session already owns the UDID, the result includes
`note=this simulator is also used by another session`. Create a copy with
`sim_create` for parallel work.

### `sim_launch`

Terminate and relaunch an app.

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `bundleId` | string | required | App bundle id |
| `terminate` | boolean | `true` | Terminate first |
| `args` | string[] | none | Launch arguments |

## Inspection

### `sim_status`

Return device name, UDID, state, foreground app, screen size, AXe version, and
serve-sim URL. A freshly booted device may reject the AX read for a moment; the
rest of the status is still returned.

### `sim_ui`

Read the compact accessibility table.

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `mode` | `visible` / `interactive` / `all` | `visible` | Row filter |
| `max` | integer 1..200 | `40` | Row cap |
| `find` | string | none | Case-insensitive label/id/value filter |

Each row is `idx`, `type`, `label`, `id`, `value`, and a logical tap point. The
tap point is for reading; `sim_tap` takes selectors or normalized `x`/`y`.

### `sim_wait`

Poll for text until it is visible.

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `text` | string | required | Substring of label, id, or value |
| `timeout` | number 0.1..60 | `5` | Seconds before giving up |
| `interval` | number 0.1..5 | `0.3` | Poll interval |

Returns `PASS <type> "<text>" tap=<point>` or `FAIL "<text>" ...`. If the row
exists but is off-screen, the failure says which direction to scroll.

### `sim_screenshot`

Capture the simulator and return a file path plus file content.

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `width` | integer 200..2000 | `800` | Resampled width |
| `format` | `jpeg` / `png` | `jpeg` | Output format |

Files live in `$TMPDIR/opencode-simulator/`, pruned to 24 hours and 200 files.
Prefer `sim_ui` for structure; images cost tokens.

## Input

### `sim_tap`

Tap exactly one target:

| Target | Example | Notes |
|---|---|---|
| `text` | `{ text: "Products" }` | Substring over label, id, and value |
| `id` | `{ id: "search" }` | Exact `AXUniqueId` |
| `label` | `{ label: "Close" }` | Exact `AXLabel` |
| `value` | `{ value: "On" }` | Exact `AXValue` |
| point | `{ x: 0.5, y: 0.8 }` | Normalized 0..1 |

`elementType` narrows a selector, for example `Button`. `wait` waits up to 30
seconds for the selector. Off-screen targets fail; scroll first.

### `sim_scroll`

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `direction` | `up` / `down` | required | `down` reveals content below |
| `amount` | integer 1..5 | `1` | Number of swipes |

Re-read `sim_ui` afterwards; layouts can shift.

### `sim_type`

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `text` | string | required | US keyboard characters |
| `submit` | boolean | `false` | Press Return afterwards |

Tap the field first. The software keyboard does not need to be visible.

### `sim_button`

Press `home`, `lock`, `side-button`, `siri`, or `apple-pay`. `duration` holds for
0..10 seconds. Uses serve-sim's HID path first, then AXe with Simulator.app
focused.

### `sim_rotate`

Rotate to `portrait`, `portrait_upside_down`, `landscape_left`, or
`landscape_right` through serve-sim. Some apps are portrait-only; success does
not guarantee the app rotated.

## Settings

### `sim_settings`

| Argument | Type | Meaning |
|---|---|---|
| `setting` | enum | Setting to read or change; omit to list all |
| `value` | string | New value; omit to read one |

Settings: `appearance`, `liquid-glass`, `text-size`, `reduce-motion`,
`increase-contrast`, `reduce-transparency`, `color-filter`, `show-borders`,
`voiceover`, `hardware-keyboard`.

Examples: `dark`, `light`, `large`, `extra-large`, `on`, `off`, `grayscale`,
`tinted`.

### `sim_keyboard`

`state`: `show`, `hide`, or `toggle` (default). Requires serve-sim, so the
Simulator panel must be open. Focus a text field first with `sim_tap`.

### `sim_statusbar`

Override or clear the status bar for deterministic screenshots.

| Argument | Type | Meaning |
|---|---|---|
| `clear` | boolean | Remove all overrides |
| `time` | string | For example `9:41` |
| `batteryState` | enum | `charging`, `charged`, `discharging` |
| `batteryLevel` | integer 0..100 | Battery percentage |
| `wifiBars` | integer 0..3 | Wi-Fi bars |
| `cellularBars` | integer 0..4 | Cellular bars |
| `dataNetwork` | enum | `hide`, `wifi`, `3g`, `4g`, `lte`, `lte-a`, `lte+`, `5g`, `5g+`, `5g-uwb`, `5g-uc` |
| `operatorName` | string | Carrier name; empty string clears it |

With no arguments it lists current overrides. With `clear: true` it removes
them.

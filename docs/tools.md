# Tool reference

All tools are in the `sim` namespace. In Code Mode call them as
`tools.sim.<name>`.

## Common behavior

- `udid` accepts a UDID, an exact device name, or a unique name fragment.
  Ambiguous matches fail and list the candidates. `sim_delete` is stricter: it
  requires an exact name or UDID. An explicit device another session owns
  requires `share: true` on every tool.
- Omitting `udid` targets the device the session started (`sim_start` or
  `sim_boot`). If the session has none, the tool asks you to run `sim_start` or
  pass `udid`; it never falls back to another session's simulator.
- Auto allocation is managed-only. `sim_start` reuses the session's managed
  device, then the first free managed device of the same model and runtime, then
  creates `<model> N`, up to five managed devices per model/runtime. An
  external simulator supplies the model/runtime and app source but is not
  claimed, refreshed, or shut down.
- A device returns to the pool when its panel closes and the agent session is
  idle. A `hold` keeps it across turns; `sim_release` returns it now. The plugin
  shuts released devices down after about a minute; data stays on disk.
- Nothing is deleted automatically. Use `sim_delete` with an exact name/UDID.
- Failures return `ERROR: <message>` in the content and `metadata.ok: false`.
  `status` is `ok`, `partial`, `error`, or `timeout`. Every result includes
  `metadata.udid` when a device was resolved.

## Lifecycle

### `sim_devices`

List simulators. Booted devices come first. The owner column is always present:
`in use (self)`, `in use (other)`, `free`, or `external`.

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `all` | boolean | `false` | Include unavailable devices |
| `disk` | boolean | `false` | Add approximate on-disk size (slower) |

Returns a tab-separated table: name, state, runtime, UDID, owner. With
`disk: true`, a `size` column is added. `metadata.devices` carries the same rows
as objects for Code Mode. `external` devices are not managed by the pool.

### `sim_boot`

Boot a device without opening the panel.

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `udid` | string | session device | Device to boot |
| `share` | boolean | `false` | Allow an explicit UDID another session owns |
| `hold` | boolean | `false` | Keep the device after this turn |
| `holdMinutes` | integer 1..1440 | none | Bound the hold; implies `hold` |

The device becomes the session's default and is claimed. Without a udid it uses
the same managed-pool selection as `sim_start`; it may create `<model> N`
(cold boot). Uses `bootstatus -b`, so it returns after the simulator is ready.
Without `hold`, the claim is released when the agent session goes idle.

### `sim_create`

Create a clean managed simulator from a source device's model and runtime.

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `from` | string | session device | Source simulator |
| `name` | string | `<model> N` | Name for the new device |
| `app` | string | none | Bundle id to install from the source |
| `force` | boolean | `false` | Create beyond five managed devices |

When `app` is passed, the new device is booted and the app bundle is installed
from the source. App data is not copied. The new device is managed and becomes
the session's default. The result says `state=Booted` or `state=Shutdown`; use
`sim_start` to boot and open its panel.

The source keeps running. If the source app has no installed bundle for that id,
the device is still created and the result is `partial`. A boot/claim failure
deletes the newly created device.

### `sim_delete`

Shut down and delete a simulator. **Destructive:** the device and all its data
are removed.

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `udid` | string | required | Exact UDID or exact name |
| `force` | boolean | `false` | Allow external, panel-owned, or other-session devices |

Deleting a managed free device needs no force. External devices, devices with an
open panel, and devices owned by another session require `force: true`. The
window clears the device, the hub stops, and a deleted event prevents the next
heartbeat from re-claiming it.

### `sim_start`

Boot, optionally launch an app, and open the panel in the calling session.

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `udid` | string | session device | Device to start |
| `app` | string | none | Bundle id to launch after boot |
| `share` | boolean | `false` | Allow an explicit UDID another session owns |
| `hold` | boolean | `false` | Keep the device after this turn |
| `holdMinutes` | integer 1..1440 | none | Bound the hold; implies `hold` |

Returns the boot result, `release=held|panel|turn|idle`, the launched app when
requested, and one of:

- `panel=opened serve-sim=http://127.0.0.1:<port>`
- `panel=opened; serve-sim is still starting in the panel.`
- `panel=requested...` when the calling session is not mounted

Without an explicit `udid`, `sim_start` reuses the session's managed device,
then takes the first free managed device of the same model and runtime, then
creates `<model> N`. External simulators are never auto-claimed. An explicit
UDID may target an external device or another session (the latter requires
`share: true`).

A managed device's name follows its claim: while a session holds it the name
ends with ` · in use`, and the mark is stripped when the claim is released. The
mark is cosmetic. `udid` still accepts the plain name or the UDID, and
`sim_devices` reports the owner separately as `in use (self)`, `in use
(other)`, `free`, or `external`.

When `app` is given and this call assigns a managed device, it is installed or
refreshed from the reference device or another managed simulator. Installing
over an existing bundle keeps app data. Reusing the session's own or an external
device just launches. Install/launch failures return `status: "partial"` with
`ok: false`.

### `sim_release`

Release this session's simulator now, clearing its claim, hold, and panel.

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `udid` | string | session device | Optional exact device to release |

Use it when a device was held or the agent is done before closing the panel. An
automatic release still happens when the panel closes and the session is idle.

### `sim_install`

Install a local `.app` bundle on the session's simulator.

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `path` | string | required | Path to a `.app` bundle |
| `udid` | string | session device | Target device |
| `share` | boolean | `false` | Allow a UDID another session owns |

Boots the device if needed. This is the supported way to test a fresh build.

### `sim_apps`

List installed apps as bundle id and name. Boots the device if needed.

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `udid` | string | session device | Target device |

### `sim_uninstall`

Uninstall an app bundle from the session's simulator.

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `bundleId` | string | required | Bundle identifier |
| `udid` | string | session device | Target device |
| `share` | boolean | `false` | Allow a UDID another session owns |

### `sim_erase`

Erase a simulator's contents and settings, removing all app data. **Destructive.**
Requires `force: true`. The device is left shut down.

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `udid` | string | session device | Target device |
| `force` | boolean | `false` | Confirm the data loss |

### `sim_launch`

Terminate and relaunch an app. This resets the app's in-memory state, not its
data; use `sim_erase` or a new device for a clean data state.

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `bundleId` | string | required | App bundle id |
| `terminate` | boolean | `true` | Terminate first |
| `args` | string[] | none | Launch arguments |

## Inspection

### `sim_status`

Return device name, UDID, state, `managed=yes|no`, panel state (`visible`,
`active`, `open`, or `closed`), the panel's device when it differs, release
state (`held`, `panel`, `turn`, or `idle`), whether the agent session is
running, foreground app, screen size, AXe version, and serve-sim URL. A freshly
booted device may reject the AX read for a moment; the rest of the status is
still returned.

### `sim_ui`

Read the compact accessibility table.

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `mode` | `visible` / `interactive` / `all` | `visible` | Row filter |
| `max` | integer 1..200 | `40` | Row cap |
| `find` | string | none | Case-insensitive label/id/value filter |

Each row is `idx`, `type`, `label`, `id`, `value`, and a logical tap point.
`sim_tap` accepts that logical point directly, or normalized `x`/`y` when both
coordinates are `0..1`.

### `sim_wait`

Poll for text until it is visible.

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `text` | string | required | Substring of label, id, or value |
| `timeout` | number 0.1..60 | `5` | Seconds before giving up |
| `interval` | number 0.1..5 | `0.3` | Poll interval |

Returns `PASS <type> "<text>" tap=<point>` or `FAIL "<text>" ...` with
`metadata.ok: false` and `status: "timeout"`. If the row exists but is
off-screen, the failure says which direction to scroll.

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
| point | `{ x: 200, y: 640 }` | Logical points from `sim_ui` |

`elementType` narrows a selector, for example `Button`. `wait` waits up to 30
seconds for the selector or text. `nth` picks a visible match when text is
ambiguous; without it, multiple visible interactive matches fail instead of
guessing. Off-screen targets fail; scroll first.

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
0..10 seconds and uses the AXe path with Simulator.app focused; a duration of 0
uses serve-sim's HID path.

### `sim_rotate`

Rotate to `portrait`, `portrait_upside_down`, `landscape_left`, or
`landscape_right` through serve-sim. Requires the Simulator panel to be open.
Some apps are portrait-only; success does not guarantee the app rotated.

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
`tinted`. Requires the Simulator panel to be open (serve-sim).

### `sim_keyboard`

`state`: `show` (default), `hide`, or `toggle`. Requires serve-sim, so the
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

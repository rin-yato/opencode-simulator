# Contributing

Thanks for helping improve opencode-simulator. The project is small and
deliberately dependency-light, so changes are easy to audit.

## Setup

```sh
git clone https://github.com/rin-yato/opencode-simulator.git
cd opencode-simulator
bun install
bun run check
bun run build
```

Requirements: macOS, Xcode with at least one iOS runtime, Node 22+ on `PATH`,
and optionally [AXe](https://github.com/cameroncooke/AXe) 1.8+.

To use your checkout in OpenCode, add its absolute path to the `plugins` array
in `~/.config/opencode/opencode.jsonc`. Config changes reload the server part.
After changing GUI code, run `bun run build`; the bundle is not committed.

## Scripts

| Script | Purpose |
|---|---|
| `bun run check` | Typecheck and unit tests |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run test` | Bun tests |
| `bun run build` | Build `dist/gui-experimental.cjs` |
| `bun run dev` | Rebuild the GUI on change |
| `bun run format` | Prettier |

## Code map

See [docs/architecture.md](docs/architecture.md). In short:

- `src/server/` is loaded directly from source by the OpenCode server.
- `src/gui/` is bundled for the desktop window and main process.
- `src/server/tools/` groups tools by responsibility. Add a tool to the group
  that matches its behavior, not to a new file.
- `src/skills/simulator.md` is the agent-facing contract. If tool behavior
  changes, update the skill and `docs/tools.md`.

## Guidelines

- Keep tool input schemas and descriptions accurate. Agents read them literally.
- Use argument arrays with `execFile`/`spawn`. Do not build shell strings.
- Do not add a runtime dependency without a clear reason. Prefer the platform
  tools already wrapped by `src/server/`.
- Keep output compact. `sim_ui` is a token budget, not a debug dump.
- Bound anything that accumulates: maps, files, and stored state.
- Preserve session and device scoping. A tool must never fall back to the
  focused session or the first booted simulator by accident.
- Do not add telemetry, analytics, or outbound network calls.

## Testing

Automated tests cover pure logic:

```sh
bun run test
```

Before opening a pull request that changes device, panel, or serve-sim behavior,
test on a real Mac:

1. Boot two simulators of the same model.
2. In one session, `sim_start({ udid: "<first>" })`.
3. Open a second session and `sim_start({ udid: "<second>" })`.
4. Confirm each session's panel shows its own device and each session's
   `sim_status()` reports its own UDID.
5. Close one panel, wait 30 seconds, and confirm only that device's hub stops
   (`ps aux | grep serve-sim`).
6. Run `sim_create` and `sim_delete` once, and confirm no test device is left in
   `xcrun simctl list devices`.

If you cannot test on macOS, say so in the pull request. Typecheck and unit tests
still run in CI.

## Pull requests

- Keep the change focused.
- Update `README.md`, `docs/tools.md`, or `src/skills/simulator.md` when the
  user-visible behavior changes.
- Run `bun run check` and `bun run build`.
- Describe how you verified the behavior.
- Do not commit `dist/`, `node_modules/`, screenshots, or personal paths.

## Commit messages

Short imperative subject, then a body when the change needs context:

```text
Bound screenshot retention

Keep the last 24 hours or 200 files, whichever is smaller.
Report the retained path in the tool result.
```

# AGENTS.md

## What this is

An OpenCode Desktop plugin for macOS with three parts:

- **Server** (`src/server/`, `src/index.ts`): registers the `sim` tools, the bundled skill, and the `open` RPC event.
- **GUI window** (`src/gui.tsx`, `src/gui/panel.tsx`): the panel, menu item, and command.
- **GUI main** (`src/gui/main.ts`, `src/gui/hub.ts`): panes and one serve-sim process per device.

## Commands

```sh
bun install
bun run check     # typecheck + unit tests
bun audit         # exits 1 for the known moderates below
bun run build     # dist/gui-experimental.cjs
bun run changeset # add a release changeset
bun run dev       # GUI watch mode
bun run format
```

The server loads from `src/`. The GUI is bundled and `dist/` is not committed, so run `bun run build` after GUI changes.

`bun audit` reports two moderate advisories through `@opencode/plugin`'s pinned `glob` and `minimatch`. They are tooling dependencies, not in the GUI bundle. Do not force major overrides without checking the OpenCode SDK.

## Releases

Every push to `main` runs `.github/workflows/release.yml`. It consumes pending changesets (or makes a patch one), bumps the version, commits `chore(release): vX.Y.Z`, and publishes to npm with trusted publishing (OIDC, no token). The trusted publisher on npmjs.com names this repo and `release.yml`; renaming the workflow breaks publishing. Add `bun run changeset` output to a PR for a minor or major bump. Retry with `gh workflow run release.yml`. Test versioning in a throwaway clone with `DRY_RUN=true bash scripts/release.sh`. The release commits to `main`, so keep it unprotected.

## How it works

- OpenCode runs one plugin instance per project in one server process, and storage is global. Every instance shares one process-wide pool (`src/server/shared-pool.ts`). One server process is assumed.
- Allocation is in `src/server/allocate.ts`, claims in `src/server/simulator-pool.ts`, and busy state, panel leases, holds, and shutdown in `src/server/activity.ts`.
- A claim ends when no panel, no running turn, and no hold remain. A released managed device shuts down after a minute, keeps its data, and is never auto-deleted.
- Panels are 30s leases refreshed by a 10s heartbeat from the window. serve-sim runs per device, is owned by GUI main, and stops 30s after its last pane.

## Rules

- Resolve the calling session's device. Never fall back to the focused session or the first booted simulator.
- One UDID is one simulator. Two sessions on one UDID share screen and state, so `sim_start` allocates a free managed pool device by default. `from` selects a model. External devices are never auto-claimed, auto-refreshed, or auto-shut down. Use `sim_create` for an explicitly named managed device.
- A managed device's name follows its claim (`iPhone 17 Pro 2 · in use`) and is cosmetic. Match on the UDID or the plain name in `simulator-managed`, never the marked name. External devices are never renamed.
- Spawn with argument arrays (`execFile`/`spawn`), never shell strings.
- Keep state bounded: session maps cap at 500 entries, managed devices at 200 with five per model/runtime, screenshots at 24 hours and 200 files.
- Tool descriptions and `src/skills/simulator.md` are the agent-facing API. Update them when behavior changes.
- No telemetry or outbound requests. serve-sim binds to loopback only.
- serve-sim must run under system Node, never Electron. Its native addon is signed by Expo.

## Verify

- `bun run check`
- `bun run build`
- For panel or device changes, test on macOS with two booted simulators: one `sim_start` in each of two sessions. Confirm each panel follows its own device and `ps` shows one serve-sim per device.
- Do not leave test simulators behind. Pool devices are real disk images; delete them with `sim_delete`.

# AGENTS.md

## What this is

An OpenCode Desktop plugin for macOS. It has three parts:

- **Server** (`src/server/`, `src/index.ts`): registers the `sim` tools, the
  bundled skill, and the `open` RPC event.
- **GUI window** (`src/gui.tsx`, `src/gui/panel.tsx`): the panel, menu item, and
  command.
- **GUI main** (`src/gui/main.ts`, `src/gui/hub.ts`): panes and one serve-sim
  process per device.

Read [docs/architecture.md](docs/architecture.md) before changing lifecycle,
session scoping, or the hub.

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

Publishing is automatic. Every push to `main` runs
`.github/workflows/release.yml`, which consumes pending changesets (or creates a
patch changeset when there are none), bumps the version, commits
`chore(release): vX.Y.Z`, and publishes to npm. Add `bun run changeset` output to
a PR to choose a minor or major bump. Retry a failed release with
`gh workflow run release.yml`.

The workflow uses npm trusted publishing (OIDC), so there is no npm token or
repository secret. The trusted publisher on npmjs.com must name this repository
and `release.yml`, and must allow `npm publish`. Renaming the workflow breaks
publishing until that configuration is replaced. Provenance is not generated
while the repository is private. Test the versioning in a throwaway clone with
`DRY_RUN=true bash scripts/release.sh`; it leaves the version bump in that
clone's working tree.

`bun audit` reports two moderate advisories through `@opencode/plugin`'s pinned
`glob` and `minimatch`. They are tooling dependencies, not part of the GUI bundle;
do not force major overrides without checking the OpenCode SDK. The automated
release commits to `main`, so keep that branch unprotected or replace the script
with a version-PR flow before enabling branch protection.

The server part loads from `src/`. The GUI is bundled. `dist/` is not committed;
run `bun run build` after GUI changes.

## Rules

- Resolve the calling session's device. Never fall back to the focused session
  or the first booted simulator.
- One UDID is one simulator. Two sessions on one UDID share screen and state;
  `sim_start` allocates a free managed pool device by default. External devices
  are reference/source only; never auto-claim, auto-refresh, or auto-shut them
  down. Use `sim_create` for an explicitly named managed device.
- A managed device's name follows its claim (`iPhone 17 Pro 2 · in use`) and is
  cosmetic: match on the UDID or the plain name in `simulator-managed`, never on
  the marked name. External devices are never renamed.
- Spawn with argument arrays (`execFile`/`spawn`), never shell strings.
- Keep state bounded: session maps cap at 500 entries, managed devices at 200
  with five per model/runtime, screenshots at 24 hours and 200 files.
- Tool descriptions are agent-facing API. Update `docs/tools.md` and
  `src/skills/simulator.md` when behavior changes.
- No telemetry or outbound requests. serve-sim binds to loopback only.
- serve-sim must run under system Node, never Electron. Its native addon is
  signed by Expo.

## Verify

- `bun run check`
- `bun run build`
- For panel or device changes, test on macOS with two booted simulators: one
  `sim_start` in each of two sessions, confirm each panel follows its own
  device, and confirm `ps` shows one serve-sim per device.
- Do not leave test simulators behind. Pool devices are real disk images; delete
  them with `sim_delete`.

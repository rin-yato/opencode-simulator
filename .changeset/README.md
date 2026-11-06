# Changesets

This folder holds the changesets that describe releases. Add one with
`bun run changeset` when a change should control the next version bump.

You do not need to add one for every push: the release workflow creates a patch
changeset when a push to `main` has none. Use a `minor` or `major` changeset
when the change needs a larger bump.

# Staying aligned with upstream `pi-mono`

## Goals

- Keep persistent code changes mostly under `packages/mom/`.
- Match `@mariozechner/pi-agent-core`, `pi-ai`, and `pi-coding-agent` versions in `packages/mom/package.json` to the same release line as upstream `mom`.

## Cadence

- **Weekly** or whenever `@mariozechner/pi-mom` is published on npm: compare your branch with official `main`.
- **At least monthly**: merge or rebase official `main`, rebuild, run a Slack smoke test.

## Merge checklist

1. Create a backup branch: `git branch backup/pre-merge-$(date +%Y%m%d)`.
2. Fetch and integrate the official branch (`upstream/main` or `origin/main` if you only track badlogic).
3. Resolve conflicts: prefer upstream outside `packages/mom/`; re-apply your intent inside `packages/mom/` if needed.
4. Confirm `packages/mom/package.json` dependency versions for `@mariozechner/*` match upstream `mom` for that revision.
5. From monorepo root:

   ```bash
   npm ci
   npm run build --workspace=@mariozechner/pi-tui
   npm run build --workspace=@mariozechner/pi-ai
   npm run build --workspace=@mariozechner/pi-agent-core
   npm run build --workspace=@mariozechner/pi-coding-agent
   npm run build --workspace=@mariozechner/pi-mom
   ```

6. Record the merge in `CHANGELOG.md` (this package) with the upstream SHA and date.
7. Tag and publish your scoped package if you distribute one.

## Shallow clones

If `git rev-parse --is-shallow-repository` prints `true`, run `git fetch --unshallow` before large merges, or clone without `--depth 1`.

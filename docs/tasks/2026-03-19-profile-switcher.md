# Profile Switcher

## What

Added a named profile switcher for the local pi runtime so the main session model and the agent model pack can switch together with `/profile <name>` or `--profile <name>`.

## Why

The live setup already had per-agent model frontmatter and a persisted default main model, but switching between a GPT-oriented setup and a Claude-oriented setup still required manual edits across multiple files. That was slow and easy to drift.

## Changed

- added `packages/coding-agent/examples/extensions/profile-switcher/index.ts`
- added `packages/coding-agent/examples/extensions/profile-switcher/profiles.ts`
- added `packages/coding-agent/test/profile-switcher.test.ts`
- updated `packages/coding-agent/CHANGELOG.md`
- added `~/.pi/agent/profiles.json` with `openai` and `anthropic` profiles
- added `~/.pi/agent/extensions/profile-switcher/index.ts` and `profiles.ts` symlinks to the repo extension
- updated `~/.pi/agent/extensions/model-fallback/index.ts` so fallback targets follow the active profile from `profiles.json`
- updated `~/.pi/agent/settings.json` so `enabledModels` matches the active `openai` profile

## Verified by

- `npx tsx ../../node_modules/vitest/dist/cli.js --run test/profile-switcher.test.ts`
- `pi --mode json -p --no-session --profile openai "Reply with OK only."`
- `npm run check`

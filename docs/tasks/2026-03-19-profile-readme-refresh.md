## What

Refreshed the profile-switcher documentation so the README set matches the live `openai` and `anthropic` profile packs under `~/.pi/agent/profiles.json`.

## Why

The earlier docs only showed a tiny single-profile example and did not document the real mixed-model routing now used locally, especially the `claude-sonnet-4-6` requirement for the `anthropic` pack.

## Changed

- Updated `README-Before-Update.md` with the current live profile packs and the `claude-sonnet-4-6` registry dependency.
- Updated `packages/coding-agent/examples/extensions/profile-switcher/README.md` with the real local `openai` and `anthropic` mappings plus reload and validation notes.
- Updated `packages/coding-agent/examples/extensions/README.md` to describe mixed GPT/Claude specialist packs.
- Updated `packages/coding-agent/README.md` to explain the profile-switcher use case in the extensions section.

## Verified by

- Manual doc review against `/Users/besi/.pi/agent/profiles.json`
- Manual doc review against `/Users/besi/.pi/agent/models.json`

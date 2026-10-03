# Changelog

## [Unreleased]

### Fixed

- Nested launches under a materialized profile (a child pi process inheriting `PI_CODING_AGENT_DIR=<profile dir>`, e.g. a sub-agent subprocess) no longer break the profile: `refreshSharedLinks` is a no-op when the source agent dir equals the profile dir, so `removeStaleLink` can't delete the profile's real shared content (e.g. the `sessions` symlink) out from under the parent process.
- Parallel pi processes re-materializing the same profile (e.g. several concurrent sub-agent children launched under `pipi --as <profile>`) no longer crash each other with `SyntaxError: Unexpected end of JSON input`: `writeJson`/`writeAuthFile` now write atomically (same-dir tmp + rename, so readers never see a truncated file), and `readJson` retries briefly when a concurrent non-atomic writer (upstream pi's settings persistence) leaves a file momentarily empty. Previously, N parallel children all ran `materializeProfile` on the same profile dir, and one's truncate-then-write of `settings.json`/`auth.json` landed in another's read window, killing the child and failing the sub-agent tool call.
- `packages` edits made while running under a profile (e.g. `pipi install`/`pipi remove`, resource toggles) are no longer lost: `packages` is a general key, and with the runtime settings layering below pi-plus now writes it straight to the agent `settings.json` (the profile copy holds only profile-scoped keys), so no exit sync is needed. `materializeProfile` still adopts any divergence from the per-profile packages snapshot into the source before regenerating, which migrates copies baked before the layering change.

### Removed

- The deprecated `run` subcommand. `pipi --as <name>` (one-off launch) and `pipi use <name>` (default) cover its behavior; `dispatchHubCommand` returns a promise only when it awaits the caller-injected provider login.
- Shell completion (`completion` subcommand and the bash/zsh script generators) moved to the pi-plus override layer, which owns the published `pipi` CLI surface.
- The built-in default profile: the `__builtin__` sentinel (`BUILT_IN_DEFAULT`) and the `--built-in` flag on `use` / `profile default` are gone — plain pi is now expressed by the absence of a `default` key (`pipi unuse`). A stored `profiles.json` still holding the legacy marker reads as "no default" and runs plain pi, and `clearDefaultProfile` deletes the key instead of writing the marker.

### Added

- Initial release: migrated from the standalone `pi-hub-cli` repo. Named profiles (provider, up to 3 models, thinking level, token, base URL, settings overrides) stored in `~/.pi/profiles.json`; each profile gets a materialized isolated agent dir under `~/.pi/pi-hub/profiles/<name>/` (auth.json / settings.json / models.json plus symlinks to the shared `extensions/`, `skills/`, `npm/`, `sessions/`, `AGENTS.md`, `models-store.json`). Library-only package: command dispatch (`profile`, `use`, `unuse`) and launch resolution (`resolveLaunch`) are consumed by the pi-plus CLI wrapper.
- `dispatchHubCommand` accepts `HubCommandOptions` with an optional `login` hook: when `profile add <name> -p <provider>` carries no credential, the saved profile delegates the provider's interactive login (OAuth login page / API-key setup) to the caller, which persists the credential into the profile's materialized agent dir. Hub stays dependency-free — the `pipi` CLI injects the flow from the pi model runtime. A failed or cancelled login is reported non-fatally and keeps the profile.

### Changed

- `materializeProfile` no longer bakes a full copy of the agent `settings.json` into the profile dir. The profile `settings.json` now holds only profile-scoped keys (`defaultProvider`/`defaultModel`, exported as `PROFILE_SETTINGS_KEYS`) plus the profile's declared `settings` overrides (a declared thinking level still lands as `defaultThinkingLevel`); pi-plus layers it over the agent settings at runtime, which reads and edits the agent file live. Re-materializing prunes general keys from legacy baked copies, migrating each into the agent `settings.json` when it lacks that key (the agent file wins on conflict); hooks are no longer force-replicated since the runtime loader reads the agent layer directly, and a nested launch (agent dir already pointing at the profile dir) preserves the profile's live file instead of regenerating it.
- `writeAuthFile` no longer deletes a profile's `auth.json` when the profile has no token. The file can hold credentials written by a provider login (`profile add -p`, stored as OAuth entries) or refreshed by pi at runtime, and `materializeProfile` runs on every launch — deleting it there wiped them. It is now left untouched; a token still writes/overwrites only the profile provider's api_key entry.

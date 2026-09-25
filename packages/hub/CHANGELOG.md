# Changelog

## [Unreleased]

### Fixed

- Nested launches under a materialized profile (a child pi process inheriting `PI_CODING_AGENT_DIR=<profile dir>`, e.g. a sub-agent subprocess) no longer break the profile: `refreshSharedLinks` is a no-op when the source agent dir equals the profile dir, so `removeStaleLink` can't delete the profile's real shared content (e.g. the `sessions` symlink) out from under the parent process.
- Parallel pi processes re-materializing the same profile (e.g. several concurrent sub-agent children launched under `pipi --as <profile>`) no longer crash each other with `SyntaxError: Unexpected end of JSON input`: `writeJson`/`writeAuthFile` now write atomically (same-dir tmp + rename, so readers never see a truncated file), and `readJson` retries briefly when a concurrent non-atomic writer (upstream pi's settings persistence) leaves a file momentarily empty. Previously, N parallel children all ran `materializeProfile` on the same profile dir, and one's truncate-then-write of `settings.json`/`auth.json` landed in another's read window, killing the child and failing the sub-agent tool call.
- `packages` edits made while running under a profile (e.g. `pipi install`/`pipi remove`, resource toggles) are no longer lost: `syncProfilePackagesToSource` writes the profile copy's `packages` back to the source agent settings at process exit, and `materializeProfile` adopts any divergence from the per-profile packages snapshot (crash before the exit sync) into the source before regenerating. Previously the extension was uninstalled from the shared `npm/` dir but the source `settings.json` kept listing it, so it was reinstalled on next launch.

### Removed

- The deprecated `run` subcommand. `pipi --as <name>` (one-off launch) and `pipi use <name>` (default) cover its behavior; `dispatchHubCommand` now returns `void` since all hub subcommands are self-contained management commands.
- Shell completion (`completion` subcommand and the bash/zsh script generators) moved to the pi-plus override layer, which owns the published `pipi` CLI surface.

### Added

- Initial release: migrated from the standalone `pi-hub-cli` repo. Named profiles (provider, up to 3 models, thinking level, token, base URL, settings overrides) stored in `~/.pi/profiles.json`; each profile gets a materialized isolated agent dir under `~/.pi/pi-hub/profiles/<name>/` (auth.json / settings.json / models.json plus symlinks to the shared `extensions/`, `skills/`, `npm/`, `sessions/`, `AGENTS.md`, `models-store.json`). Library-only package: command dispatch (`profile`, `use`, `unuse`) and launch resolution (`resolveLaunch`) are consumed by the pi-plus CLI wrapper.

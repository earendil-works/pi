# @earendil-works/pi-hub

Named profiles for the pi coding agent: provider, up to 3 models, thinking level, API token, and base URL, switched at launch.

Profiles are stored in `~/.pi/profiles.json` (mode 0600). At launch, a profile is **materialized** into an isolated agent dir under `~/.pi/pi-hub/profiles/<name>/`:

- `auth.json` — the profile's `api_key` entry under its provider
- `settings.json` — a copy of the source agent settings with profile overrides merged (profile-scoped `defaultProvider`/`defaultModel`/`defaultThinkingLevel` come only from the profile). The `packages` list is the exception: it is global (extensions live in the shared dirs), so pi-plus syncs it back into the source agent settings at process exit, and materialization adopts any divergence recorded in the per-profile `packages.snapshot.json` (crash before the exit sync) before regenerating.
- `models.json` — `baseUrl` override for the profile's provider
- symlinks (with copy fallback) to the shared `extensions/`, `skills/`, `npm/`, `sessions/` dirs and `AGENTS.md`, `models-store.json`

The consuming CLI points `PI_CODING_AGENT_DIR` at the materialized dir, giving per-profile credential isolation while sessions/extensions/skills stay shared.

This package is a library: it exposes profile CRUD, the materializer, launch resolution (`resolveLaunch`), and subcommand dispatch (`dispatchHubCommand`). The pi-plus CLI (`packages/plus-cli`) wires these behind `pipi profile …`, `pipi use` / `pipi unuse`, and the `pipi --as <name>` flag.

## State files and env overrides

| Path                                | Env override          |
| ----------------------------------- | --------------------- |
| `~/.pi/profiles.json`               | `PI_HUB_PROFILES_FILE` |
| `~/.pi/pi-hub/profiles/<name>/`     | `PI_HUB_DIR`          |
| `~/.pi` (base for defaults)         | `PI_HUB_PI_DIR`       |
| `~/.pi/pi-hub/logs/`                | `PI_HUB_DIR`          |

The source agent dir defaults to `~/.pi/agent` and honours `PI_CODING_AGENT_DIR`, same as pi.

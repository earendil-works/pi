# @earendil-works/pi-hub

Named profiles for the pi coding agent: provider, up to 3 models, thinking level, API token, and base URL, switched at launch.

Profiles are stored in `~/.pi/profiles.json` (mode 0600). At launch, a profile is **materialized** into an isolated agent dir under `~/.pi/pi-hub/profiles/<name>/`:

- `auth.json` — the profile's `api_key` entry under its provider. When the profile has no token the file is left untouched (not deleted), so credentials written by a provider login (`profile add <name> -p <provider>`, via the injected `login` hook — typically OAuth entries) survive every re-materialization at launch.
- `settings.json` — the profile layer of the runtime settings stack, not a copy of the agent settings: pi-plus's settings manager (packages/plus) reads both files live and deep-merges them at runtime, profile wins. The file therefore only carries the profile-scoped keys pi persists under a profile (`defaultProvider`/`defaultModel`), the profile's `settings` overrides, a `defaultThinkingLevel` when `profile.thinking` declares it, and the `skills` insurance from `~/.pi/settings.json`. General keys baked into profile copies by earlier hub versions are pruned at materialization — moved into the agent settings.json when it lacks them, dropped when it has them (legacy `packages` edits are first adopted into the source via `packages.snapshot.json`).
- `models.json` — `baseUrl` override for the profile's provider
- symlinks (with copy fallback) to the shared `extensions/`, `skills/`, `npm/`, `sessions/` dirs and `AGENTS.md`, `models-store.json`

The consuming CLI points `PI_CODING_AGENT_DIR` at the materialized dir, giving per-profile credential isolation while sessions/extensions/skills stay shared.

This package is a library: it exposes profile CRUD, the materializer, launch resolution (`resolveLaunch`), and subcommand dispatch (`dispatchHubCommand`). The pi-plus CLI (`packages/plus-cli`) wires these behind `pipi profile …`, `pipi use` / `pipi unuse`, and the `pipi --as <name>` flag. No default profile means plain pi (`pipi unuse` clears the default).

Hub is dependency-free and cannot run a provider login itself, so `dispatchHubCommand(args, options)` accepts an injected `login` hook (`HubCommandOptions`): when `profile add <name> -p <provider>` carries no credential, the profile is saved and materialized first, then the caller-provided login runs against the profile's agent dir (the pi-plus CLI injects the pi model-runtime OAuth/API-key flow). A cancelled or failed login keeps the profile and reports how to add a token later. The promise `dispatchHubCommand` returns is only for this path; invalid usage still throws synchronously.

## State files and env overrides

| Path                                | Env override          |
| ----------------------------------- | --------------------- |
| `~/.pi/profiles.json`               | `PI_HUB_PROFILES_FILE` |
| `~/.pi/pi-hub/profiles/<name>/`     | `PI_HUB_DIR`          |
| `~/.pi` (base for defaults)         | `PI_HUB_PI_DIR`       |
| `~/.pi/pi-hub/logs/`                | `PI_HUB_DIR`          |

The source agent dir defaults to `~/.pi/agent` and honours `PI_CODING_AGENT_DIR`, same as pi.

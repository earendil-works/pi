# Python Port Parity Checklist

This document tracks behavioral parity between the TypeScript packages (`packages/*`) and the Python port (`python/src/pi_mono`). Use it when reviewing releases or planning follow-up work.

## Legend

| Status | Meaning |
|--------|---------|
| **Match** | Same behavior and API surface for the covered scope |
| **Partial** | Core behavior works; gaps remain in edge cases or polish |
| **Diverge** | Intentional difference (documented below) |
| **Missing** | Not yet ported |

## Packages

| Area | TS source | Python target | Status |
|------|-----------|---------------|--------|
| AI providers & models | `packages/ai` | `pi_mono.ai` | **Match** (v0.80: `max` thinking, input pricing tiers, `Usage.reasoning`) |
| Agent runtime | `packages/agent` | `pi_mono.agent` | **Match** |
| Terminal UI | `packages/tui` | `pi_mono.tui` | **Match** |
| Coding agent CLI | `packages/coding-agent` | `pi_mono.coding_agent` | **Partial** (v0.80 ports: RPC get_entries/get_tree, outputPad, externalEditor, shellPath ~) |

## CLI & modes

| Feature | Status | Notes |
|---------|--------|-------|
| `parseArgs` / CLI flags | **Match** | See `test_phase5_parity.py::TestArgsParity` |
| Print mode (`-p`, `--print`) | **Match** | Text and JSON output |
| JSON event mode (`--mode json`) | **Match** | |
| RPC mode (`--mode rpc`) | **Match** | Preflight prompt semantics, `get_commands`, `parentSession` aligned with TS |
| Interactive TUI | **Partial** | `/model`, `/settings`, `/sessions`, `/tree`, `/scoped-models`, and extension UI use editor-area selectors; model search ranking aligned with TS; extension dialogs support timeout countdown; paste markers + Ctrl+J newline |
| `pi config` | **Match** | `-l` project-local scope, Tab switch, `--approve`/`--no-approve` |
| Session fork / resume / import | **Match** | |
| `pi update` self-update | **Partial** | CLI flags present; install path depends on distribution method; version-check failures skip update instead of forcing it |
| Export HTML / share | **Partial** | Export exists; share flow lighter than TS |

## Trust & security

| Feature | Status | Notes |
|---------|--------|-------|
| `ProjectTrustStore` inheritance | **Match** | |
| Trust-requiring resource detection | **Match** | |
| Interactive trust selector | **Match** | |
| `/trust` slash command | **Match** | |
| Extension `project_trust` event | **Match** | |
| `--approve` / `--no-approve` | **Match** | |

## Extensions

| Feature | Status | Notes |
|---------|--------|-------|
| Python extension loader | **Match** | `.py` extensions via `default(pi)` factory |
| Event hooks (`session_start`, `input`, etc.) | **Match** | Includes `agent_settled`, `before_provider_headers`, `api.exec()` |
| Tool registration | **Match** | |
| Entry / message renderers | **Match** | Display-only custom entries via `register_entry_renderer` |
| Shortcut registration + conflict detection | **Match** | |
| Extension UI (select/confirm/input/notify) | **Match** | Interactive + RPC bridge |
| TypeScript extension runtime | **Diverge** | Python port runs `.py` extensions only; TS extensions are not executed |
| npm extension packages | **Partial** | Package manager resolves extension paths; resource loader + settings wiring; `.py` only (TS npm extensions not executed) |

## Session storage

| Feature | Status | Notes |
|---------|--------|-------|
| JSONL session format | **Match** | |
| Labels | **Match** | |
| Custom entries | **Match** | |
| Branching / tree | **Match** | |
| Compaction | **Match** | |
| Session migration | **Partial** | Core paths covered; not every TS migration scenario |

## Tools

| Feature | Status | Notes |
|---------|--------|-------|
| read / write / edit / bash / grep / find / ls | **Match** | Bash uses `OutputAccumulator` + `fullOutputPath` when truncated | |
| `fd` / `rg` via tools-manager | **Match** | Auto-download on supported platforms |
| Image read pipeline (EXIF, convert) | **Match** | Wired into read tool + show-images selector |
| MCP tools | **Missing** | No in-process MCP runtime; npm MCP adapters still require TS bridge |

## Interactive UI (P3 polish)

| Feature | Status | Notes |
|---------|--------|-------|
| Message rendering (thinking, tools, diffs) | **Match** | |
| Footer (cwd, tokens, context, cache hit rate) | **Match** | |
| Settings selector | **Match** | Phase 2 settings + show-images selector submenu |
| Theme picker | **Match** | Custom theme file watcher via `set_theme(..., enable_watcher=True)`; polling `FSWatcher` with error handler (#2791) |
| Session / model / OAuth selectors | **Match** | Scrollable model list with provider-first then model step; error/empty states; scoped-model reorder |
| User-message fork selector | **Match** | |
| Changelog / version check on startup | **Match** | |
| Clipboard images | **Partial** | Wayland/X11/macOS subprocess paths; platform-dependent |
| Thinking block toggle (`ctrl+t`) | **Match** | Rebuilds chat and preserves pending tools |
| Scoped model reorder | **Match** | Alt+Up/Down in scoped models selector |
| RPC embedder client (`RpcClient`) | **Match** | Fake-server integration tests |
| Terminal OSC background colors | **Match** | `terminal_colors.py` |
| Tool definition factories for extensions | **Match** | `create_read_tool_definition()` + wrapper helpers |
| Windows npm self-update quarantine | **Match** | `windows_self_update.py` |
| Package manager semver ranges | **Partial** | `max_satisfying()` for npm update checks; latest-version fallback uses semver max (not lexicographic) |

## AI / providers

| Feature | Status | Notes |
|---------|--------|-------|
| Provider modules | **Match** | Anthropic, OpenAI, Google, Bedrock, Mistral, etc. |
| Model catalog sync | **Match** | `python/scripts/generate_models.py` syncs from TS catalogs |
| OAuth flows | **Match** | Provider-specific; Copilot model picker filter included |
| Cursor auth | **Match** | CLI `agent login` via `/login`; stale OAuth in `auth.json` warned and cleared after CLI login |
| Cursor subscription proxy | **Diverge** | Python uses CLI bridge; TS has protobuf proxy path (see `python/docs/cursor.md`) |
| Image generation | **Match** | OpenRouter image provider |

## Testing

| TS suite area | Python tests | Status |
|---------------|--------------|--------|
| `args.test.ts` | `test_phase5_parity.py`, `test_coding_agent_cli.py` | **Match** (high-value cases) |
| `rpc.test.ts` | `test_coding_agent_rpc.py`, `test_rpc_client.py`, `test_rpc_prompt_response_semantics.py`, `test_phase5_parity.py` | **Match** (unit + fake-server RpcClient + preflight semantics) |
| `trust-manager.test.ts` | `test_phase5_parity.py`, `test_project_trust_p0.py` | **Match** |
| `extensions-runner.test.ts` | `test_phase3_extensions.py`, `test_phase5_parity.py` | **Partial** |
| `session-manager/*.test.ts` | `test_phase5_parity.py`, `harness/test_session.py` | **Partial** |
| `footer-width.test.ts` | `test_footer.py` | **Match** |
| `suite/regressions/4167-*` | `tests/suite/regressions/test_4167_*` | **Match** |
| `suite/regressions/3217-*` | `tests/suite/regressions/test_3217_*` | **Match** |
| `suite/regressions/5868-*` | `test_phase5_parity.py` | **Match** |
| `suite/regressions/5080-*` | `tests/suite/regressions/test_5080_*` | **Match** |
| `suite/regressions/5724-*` | `tests/suite/regressions/test_5724_*` | **Match** |
| `suite/regressions/5208-*` | `tests/suite/regressions/test_5208_*` | **Match** |
| `suite/regressions/5303-*` | `tests/suite/regressions/test_5303_*` | **Match** |
| `suite/regressions/5109-*` | `tests/suite/regressions/test_5109_*` | **Match** |
| `suite/regressions/2835-*` | `tests/suite/regressions/test_2835_*` | **Match** |
| `suite/regressions/3317-*` | `tests/suite/regressions/test_3317_*` | **Match** |
| `suite/regressions/2753-*` | `tests/suite/regressions/test_2753_*` | **Match** |
| `suite/regressions/3616-*` | `tests/suite/regressions/test_3616_*` | **Match** |
| `suite/regressions/5433-*` | `tests/suite/regressions/test_5433_*` | **Match** |
| `suite/regressions/3686-*` | `tests/suite/regressions/test_3686_*` | **Match** |
| `suite/regressions/3303-*` | `tests/suite/regressions/test_3303_*` | **Match** |
| `suite/regressions/5661-*` | `tests/suite/regressions/test_5661_*` | **Match** |
| `suite/regressions/3982-*` | `tests/suite/regressions/test_3982_*` | **Match** |
| `suite/regressions/2023-*` | `tests/suite/regressions/test_2023_*` | **Match** |
| `suite/regressions/3302-*` | `tests/suite/regressions/test_3302_*` | **Match** |
| `suite/regressions/3592-*` | `tests/suite/regressions/test_3592_*` | **Match** |
| `suite/regressions/2781-*` | `tests/suite/regressions/test_2781_*` | **Match** |
| `suite/regressions/2791-*` | `tests/suite/regressions/test_2791_*` | **Match** |
| `suite/regressions/2860-*` | `tests/suite/regressions/test_2860_*` | **Match** |
| `suite/regressions/3688-*` | `tests/suite/regressions/test_3688_*` | **Match** |
| `suite/regressions/5596-*` | `tests/suite/regressions/test_5596_*` | **Match** |
| `suite/regressions/1717-*` | `tests/suite/regressions/test_1717_*` | **Match** |
| Other `suite/regressions/*` | — | **Match** |

## CI

| Check | Status |
|-------|--------|
| `npm run check` + `npm test` | **Match** (existing `ci.yml`) |
| `pytest` | **Match** (added in `ci.yml`) |
| `ruff check` + `ruff format --check` (coding_agent) | **Match** (added in `ci.yml`) |
| `mypy` (P3 modules) | **Match** (added in `ci.yml`) |
| Python model catalog sync (`generate_models.py --check`) | **Match** (CI + release publish job) |
| Real-provider e2e (`PI_E2E_PROVIDER`) | **Partial** | Gated pytest marker in `test_e2e_providers.py` |

## Known scope gaps

These are intentional port boundaries, not open regression items. They stay **Partial** / **Missing** until explicitly scheduled.

| Area | Status | Notes |
|------|--------|-------|
| In-process MCP runtime | **Missing** | No Python MCP host; use TS bridge or external MCP clients |
| TypeScript `.ts` extensions | **Diverge** | Python runs `.py` extensions only |
| npm extension packages | **Partial** | Package manager resolves extension paths; resource loader + settings wiring; `.py` only (TS npm extensions not executed) |
| Cursor protobuf proxy | **Diverge** | Python uses CLI bridge (`python/docs/cursor.md`) |
| Clipboard images (interactive) | **Partial** | Wayland/X11/macOS subprocess paths; platform-dependent |
| Export HTML / share | **Partial** | Export exists; share flow lighter than TS |
| `pi update` self-update | **Partial** | CLI flags present; install path depends on distribution method; version-check failures skip update instead of forcing it |
| Session migration edge cases | **Partial** | Core paths covered; not every TS migration scenario |
| `extensions-runner.test.ts` breadth | **Partial** | Core runner covered; not every TS runner scenario |
| `session-manager/*.test.ts` breadth | **Partial** | Core session tests ported; not full TS matrix |
| Package manager semver ranges | **Partial** | `max_satisfying()` for npm update checks; latest-version fallback uses semver max (not lexicographic) |
| Real-provider e2e | **Partial** | Gated pytest marker; optional in CI |

## Intentional divergences

1. **Extension language**: Python port loads `.py` extensions; TypeScript `.ts` extensions are not executed in-process.
2. **Cursor transport**: CLI bridge instead of protobuf proxy (documented in `python/docs/cursor.md`). Browser OAuth tokens stored under `cursor` in `auth.json` are ignored; use `/login` → Cursor subscription.
3. **Distribution**: Python package via `pip`/PyPI story is separate from npm/Bun binaries; `pi update --self` behavior depends on install method.
4. **Platform**: `fcntl` trust store locking on Unix; Windows uses compatible patterns where available.

## Maintenance

When upstream changes land in TypeScript:

1. Port behavior to the matching `pi_mono` module.
2. Add or extend a Python test mirroring the TS test when practical.
3. Update this checklist if status changes.
4. On release, ensure `python/scripts/generate_models.py` stays in sync with `packages/ai` catalogs.

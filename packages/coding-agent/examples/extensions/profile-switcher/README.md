# Profile Switcher Extension

Named model profiles for pi.

This example adds:

- `--profile <name>` at startup
- `/profile <name>`
- `/profile status`
- `/profile list`

The extension is meant for local `~/.pi/agent` setups where you want one command to switch:

- the main session model
- `enabledModels` for Ctrl+P cycling
- agent `model:` and `fallback-model:` frontmatter under `~/.pi/agent/agents/`
- fallback targets used by a companion fallback extension

## Files

- `index.ts` — command and session hook wiring
- `profiles.ts` — profile parsing, validation, defaults, and agent-frontmatter rewrites

## Local Config

The default config file is:

- `~/.pi/agent/profiles.json`

Current local setup:

### `openai`

- Main model: `factory-openai/gpt-5.4:xhigh`
- Scoped models: `factory-openai/gpt-5.4`, `factory-openai/gpt-5.4-mini`, `factory-openai/gpt-5.3-codex-spark`
- Agent map:
  - `backend`, `debug`, `metis`, `momus`, `orchestrator`, `prometheus`, `reviewer`, `sentinel`, `tester`, `tla-precheck` -> `factory-openai/gpt-5.4:xhigh`
  - `devops`, `frontend`, `librarian` -> `factory-openai/claude-opus-4-6:xhigh`
  - `explore` -> `factory-openai/gpt-5.3-codex-spark:xhigh`
  - `memory` -> `factory-openai/gpt-5.4-mini:xhigh`

### `anthropic`

- Main model: `factory-openai/claude-opus-4-6:xhigh`
- Scoped models: `factory-openai/claude-opus-4-6`, `factory-openai/claude-sonnet-4-6`
- Agent map:
  - `backend`, `debug`, `devops`, `frontend`, `librarian`, `metis`, `momus`, `orchestrator`, `prometheus` -> `factory-openai/claude-opus-4-6:xhigh`
  - `explore`, `memory` -> `factory-openai/claude-sonnet-4-6:xhigh`
  - `reviewer`, `sentinel`, `tester`, `tla-precheck` -> `factory-openai/gpt-5.4:xhigh`

Minimal JSON shape:

```json
{
  "activeProfile": "openai",
  "profiles": {
    "openai": {
      "main": { "model": "factory-openai/gpt-5.4:xhigh" },
      "enabledModels": [
        "factory-openai/gpt-5.4",
        "factory-openai/gpt-5.4-mini",
        "factory-openai/gpt-5.3-codex-spark"
      ],
      "agents": {
        "memory": {
          "model": "factory-openai/gpt-5.4-mini:xhigh",
          "fallbackModel": "factory-openai/gpt-5.4-mini:xhigh"
        }
      }
    },
    "anthropic": {
      "main": { "model": "factory-openai/claude-opus-4-6:xhigh" },
      "enabledModels": [
        "factory-openai/claude-opus-4-6",
        "factory-openai/claude-sonnet-4-6"
      ],
      "agents": {
        "explore": {
          "model": "factory-openai/claude-sonnet-4-6:xhigh",
          "fallbackModel": "factory-openai/claude-sonnet-4-6:xhigh"
        }
      }
    }
  }
}
```

## Notes

- Profile switching is an extension feature, not a built-in core CLI feature.
- The extension validates that referenced models exist in the active model registry before applying a profile.
- If your profile names a model that is missing from `models.json`, the switch is rejected instead of partially applying.
- In this local setup, `~/.pi/agent/models.json` must include `claude-sonnet-4-6` or the `anthropic` profile will fail validation.
- If you change `profiles.json` while pi is already running, use `/reload` or restart pi before testing the new mapping.

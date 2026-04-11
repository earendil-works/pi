# Pi — Secure Closed-Network Fork

This is a security fork of [badlogic/pi-mono](https://github.com/badlogic/pi-mono) maintained for deployment in closed networks and high-security environments. It is **not** the upstream project.

## What changed

### 1. Outbound non-LLM calls permanently disabled

Version checks, package update checks, and session sharing are suppressed at startup regardless of environment variables. The original code paths are preserved for upstream diff compatibility — they are gated, not deleted.

| Feature | Upstream | This fork |
|---------|----------|-----------|
| NPM version check at startup | Opt-out via `PI_SKIP_VERSION_CHECK` | Always off |
| Package update checks | Opt-out via `PI_OFFLINE` | Always off |
| `/share` (GitHub gist upload) | Available | Returns error |
| Google OAuth (`/login google-*`) | Available | Disabled at the network level |

### 2. `secureMode` — provider allowlist enforcement

`secureMode` is **on by default**. Any provider that does not have an explicit `baseUrl` configured in `models.json` is hidden from the model list and blocked from registration.

All built-in commercial cloud endpoints (Anthropic, OpenAI, Google, Mistral, Bedrock, etc.) are invisible unless redirected through a `baseUrl` in `models.json`. The protocol implementations (OpenAI-compat, Anthropic-compat, Google-compat, etc.) remain intact so self-hosted models can use them without additional code.

Enforcement points:
- `ModelRegistry.getAvailable()` — filters the model picker and cycling list
- `ModelRegistry.registerProvider()` — blocks extension-registered providers without a `baseUrl`
- `resolveCliModel()` — blocks CLI `--model` selection of ungated providers
- `runner.ts bindCore()` — blocks extension provider registrations at bind time

### 3. No default models

In `secureMode`, the application starts with an empty model list. Users must configure at least one provider in `~/.pi/agent/models.json` before launching. See [packages/coding-agent/README.md](packages/coding-agent/README.md) for configuration instructions.

## Configuring a self-hosted model

Create `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "internal-llm": {
      "baseUrl": "http://inference.internal:8000/v1",
      "api": "openai-completions",
      "apiKey": "INTERNAL_API_KEY",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "gemma-3-27b-it",
          "name": "Gemma 3 27B (Internal)",
          "input": ["text", "image"],
          "contextWindow": 131072,
          "maxTokens": 16384
        }
      ]
    }
  }
}
```

Set defaults in `~/.pi/agent/settings.json`:

```json
{
  "defaultProvider": "internal-llm",
  "defaultModel": "gemma-3-27b-it"
}
```

See [packages/coding-agent/docs/models.md](packages/coding-agent/docs/models.md) for the full `models.json` reference, including how to redirect built-in providers through an internal proxy, API key resolution (env vars, shell commands), and OpenAI-compatibility flags.

## Packages

| Package | Description |
|---------|-------------|
| **[@tculpepp/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@tculpepp/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@tculpepp/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@tculpepp/pi-tui](packages/tui)** | Terminal UI library with differential rendering |

## Development

```bash
npm install          # Install all dependencies
npm run build        # Build all packages
npm run check        # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh --no-env --model internal-llm/gemma-3-27b-it "your prompt"
```

> `npm run check` requires `npm run build` first. The web-ui package uses `tsc` which needs compiled `.d.ts` files from dependencies.

## Upstream

Original project: [badlogic/pi-mono](https://github.com/badlogic/pi-mono) by [Mario Zechner](https://github.com/badlogic). All credit for the core agent, TUI, and provider infrastructure belongs to the upstream project. This fork adds closed-network and secure-mode defaults on top.

## License

MIT

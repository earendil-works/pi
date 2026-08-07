# Ollama models for pi

Use local [Ollama](https://ollama.com) models in the pi coding agent through a small local model proxy.

Two scripts, run in order:

1. `ollama-proxy.mjs` — starts a local LLM model proxy in front of the Ollama server. pi talks to the proxy's OpenAI-compatible endpoint (`http://127.0.0.1:11435/v1` by default), and the proxy forwards every request (including streaming) to Ollama.
2. `pi-with-ollama.mjs` — discovers the models available through the proxy, registers them as an `ollama` provider in pi's `models.json`, and launches pi with an Ollama model preselected.

Both scripts are plain Node.js (18+) with no dependencies and work on Linux, macOS, and Windows.

## Prerequisites

- [Node.js 18+](https://nodejs.org)
- [Ollama](https://ollama.com/download) installed and running (`ollama serve`, or the Ollama desktop app)
- At least one model pulled, e.g. `ollama pull qwen2.5-coder:7b` (pick a model that supports tool calling so pi's coding tools work)
- pi installed (`npm install -g @earendil-works/pi-coding-agent`), or run from this repo after `npm install --ignore-scripts`

## Usage

Terminal 1 — start the proxy:

```bash
node scripts/ollama/ollama-proxy.mjs
```

Terminal 2 — run pi with the Ollama models:

```bash
node scripts/ollama/pi-with-ollama.mjs
```

Or via npm from the repo root: `npm run ollama:proxy` and `npm run ollama:pi`.

On Windows, run the same commands in PowerShell or cmd.exe.

Arguments after `--` are passed to pi as-is:

```bash
node scripts/ollama/pi-with-ollama.mjs -- -p "Explain this repository"
node scripts/ollama/pi-with-ollama.mjs -- --model llama3.1:8b
```

Once inside pi, switch between Ollama models with `/model`.

## ollama-proxy.mjs options

| Option | Description |
|--------|-------------|
| `--port <port>` | Port the proxy listens on (default: `11435`, env: `PI_OLLAMA_PROXY_PORT`) |
| `--host <host>` | Address the proxy binds to (default: `127.0.0.1`) |
| `--ollama <url>` | Ollama server URL (default: env `OLLAMA_HOST` or `http://127.0.0.1:11434`) |
| `--quiet` | Do not log individual requests |

The proxy exposes `/healthz` (proxy + Ollama health as JSON); every other path is forwarded to Ollama verbatim.

## pi-with-ollama.mjs options

| Option | Description |
|--------|-------------|
| `--proxy <url>` | Proxy base URL (default: `http://127.0.0.1:11435`, env: `PI_OLLAMA_PROXY_URL`) |
| `--pi <command>` | pi executable to launch (default: `pi` from `PATH`, falling back to this repo's sources via `tsx`) |
| `--configure-only` | Update `models.json` and exit without launching pi |

## What gets written

`pi-with-ollama.mjs` merges an `ollama` provider entry into pi's `models.json` (`~/.pi/agent/models.json`, or `$PI_CODING_AGENT_DIR/models.json` if set). Other provider entries are left untouched, and the previous file is backed up to `models.json.bak` before each update. Model context windows and reasoning support are detected from Ollama's `/api/show` endpoint.

See [docs/models.md](../../packages/coding-agent/docs/models.md) for the full `models.json` format.

## Troubleshooting

- **"cannot reach the model proxy"** — start `ollama-proxy.mjs` first, and check that `--proxy` matches the proxy's `--port`.
- **"the proxy is running but Ollama is not reachable"** — start Ollama (`ollama serve` or the desktop app). If Ollama runs on a non-default address, pass `--ollama <url>` to the proxy or set `OLLAMA_HOST`.
- **Model errors on tool calls** — the model does not support tool calling. Pull one that does (the launcher prints a warning for models without the `tools` capability).
- **Port already in use** — another proxy instance is running, or pass `--port` to the proxy and `--proxy` to the launcher.

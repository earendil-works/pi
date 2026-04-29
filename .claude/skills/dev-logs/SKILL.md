---
name: dev-logs
description: Tail and search pi-mono dev logs for troubleshooting — filter by provider, service, level, or freeform pattern.
argument-hint: '[gloo] [--level ERROR] [--lines 50] [--follow]'
---

# Dev Logs

Inspect local pi-mono logs while debugging the `pi` TUI or Gloo provider.

## Arguments

<arguments> #$ARGUMENTS </arguments>

- First positional arg — grep pattern, e.g. `gloo`, `token`, `stream error`
- `--level <LEVEL>` — filter to `DEBUG`, `INFO`, `WARN`, or `ERROR`
- `--lines <N>` — number of recent lines to show; default `50`
- `--follow` — run a blocking `tail -f`
- No arguments — show the last 50 lines of the most recent log

## Log locations

Check these in order and use the first existing relevant log:

```bash
$HOME/.local/share/pi/log/dev.log
$HOME/.local/share/pi/log/*.log
$HOME/.local/share/opencode/log/dev.log      # only when comparing with opencode behavior
/tmp/ai-api-dev.log                          # local backend, if started by /gloo-local-dev
```

If no pi log directory exists, tell the user to start the local TUI first:

```bash
npm run build
node packages/coding-agent/dist/cli.js
```

## Analysis checklist

When filtering for `gloo`, look for:

- OAuth provider login/prompt errors
- `GLOO_CLIENT_ID` / `GLOO_CLIENT_SECRET` missing configuration
- token grant failures against `/oauth2/token`
- request failures to `/ai/v2/chat/completions`
- streaming parser errors, especially DeepSeek `reasoning_content`
- model/tool errors for blocklisted models

Summarize:

1. log file used
2. number of lines scanned
3. error/warning count
4. likely root cause
5. concrete next command (`/gloo-verify`, `/gloo-env local`, restart TUI, check `ai-api` logs, etc.)

---
name: gloo-verify
description: End-to-end smoke verification of pi-mono's Gloo AI provider — creds, static catalog, OAuth2, live streaming, and tool-blocklist checks.
argument-hint: '[--local]'
---

# Gloo AI Provider Verifier

Run the Gloo smoke verifier after touching provider code, rebasing, or switching environments.

## Arguments

<arguments> #$ARGUMENTS </arguments>

- `--local` — verify against `http://localhost:8000`; requires local `ai-api` running.
- No arguments — verify against `https://platform.ai.gloo.com`.

## Execution

From the repo root:

```bash
set -a && source .env.local && set +a
cd packages/ai
npm run verify:gloo
```

For local mode, first ensure `.env.local` has `GLOO_BASE_URL=http://localhost:8000` (use `/gloo-env local`) and `ai-api` is running, then run the same verifier.

## What it checks

- Provider registration (`gloo` + `gloo-openai-completions`)
- 22-model Gloo catalog and decommissioned-model exclusions
- Toolcall blocklist for models the platform rejects with tools
- Presence of `GLOO_CLIENT_ID` and `GLOO_CLIENT_SECRET`
- OAuth2 token grant in prod; local auth shortcut for localhost
- Live streaming for representative Anthropic, OpenAI, DeepSeek, and blocklisted Llama models

## Interpreting failures

| Failure | Likely cause | Next step |
|---|---|---|
| Missing creds | `.env.local` absent/not sourced | Source `.env.local` and retry |
| Token grant 401/403 | Rotated or revoked Gloo credential | Check Gloo Studio API credentials |
| Local token 404 | Trying OAuth against local `ai-api` | Set `GLOO_BASE_URL=http://localhost:8000` |
| Catalog mismatch | Model list drift | Update `models.gloo.ts` or verifier expectations |
| DeepSeek R1 internal error | Known platform regression as of 2026-04-29 | Keep verifier on `gloo-deepseek-v3.2` until recovered |
| Blocklisted model rejects tools | Wrapper failed to strip tools | Inspect `packages/ai/src/providers/gloo.ts` |

A clean run ends with `11/11 passed`.

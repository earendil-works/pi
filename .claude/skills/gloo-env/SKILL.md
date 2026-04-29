---
name: gloo-env
description: Toggle Gloo AI provider between prod (platform.ai.gloo.com) and local (localhost:8000) in .env.local
argument-hint: '[prod|local]'
---

# Gloo Environment Toggle

Switch pi-mono's Gloo AI provider base URL between production and local `ai-api`.

## Arguments

<arguments> #$ARGUMENTS </arguments>

- `prod` — set `GLOO_BASE_URL=https://platform.ai.gloo.com`
- `local` — set `GLOO_BASE_URL=http://localhost:8000`
- No argument — report the current setting only

## Execution

1. Read `.env.local` in the repo root.
2. Determine current environment:
   - `platform.ai.gloo.com` → prod
   - `localhost` / `127.0.0.1` / missing → local
3. If no argument was provided, stop after reporting current state.
4. Update or add `GLOO_BASE_URL`:
   - `prod`: `GLOO_BASE_URL=https://platform.ai.gloo.com`
   - `local`: `GLOO_BASE_URL=http://localhost:8000`
5. Confirm the value by reading `.env.local` again.

## Notes

- Prod performs OAuth2 `client_credentials` against `${GLOO_BASE_URL}/oauth2/token`; `GLOO_CLIENT_ID` and `GLOO_CLIENT_SECRET` must be valid Gloo platform credentials.
- Local `ai-api` has no OAuth2 endpoint; when `ENVIRONMENT=local`, it accepts any non-empty Bearer token. The pi-mono Gloo helper detects localhost and uses `GLOO_CLIENT_ID` as the bearer.
- Restart the local `pi` TUI/dev process after switching environments.

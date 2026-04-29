---
name: gloo-local-dev
description: Orchestrate local Gloo AI development — verify ai-api is running, configure pi-mono, and inspect logs.
argument-hint: '[--skip-api] [--skip-pi] [--no-logs]'
---

# Gloo Local Dev Orchestrator

Bring up the local Gloo AI stack: `ai-api` on `localhost:8000` and pi-mono configured to point at it.

## Arguments

<arguments> #$ARGUMENTS </arguments>

- `--skip-api` — skip backend checks
- `--skip-pi` — skip `.env.local` updates in pi-mono
- `--no-logs` — skip log inspection

## Phase 1 — Locate ai-api

Read `AI_API_DIR` from `.env.local`:

```bash
grep '^AI_API_DIR=' .env.local | cut -d= -f2-
```

If missing, stop and ask the user to add it, e.g.:

```bash
echo 'AI_API_DIR=/Users/patrick/workspaces/clients/servant-glooai/repos/ai-api' >> .env.local
```

Verify the repo:

```bash
ls "$AI_API_DIR/app/main.py"
```

## Phase 2 — Check backend prerequisites

Skip if `--skip-api`.

```bash
python3.11 --version
poetry --version
ls "$AI_API_DIR/.env"
docker ps --filter "name=ai-api-postgres" --format "{{.Names}} {{.Status}}"
docker ps --filter "name=ai-api-redis" --format "{{.Names}} {{.Status}}"
```

Start Docker services if needed:

```bash
cd "$AI_API_DIR" && docker compose up -d postgres redis-stack
```

Run migrations before starting the server:

```bash
cd "$AI_API_DIR" && poetry run alembic upgrade head
```

## Phase 3 — Ensure ai-api is running

```bash
curl -sf -o /dev/null -w "%{http_code}" http://localhost:8000/docs
```

If not `200`, start it in the background and log to `/tmp/ai-api-dev.log`:

```bash
cd "$AI_API_DIR" && poetry run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000 > /tmp/ai-api-dev.log 2>&1
```

Wait a few seconds and verify `/docs` again. If it fails, read the last 30 lines of `/tmp/ai-api-dev.log` and report the startup error.

## Phase 4 — Configure pi-mono

Skip if `--skip-pi`.

Update `.env.local` at the pi-mono repo root:

```bash
GLOO_BASE_URL=http://localhost:8000
```

Verify `GLOO_CLIENT_ID` and `GLOO_CLIENT_SECRET` are present. Local `ai-api` accepts any non-empty Bearer token when `ENVIRONMENT=local`, and the pi-mono helper skips OAuth2 for localhost.

## Phase 5 — Verify and inspect logs

Run:

```bash
set -a && source .env.local && set +a
cd packages/ai && npm run verify:gloo
```

If `--no-logs` is not set, inspect:

- `/tmp/ai-api-dev.log` — backend startup/request errors
- `$HOME/.local/share/pi/log/dev.log` or newest `$HOME/.local/share/pi/log/*.log` — TUI/provider errors

## Ready message

Report:

```text
Local Gloo AI stack is ready:
  ai-api: http://localhost:8000
  pi-mono: GLOO_BASE_URL=http://localhost:8000

Run the local TUI:
  npm run build
  node packages/coding-agent/dist/cli.js
```

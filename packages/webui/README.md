# @earendil-works/pi-webui

Web-based UI for pi, powered by a Node.js WebSocket server and a Vite/React frontend.

## Prerequisites

- Node.js 20+
- A supported LLM provider configured (e.g., `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`)
- SQLite (built-in, no separate install needed)

## Manual End-to-End Test

This section verifies the full stack: server, WebSocket transport, session management, streaming responses, and persistence.

### Step 1 — Start the server

```bash
pi --web
```

The server binds to `localhost:8741` by default. Confirm the startup log shows no errors and that port 8741 is listening. Use `pi --web --port <n>` to override.

### Step 2 — Open the browser

Navigate to `http://localhost:8741`. The web UI should load without errors in the console.

### Step 3 — Create a session

Click **New Session** (or the equivalent create button in the UI). A session ID should appear in the UI, indicating the session was created and is active.

### Step 4 — Send a prompt

Type a prompt and submit it (e.g., `Say hello in one sentence`). The prompt should appear in the message history immediately.

### Step 5 — Verify the stream

Wait for the model response to stream in. The response should appear token-by-token, not all at once. Verify:
- Tokens appear progressively in the message area
- The UI remains responsive during streaming
- The response completes without errors

### Step 6 — Delete the session

Select the active session and click **Delete** (or the equivalent delete action). The session should disappear from the session list and the UI should reflect an empty state.

### Step 7 — Check memory.db for atoms

Open or query the SQLite database:

```bash
sqlite3 memory.db "SELECT COUNT(*) FROM atoms;"
```

If atoms were persisted during the session, the count should be greater than zero. If the table or database does not exist, investigate the memory store initialization.

<!-- Screenshot placeholders (optional):
![Step 2 — Browser loads](docs/screenshots/webui-step2-load.png)
![Step 5 — Streaming response](docs/screenshots/webui-step5-stream.png)
-->

## Development

```bash
# From monorepo root
npm install

# Start in dev mode with Vite HMR
cd packages/webui/server && npm run dev
```

## Architecture

- `server/` — Node.js WebSocket + HTTP server (session pool, LLM client, memory store)
- `web/` — Vite SPA frontend (React + Tailwind)

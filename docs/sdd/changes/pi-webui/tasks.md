# Tasks: pi-webui

> **Design:** design.md | **Base:** 817e5ed557d820fd5fe1aba907c3ecaf070f77ce

**Goal:** Build a Web Dashboard for pi that lets users run multiple parallel sessions in the browser, manage cron jobs visually, and automatically extract memory atoms when sessions are deleted — without modifying pi core.

**Architecture:** Independent Node.js Web Server (Express + ws) + React 19 SPA (Vite). Reuses existing `extensions/personal-assistant/cron.ts` (4→5 actions) and `memory.ts` (SQLite FTS5) by reading/writing their files directly. pi core unchanged; communication via `pi --mode rpc` JSON-line over stdin/stdout.

**Tech Stack:** Node.js 20+, Express 4, ws 8, better-sqlite3 11, chokidar 3, React 19, Vite 7, TypeScript 5.9, react-router 7, Tailwind 4 (via @tailwindcss/vite), Lucide React icons.

## 1. Bootstrap webui package

- [x] 1.1 **Create packages/webui directory structure**
  - **文件**: `packages/webui/package.json` (Create)
  - **内容**: `{"name": "@pi-mono/webui", "private": true, "type": "module", "scripts": {"start": "tsx server/index.ts", "dev": "tsx watch server/index.ts", "build": "cd web && npm run build", "test": "vitest"}, "dependencies": {"express": "^4.21.0", "ws": "^8.18.0", "better-sqlite3": "^11.5.0", "chokidar": "^3.6.0", "async-mutex": "^0.5.0"}, "devDependencies": {"typescript": "^5.9.0", "tsx": "^4.19.0", "vitest": "^2.1.0", "@types/express": "^5.0.0", "@types/ws": "^8.5.0", "@types/better-sqlite3": "^7.6.0"}}`
  - **验证**: `cat packages/webui/package.json` shows expected content
  - **依赖**: 无

- [x] 1.2 **Create webui tsconfig**
  - **文件**: `packages/webui/tsconfig.json` (Create)
  - **内容**: `{"compilerOptions": {"target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler", "strict": true, "esModuleInterop": true, "skipLibCheck": true, "outDir": "./dist", "rootDir": "./server", "lib": ["ES2022", "DOM"]}, "include": ["server/**/*.ts", "web/src/**/*.ts", "web/src/**/*.tsx"]}`
  - **验证**: `cd packages/webui && npx tsc --noEmit` returns exit 0
  - **依赖**: 1.1

- [x] 1.3 **Create webui npm workspace link**
  - **文件**: `package.json` (Modify - NO CHANGES NEEDED)
  - **内容**: No file change required. The root `package.json` already has `"packages/*"` glob in the `workspaces` array, which automatically includes `packages/webui/`. The actual `npm install` step (which would create the `node_modules/@pi-mono/webui` symlink) is deferred to end of all development tasks or CI; running it now would modify `package-lock.json` and require `PI_ALLOW_LOCKFILE_CHANGE=1`.
  - **验证**: `node -e "const p=require('./package.json'); console.log(p.workspaces.includes('packages/*'))"` returns `true`; `ls packages/webui/package.json` exists
  - **依赖**: 1.1
  - **NOTE**: Final step (after all 45 tasks) will run `PI_ALLOW_LOCKFILE_CHANGE=1 npm install --ignore-scripts` to materialize symlinks for the webui dependencies.

## 2. Web Server foundation

- [x] 2.1 **HTTP + WebSocket server entry point**
  - **文件**: `packages/webui/server/index.ts` (Create)
  - **内容**: Express app with CORS, body parser, mount `/api/*` routes; HTTP server upgrade handler for `/ws`; reads `PI_WEB_PORT` (default 8741), `PI_WEB_MAX_SESSIONS` (default 16) from env; graceful shutdown on SIGTERM (cleanup all pi processes)
  - **验证**: `cd packages/webui && PI_WEB_PORT=8741 npx tsx server/index.ts &` then `curl -s http://127.0.0.1:8741/api/health` returns `{"ok":true}` and `kill -TERM $!` exits cleanly
  - **依赖**: 1.2

- [x] 2.2 **Static file serving for React build**
  - **文件**: `packages/webui/server/routes/static.ts` (Create)
  - **内容**: Express handler that serves `web/dist/*` for GET requests not matching `/api` or `/ws`; fallback to `index.html` for SPA routes
  - **验证**: Create dummy `web/dist/index.html` with "test"; `curl -s http://127.0.0.1:8741/` returns content with "test"; `curl -s http://127.0.0.1:8741/cron` returns same (SPA fallback)
  - **依赖**: 2.1

- [x] 2.3 **Health check endpoint**
  - **文件**: `packages/webui/server/routes/health.ts` (Create)
  - **内容**: `GET /api/health` returning `{ok: true, version, uptime, sessions: number}`; mounted on app
  - **验证**: `curl -s http://127.0.0.1:8741/api/health | jq .ok` returns `true`
  - **依赖**: 2.1

## 3. Cron store (single source of truth: ~/.pi/agent/data/cron.json)

- [x] 3.1 **Cron store module**
  - **文件**: `packages/webui/server/cron-store.ts` (Create)
  - **内容**: `CronStore` class with `list()`, `add(job)`, `update(id, partial)`, `remove(id)`, `triggerNow(id)`; uses `CRON_DATA_PATH = ~/.pi/agent/data/cron.json`; in-process mutex (`async-mutex`); atomic write via `fs.writeFile(tmp) + rename`; matches the schema used in `extensions/personal-assistant/cron.ts` (fields: id/name/schedule/prompt/enabled/last_run/created_at)
  - **验证**: `npx tsx -e "import {CronStore} from './server/cron-store.ts'; const s = new CronStore(); await s.add({id:'t1',name:'t',schedule:{kind:'at',time:'09:00'},prompt:'p',enabled:true,last_run:null,created_at:new Date().toISOString()}); console.log(await s.list());"` prints `[{id:'t1',...}]`
  - **依赖**: 1.2

- [x] 3.2 **Cron store unit tests**
  - **文件**: `packages/webui/server/test/cron-store.test.ts` (Create)
  - **内容**: Vitest test cases: (a) add → list returns 1, (b) update with partial, (c) remove filters out, (d) triggerNow sets `last_run: null`, (e) concurrent add via Promise.all doesn't corrupt file (use temp HOME via `process.env.HOME = tempdir`)
  - **验证**: `cd packages/webui && npx vitest run server/test/cron-store.test.ts` all 5 tests PASS
  - **依赖**: 3.1

- [x] 3.3 **Cron REST API endpoints**
  - **文件**: `packages/webui/server/routes/cron.ts` (Create)
  - **内容**: `GET /api/cron/jobs` (list), `POST /api/cron/jobs` (add, body: CronJob minus id/created_at), `PUT /api/cron/jobs/:id` (update), `DELETE /api/cron/jobs/:id`, `POST /api/cron/jobs/:id/trigger` (triggerNow); mounts on Express app; returns 400 with `{error}` on validation failure
  - **验证**: `curl -X POST http://127.0.0.1:8741/api/cron/jobs -H 'Content-Type: application/json' -d '{"name":"test","schedule":{"kind":"at","time":"09:00"},"prompt":"p","enabled":true}'` returns 200 with `id`; `curl http://127.0.0.1:8741/api/cron/jobs` includes the new job
  - **依赖**: 3.1, 2.1

## 4. Cron file watcher (cross-process sync)

- [x] 4.1 **chokidar watch cron.json**
  - **文件**: `packages/webui/server/cron-watcher.ts` (Create)
  - **内容**: `CronWatcher` class using chokidar.watch(CRON_DATA_PATH, {ignoreInitial:true}); on `change`/`add`, debounce 200ms then emit `cron_changed` event to all WS clients; subscribe method to register listener
  - **验证**: Start server, write to `cron.json` from another shell (`echo '[]' > ~/.pi/agent/data/cron.json`); within 500ms, server logs "cron.json changed, broadcasting"
  - **依赖**: 3.1, 2.1

## 5. Session pool (process management)

- [x] 5.1 **Session pool module**
  - **文件**: `packages/webui/server/session-pool.ts` (Create)
  - **内容**: `SessionPool` class; `init()` scans `~/.pi/agent/sessions/--<cwd>--/`, parses each JSONL header; `spawnIfNeeded(sessionId)` spawns `pi --mode rpc --resume <id> --cwd <cwd>` via child_process.spawn, sets up stdin/stdout JSON-line piping; `broadcast(sessionId, event)` to all WS clients; `kill(sessionId, signal='SIGTERM')` with 5s timeout then SIGKILL; `cleanupOnExit()` sends SIGTERM to all
  - **验证**: Mock child_process in test; create pool, call spawnIfNeeded twice; assert 2 processes tracked; call kill → all receive SIGTERM
  - **依赖**: 2.1

- [x] 5.2 **Session pool unit tests**
  - **文件**: `packages/webui/server/test/session-pool.test.ts` (Create)
  - **内容**: Vitest test cases: (a) init loads N sessions from disk, (b) spawnIfNeeded is idempotent, (c) broadcast forwards events to subscribers, (d) kill sends SIGTERM, (e) cleanupOnExit kills all
  - **验证**: `cd packages/webui && npx vitest run server/test/session-pool.test.ts` all 5 tests PASS
  - **依赖**: 5.1

- [x] 5.3 **Session REST API endpoints**
  - **文件**: `packages/webui/server/routes/sessions.ts` (Create)
  - **内容**: 4 endpoints: (1) `GET /api/sessions` lists all sessions from pool; (2) `POST /api/sessions` (body: `{initialPrompt: string}`) generates a new sessionId (`crypto.randomUUID()`), creates an empty session JSONL file at `~/.pi/agent/sessions/--<cwd>--/<isoTs>_<id>.jsonl` with header `{type:"session", id, timestamp, cwd}`, returns `{id, sessionFile}` — does NOT spawn pi process yet (lazy spawn on first WS subscribe); (3) `GET /api/sessions/:id/messages?limit=200&offset=0` reads session JSONL entries, paginated; (4) `DELETE /api/sessions/:id` triggers memory extraction, then deletes JSONL
  - **验证**: `curl -X POST http://127.0.0.1:8741/api/sessions -H 'Content-Type: application/json' -d '{"initialPrompt":"hi"}'` returns 200 with `{id, sessionFile}`; new file exists in sessions dir; `curl http://127.0.0.1:8741/api/sessions` lists it
  - **依赖**: 5.1, 2.1, 6.1

## 6. Memory extraction (session deletion)

- [x] 6.1 **Memory store writer**
  - **文件**: `packages/webui/server/memory-store.ts` (Create)
  - **内容**: `MemoryStore` class with `init()` running schema CREATE TABLE IF NOT EXISTS for `memory_index`/`memory_fts`/`memory_embeddings` (matching `extensions/personal-assistant/memory.ts` schema); `writeAtom(atom)` inserts row + fts row; `close()` closes db connection
  - **验证**: Create temp db, init, writeAtom({id:'a1', type:'knowledge', title:'t', summary:'s', content:'c', tags:[], importance:0.5, strength:1.0, created_at:now, updated_at:now, version:1, archived:false, file_path:'', content_hash:'h'}); query back: returns 1 row
  - **依赖**: 1.2

- [x] 6.2 **Memory store unit tests**
  - **文件**: `packages/webui/server/test/memory-store.test.ts` (Create)
  - **内容**: Vitest: (a) init creates tables, (b) writeAtom then read returns atom, (c) fts row exists after write, (d) writeAtom with same id overwrites (UPSERT)
  - **验证**: `cd packages/webui && npx vitest run server/test/memory-store.test.ts` all 4 tests PASS
  - **依赖**: 6.1

- [x] 6.3 **LLM client for atom extraction**
  - **文件**: `packages/webui/server/llm-client.ts` (Create)
  - **内容**: `LLMClient` class; reads `~/.pi/agent/models.json` to find default model + provider config; `extractAtoms(sessionMessages: string): Promise<ExtractedAtom[]>` builds the same extraction prompt as `extensions/personal-assistant/memory.ts` line 1131; calls provider's chat completion API; parses JSON response into ExtractedAtom[]; 5s timeout + 1 retry on failure
  - **验证**: Unit test with mocked fetch: returns 2 atoms; on 500, retries; on second 500, throws
  - **依赖**: 1.2

- [x] 6.4 **LLM client unit tests**
  - **文件**: `packages/webui/server/test/llm-client.test.ts` (Create)
  - **内容**: Vitest: (a) reads models.json, (b) extractAtoms parses valid JSON, (c) retries on 500, (d) throws after 2nd failure
  - **验证**: `cd packages/webui && npx vitest run server/test/llm-client.test.ts` all 4 tests PASS
  - **依赖**: 6.3

- [x] 6.5 **Wire DELETE session → extract → delete**
  - **文件**: `packages/webui/server/routes/sessions.ts` (Modify, add DELETE handler)
  - **内容**: `DELETE /api/sessions/:id` reads session JSONL, calls LLMClient.extractAtoms(jsonl), MemoryStore.writeAtom for each; on LLM failure, log + skip; finally fs.unlink JSONL
  - **验证**: Create test session, DELETE it; verify JSONL gone, memory.db has N atoms (mock LLM to return 2 atoms)
  - **依赖**: 5.3, 6.3, 6.1

## 7. WebSocket bridge

- [x] 7.1 **WS handler for chat**
  - **文件**: `packages/webui/server/ws/handler.ts` (Create)
  - **内容**: `ws.Server({noServer:true})` on HTTP upgrade `path === '/ws'`; message types: `subscribe({sessionId})`, `prompt({text, images?})`, `abort()`, `switch_session({sessionId})`; forwards to SessionPool; broadcasts all pi process stdout events to subscribed clients
  - **验证**: WebSocket test client connects, sends `subscribe`, gets session list events
  - **依赖**: 5.1, 2.1

- [x] 7.2 **WS unit tests**
  - **文件**: `packages/webui/server/test/ws-handler.test.ts` (Create)
  - **内容**: Vitest: (a) client connects, (b) subscribe adds to subscribers, (c) prompt forwards to session-pool, (d) broadcast reaches all subscribers, (e) disconnect removes subscriber
  - **验证**: `cd packages/webui && npx vitest run server/test/ws-handler.test.ts` all 5 tests PASS
  - **依赖**: 7.1

## 8. Cron tool extension (add trigger_now)

- [x] 8.1 **Add trigger_now action to cron.ts**
  - **文件**: `extensions/personal-assistant/cron.ts` (Modify)
  - **内容**: In `cronWriteParams.operations[].action` union, add `Type.Literal("trigger_now")`; in `executeOperation` switch, add `case "trigger_now":` that finds job by id, sets `last_run: null`, returns success; update tool description to mention 5 actions
  - **验证**: `cd packages/personal-assistant && npx vitest run test/cron.test.ts` existing tests PASS + new test for trigger_now PASS
  - **依赖**: 无

- [x] 8.2 **Cron extension tests for trigger_now**
  - **文件**: `extensions/personal-assistant/test/cron.test.ts` (Create new file; the `test/` directory does not exist yet, must be created)
  - **内容**: Vitest: (a) add new job, (b) trigger_now sets last_run to null, (c) isOverdue returns true after trigger_now, (d) existing add/list/remove/toggle still work (backward compat). Use a temp HOME dir to avoid touching real cron.json.
  - **验证**: `cd extensions/personal-assistant && npx vitest run test/cron.test.ts` all 4 tests PASS
  - **依赖**: 8.1

## 9. pi CLI --web flag

- [x] 9.1 **Add --web flag to args.ts**
  - **文件**: `packages/coding-agent/src/cli/args.ts` (Modify)
  - **内容**: Add three options to the existing args parser: `--web` (boolean), `--port <port>` (string, default '8741'), `--max-sessions <n>` (string, default '16')
  - **验证**: `cd packages/coding-agent && ./pi-test.sh --help 2>&1 | grep -A1 "web"` shows the new flags
  - **依赖**: 无

- [x] 9.2 **Add --web spawn logic to main.ts**
  - **文件**: `packages/coding-agent/src/main.ts` (Modify)
  - **内容**: When `parsed.web` is true, locate webui package via `require.resolve("@pi-mono/webui")` or relative path; spawn `node` with `["--import", "tsx", "<webui>/server/index.ts", "--port", port, "--max-sessions", maxSessions, "--cwd", process.cwd()]`; inherit stdio; on child exit, call `process.exit(code)`
  - **验证**: Build pi, run `pi --web`, see "WebUI running at http://127.0.0.1:8741" in terminal; `curl http://127.0.0.1:8741/api/health` returns 200
  - **依赖**: 9.1, 2.1

## 10. React SPA foundation

- [x] 10.1 **Create web/package.json and vite config**
  - **文件**: `packages/webui/web/package.json` (Create)
  - **内容**: `{"name": "@pi-mono/webui-web", "private": true, "type": "module", "scripts": {"dev": "vite", "build": "vite build", "typecheck": "tsc --noEmit", "test": "vitest"}, "dependencies": {"react": "^19.0.0", "react-dom": "^19.0.0", "react-router-dom": "^7.0.0", "lucide-react": "^0.460.0"}, "devDependencies": {"vite": "^7.0.0", "@vitejs/plugin-react": "^4.3.0", "typescript": "^5.9.0", "@types/react": "^19.0.0", "@types/react-dom": "^19.0.0", "tailwindcss": "^4.0.0", "@tailwindcss/vite": "^4.0.0", "vitest": "^2.1.0", "@testing-library/react": "^16.0.0", "@testing-library/jest-dom": "^6.5.0", "@testing-library/user-event": "^14.5.0", "jsdom": "^25.0.0"}}`
  - **验证**: `cat packages/webui/web/package.json` shows expected content
  - **依赖**: 1.1

- [x] 10.1b **Create web/tsconfig.json**
  - **文件**: `packages/webui/web/tsconfig.json` (Create)
  - **内容**: `{"compilerOptions": {"target": "ES2022", "useDefineForClassFields": true, "lib": ["ES2022", "DOM", "DOM.Iterable"], "module": "ESNext", "skipLibCheck": true, "moduleResolution": "Bundler", "allowImportingTsExtensions": true, "resolveJsonModule": true, "isolatedModules": true, "moduleDetection": "force", "noEmit": true, "jsx": "react-jsx", "strict": true, "noUnusedLocals": true, "noUnusedParameters": true, "noFallthroughCasesInSwitch": true, "types": ["vitest/globals", "@testing-library/jest-dom"]}, "include": ["src"]}`
  - **验证**: `cd packages/webui/web && npx tsc --noEmit` returns exit 0 with empty src dir
  - **依赖**: 10.1

- [x] 10.2 **Vite + Tailwind + index.html**
  - **文件**: `packages/webui/web/vite.config.ts` (Create)
  - **内容**: vite.config.ts with react plugin + tailwindcss plugin; vitest config block: `test: { environment: 'jsdom', globals: true, setupFiles: ['./src/test-setup.ts'] }`; `index.html` with `<div id="root"></div>`; `web/src/index.css` with `@import "tailwindcss";`; `web/src/test-setup.ts` imports `@testing-library/jest-dom`
  - **验证**: `cd packages/webui/web && npx vite build` succeeds
  - **依赖**: 10.1b

- [x] 10.3 **App router shell**
  - **文件**: `packages/webui/web/src/App.tsx` (Create)
  - **内容**: BrowserRouter with 3 routes: `/sessions` (redirect to `/sessions`), `/chat/:id`, `/cron`; left sidebar nav with "Sessions" and "Cron" links (using lucide icons); outlet for main content
  - **验证**: `cd packages/webui/web && npx vite build` succeeds
  - **依赖**: 10.2

- [x] 10.4 **API client + WebSocket client**
  - **文件**: `packages/webui/web/src/lib/api.ts` (Create)
  - **内容**: `api` object with `listSessions()`, `listCronJobs()`, `createCronJob()`, `updateCronJob()`, `deleteCronJob()`, `triggerCronJob()`, `getMessages(sessionId, opts)`, `deleteSession()`; `ws` class wrapping WebSocket with reconnect, message subscription
  - **验证**: TypeScript compiles; `ws.connect()` opens connection to ws://127.0.0.1:8741/ws
  - **依赖**: 10.3

## 11. Sessions + Chat views

- [ ] 11.1 **SessionsPage + SessionList component**
  - **文件**: `packages/webui/web/src/pages/SessionsPage.tsx` (Create)
  - **内容**: Lists sessions from API; each item: title (first user message truncated to 30 chars), status badge (idle/running/error), last_active; click navigates to `/chat/:id`; empty state with "+ New Session" button; virtual scroll for 50+ sessions
  - **验证**: Component test renders empty state; renders 1 session; click navigates
  - **依赖**: 10.4

- [ ] 11.2 **New Session modal**
  - **文件**: `packages/webui/web/src/components/NewSessionModal.tsx` (Create)
  - **内容**: Modal with initial prompt textarea; "Create" button calls `POST /api/sessions` (or RPC), navigates to new chat
  - **验证**: Component test: type prompt, click Create, calls API
  - **依赖**: 11.1, 5.3

- [ ] 11.3 **ChatPage + ChatMessages component**
  - **文件**: `packages/webui/web/src/pages/ChatPage.tsx` (Create)
  - **内容**: Renders message list (user/assistant), streaming text via WS `message_update` events, tool call cards; input box at bottom; sends `prompt` WS message on submit; "Delete Session" button (with confirm) calls DELETE
  - **验证**: Component test: render with mock messages; send prompt mock triggers WS message
  - **依赖**: 11.1, 7.1

## 12. Cron Dashboard view

- [ ] 12.1 **CronPage + CronList component**
  - **文件**: `packages/webui/web/src/pages/CronPage.tsx` (Create)
  - **内容**: Lists all cron jobs from API; each row: name, schedule humanized ("every day at 09:00"), enabled toggle, status chip, last run, next run, action buttons (Pause/Resume, Trigger Now, Edit, Delete); empty state with "+ New Cron" CTA; "Show disabled" filter toggle
  - **验证**: Component test: render empty state; render 1 job; click Trigger calls API
  - **依赖**: 10.4, 3.3

- [ ] 12.2 **CronForm modal (create/edit)**
  - **文件**: `packages/webui/web/src/components/CronForm.tsx` (Create)
  - **内容**: Modal with fields: name (text), prompt (textarea), schedule (radio: at/every/cron + dynamic sub-fields time/interval/expr), enabled (checkbox); "Create" or "Save" button
  - **验证**: Component test: fill form, submit, validates required fields
  - **依赖**: 12.1

- [ ] 12.3 **CronDashboard row expand for last-run details**
  - **文件**: `packages/webui/web/src/components/CronLastRun.tsx` (Create)
  - **内容**: When cron row is clicked, expand inline below showing last run details from `cron.json` (not a separate file): `last_run` (ISO timestamp), `last_run_status` (from new optional field, see Task 8.3), next scheduled fire time (computed from schedule). No output preview, no download — keep scope tight. Single data source: cron.json.
  - **验证**: Component test: row with `last_run: "2025-01-01T00:00:00Z"` shows "Last run: 2025-01-01"; row with `last_run: null` shows "Never run"
  - **依赖**: 12.1, 8.3

- [x] 8.3 **Add last_run_status to cron.json schema**
  - **文件**: `extensions/personal-assistant/cron.ts` (Modify)
  - **内容**: Add optional `last_run_status: "ok" | "error" | null` field to `CronJob` interface; cron.ts session_start handler sets `last_run_status: "ok"` after marking `last_run`; on sendUserMessage failure (catch block), set `last_run_status: "error"`. No new file — just denormalize the status into existing cron.json. Backward compatible (field is optional).
  - **验证**: Existing TUI behavior unchanged for jobs without this field; new jobs get `last_run_status: "ok"` after first overdue fire
  - **依赖**: 8.1

## 14. Integration test: end-to-end

- [ ] 14.1 **End-to-end smoke test**
  - **文件**: `packages/webui/test/e2e/smoke.test.ts` (Create)
  - **内容**: Vitest integration: start full server, mock pi binary with a script that echoes; (a) GET /api/health, (b) POST /api/cron/jobs → 200, (c) GET /api/cron/jobs includes new, (d) WS connect + subscribe + receive broadcast on cron file change
  - **验证**: `cd packages/webui && npx vitest run test/e2e/smoke.test.ts` all tests PASS
  - **依赖**: 2.1, 3.3, 5.3, 6.5, 7.1, 9.2

- [ ] 14.2 **Manual E2E: full session + memory extraction**
  - **文件**: N/A (manual test in README)
  - **内容**: Add a section to `packages/webui/README.md` with step-by-step: (1) `pi --web`, (2) open browser, (3) create session, (4) send prompt, (5) verify stream, (6) delete session, (7) check memory.db has atoms
  - **验证**: Following README steps succeeds
  - **依赖**: 14.1

## Verification

- [ ] 全量测试: `cd packages/webui && npx vitest run` all tests PASS
- [ ] Web build: `cd packages/webui/web && npx vite build` succeeds
- [ ] Server typecheck: `cd packages/webui && npx tsc --noEmit` no type errors
- [ ] Web typecheck: `cd packages/webui/web && npx tsc --noEmit` no type errors
- [ ] pi core unchanged: `git diff packages/coding-agent/src/ packages/ai/src/ packages/agent/src/ | wc -l` shows only 1 file (args.ts or main.ts) changed
- [ ] Cron tool backward compat: existing TUI cron_write calls (4 actions) still work via `npx pi-test.sh -p "用 cron_write 加一个 job"`
- [ ] Memory schema match: read back atoms written by Web Server from `extensions/personal-assistant/memory.ts` injection path (start a pi session, verify atoms appear in system prompt context)

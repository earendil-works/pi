# Design: pi-webui

## Architecture Overview

pi-webui 是一个**独立 Web 项目**，与 pi 核心代码解耦。整体架构分三层：

```
┌──────────────────────────────────────────────────────────────┐
│  Browser (React 19 + Vite + TypeScript SPA)                  │
│  - 3 个主路由: /sessions, /chat/:id, /cron                   │
│  - WebSocket 客户端 + REST 客户端                             │
└──────────────────────────────────────────────────────────────┘
                    │ WebSocket (ws://127.0.0.1:8741/ws)
                    │ REST (http://127.0.0.1:8741/api/*)
                    ▼
┌──────────────────────────────────────────────────────────────┐
│  Web Server (Node.js + Express + ws)                         │
│  - 进程池: Map<sessionId, PiProcess>                         │
│  - Session 列表: 扫描 ~/.pi/agent/sessions/--<cwd>--/        │
│  - Cron 列表: 直接读 ~/.pi/agent/data/cron.json               │
│  - Memory 写入: 调 LLM 抽 atoms → 写 ~/.pi/agent/data/memory.db │
└──────────────────────────────────────────────────────────────┘
        │ spawn                │ 直接读写            │ 调 LLM API
        ▼                      ▼                     ▼
  ┌──────────┐         ┌──────────────┐         ┌─────────┐
  │ pi --mode │         │ cron.json    │         │ Provider│
  │ rpc 进程  │         │ memory.db    │         │ API     │
  └──────────┘         └──────────────┘         └─────────┘
```

**关键设计决策**:
1. **零侵入 pi 核心** — Web Server 通过 `pi --mode rpc` 与 pi 通信，pi 核心代码 (`packages/coding-agent/`, `packages/ai/`, `packages/agent/`) 不改
2. **复用已有 extension** — 复用 `extensions/personal-assistant/cron.ts` 和 `memory.ts`，不重建存储
3. **单一数据源** — Cron 数据由 cron.json 单一来源，TUI/extension/Web 三方共享；memory.db 同理
4. **Cron 触发解耦** — Cron 到点由 pi session_start hook 触发（已有逻辑），Web Server 仅展示，不抢执行权

## Component Breakdown

### 1. pi CLI 入口改动（`packages/coding-agent/src/cli/args.ts` + `main.ts`）

**改动量**: 1 个文件（`args.ts` 加 `--web` 解析 + main.ts 加 spawn 逻辑），约 30 行

```typescript
// args.ts 新增
.option("--web", "Start WebUI server")
.option("--port <port>", "Web server port (default 8741)", "8741")
.option("--max-sessions <n>", "Max concurrent sessions (default 16)", "16")

// main.ts 新增分支
if (parsed.web) {
  const webServerPath = ... // 定位 webui npm package
  const child = spawn("node", [webServerPath, "--port", parsed.port, "--max-sessions", parsed.maxSessions, "--cwd", process.cwd()], { stdio: "inherit" })
  child.on("exit", code => process.exit(code ?? 0))
  return
}
```

### 2. Web Server (`packages/webui/server/`)

**技术栈**: Node.js 20+ / Express 4 / ws (WebSocket 库) / better-sqlite3 (读 memory.db) / chokidar (watch cron.json)

**目录结构**:
```
packages/webui/
├── package.json
├── tsconfig.json
├── server/
│   ├── index.ts                 # 入口，HTTP + WS 启动
│   ├── routes/
│   │   ├── sessions.ts          # GET /api/sessions, GET /api/sessions/:id/messages
│   │   ├── cron.ts              # GET/POST/PUT/DELETE /api/cron/jobs
│   │   ├── chat.ts              # POST /api/sessions/:id/messages (proxy to pi)
│   │   └── static.ts            # GET /* (serve React build)
│   ├── ws/
│   │   └── handler.ts           # WebSocket 升级，桥接到 pi 进程
│   ├── session-pool.ts          # 进程池管理
│   ├── cron-store.ts            # cron.json 读写
│   ├── memory-store.ts          # memory.db 写入
│   └── llm-client.ts            # LLM 抽取 atoms
├── web/                         # React SPA
│   ├── package.json
│   ├── vite.config.ts
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx              # 路由 + 布局
│       ├── pages/
│       │   ├── SessionsPage.tsx # 左侧 session 列表
│       │   ├── ChatPage.tsx     # 右侧 chat 区域
│       │   └── CronPage.tsx     # Cron Dashboard
│       ├── components/
│       │   ├── SessionList.tsx
│       │   ├── ChatMessages.tsx
│       │   ├── CronList.tsx
│       │   ├── CronForm.tsx     # 创建/编辑模态框
│       │   └── CronLastRun.tsx  # 单 job 的 last-run 详情展开
│       └── lib/
│           ├── api.ts           # REST 客户端
│           └── ws.ts            # WebSocket 客户端
└── README.md
```

### 3. Session Pool (`session-pool.ts`)

**核心数据结构**:
```typescript
interface PooledSession {
  id: string;                    // 来自 session.jsonl header.id
  sessionFile: string;           // ~/.pi/agent/sessions/--<cwd>--/<ts>_<id>.jsonl
  cwd: string;
  piProcess: ChildProcess | null;  // null = session 在磁盘但未 spawn（idle）
  status: "idle" | "running" | "error" | "crashed";
  startedAt: number;
  lastActivity: number;
  wsClients: Set<WebSocket>;      // 多浏览器 tab 共享同一 session
}
```

**关键方法**:
- `init()`: 扫描 `~/.pi/agent/sessions/--<cwd>--/`，把所有 .jsonl 文件加载到 pool
- `spawnIfNeeded(sessionId)`: 如果 session 还没 pi 进程，spawn `pi --mode rpc --resume <id>`，建立 JSON-line 桥接
- `broadcast(sessionId, event)`: 把 pi 进程 stdout 事件转发给所有 wsClients
- `kill(sessionId, signal)`: SIGTERM → 5s 后 SIGKILL
- `cleanupOnExit()`: 给所有 running 进程发 SIGTERM

### 4. Cron Store (`cron-store.ts`)

**单一数据源**: `~/.pi/agent/data/cron.json`（与 cron.ts 共享）

**API**:
- `list()`: 读 JSON，返回 jobs 数组
- `add(job)`: 追加 + 写回
- `update(id, partial)`: 合并更新 + 写回
- `remove(id)`: 过滤 + 写回
- `triggerNow(id)`: 把 `last_run` 重置为过期（让 isOverdue 返回 true）

**并发安全**: 进程内 mutex（`fs.writeFile` 原子操作 + 启动时读锁）

**Watch 机制**: 用 chokidar watch cron.json 变化，触发 WS 广播给所有 wsClients（让其他 tab 同步更新）

### 5. Memory Store (`memory-store.ts`)

**目标**: 抽取 atoms → 写入 `~/.pi/agent/data/memory.db`

**复用 schema**: 复用 `extensions/personal-assistant/memory.ts` 已有的 SQLite schema（`memory_index` + `memory_fts` + `memory_embeddings` 表）

**写入方法**:
```typescript
function writeAtom(atom: ExtractedAtom): void {
  const db = new Database(MEMORY_DB_PATH);
  db.prepare(`
    INSERT INTO memory_index (id, type, title, summary, content, tags, importance, strength, access_count, last_access, created_at, updated_at, version, archived, file_path, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 1, 0, '', ?)
  `).run(/* ... */);
  db.prepare(`INSERT INTO memory_fts (id, title, tags) VALUES (?, ?, ?)`).run(/* ... */);
  db.close();
}
```

**重要约束**:
- 不重新发明 schema —— 直接用 memory.ts 的 schema
- 不做 compaction / decay —— memory.ts 已有
- 不做 query rewrite / search —— memory.ts 已有，WebUI 仅写入

### 6. LLM Client (`llm-client.ts`)

**功能**: 调 LLM API 抽取 memory atoms

**API 来源**: 读 `~/.pi/agent/models.json` 找到 default model，用相同的 provider

**抽取 prompt**: 复用 memory.ts 已有的 `extractPrompt`（line 1131+）
- 传 session JSONL 内容
- 要求 LLM 输出 `ExtractionPlan { plan: ExtractionPlanItem[] }`
- 每项包含 type/title/summary/tags/importance/content

**简化**: Web Server 不需要 query rewrite、不需要 embedding、不需要 async search；只调一次 LLM → 批量写 atoms

### 7. pi RPC Bridge (`ws/handler.ts`)

**协议**: 
- 浏览器 ↔ Web Server: WebSocket (JSON 帧)
- Web Server ↔ pi: stdin/stdout JSON-line (RPC mode)

**消息类型**:
- 浏览器 → Web Server: `{ type: "subscribe", sessionId }`, `{ type: "prompt", text, images? }`, `{ type: "abort" }`, `{ type: "switch_session", sessionId }`
- Web Server → 浏览器: `{ type: "session_event", sessionId, event: { ... } }` 透传所有 pi 事件
- pi → Web Server (stdout): RPC responses (pass through to wsClients)

**Event types** (from pi RPC):
- `message_start`, `message_update` (streaming), `message_end`
- `tool_execution_start`, `tool_execution_update`, `tool_execution_end`
- `turn_start`, `turn_end`
- `agent_start`, `agent_end`

## Cron Tool Extension 改动

**文件**: `extensions/personal-assistant/cron.ts`

**改动**:
1. 扩展 `cronWriteParams.operations[].action` union: 4 actions → 5 actions（加 `trigger_now`）
2. 在 `executeOperation` switch 加 `case "trigger_now"`：把 job 的 `last_run` 设为过期时间戳（让 `isOverdue` 返回 true）
3. 验证：现有 4-action 调用仍 work（向后兼容）

**`trigger_now` 实现**:
```typescript
case "trigger_now": {
  const job = jobs.find((j) => j.id === params.id);
  if (!job) return error;
  // 把 last_run 设为 1970-01-01，让 isOverdue 立即返回 true
  return { jobs: jobs.map(j => j.id === params.id ? {...j, last_run: null} : j), result: { ... success ... } };
}
```

**注意**: `isOverdue` 现有逻辑对 `last_run: null` 已正确处理（at 立即 overdue, every 立即 overdue, cron 当分钟匹配时 overdue）

## Testing Strategy

**TDD 顺序**:
1. **Server 单元测试** (`server/test/`):
   - `cron-store.test.ts`: list/add/update/remove/triggerNow，独立 mock fs
   - `memory-store.test.ts`: writeAtom，独立 mock better-sqlite3
   - `session-pool.test.ts`: 进程池管理（mock child_process）
2. **API 集成测试** (`server/test/integration/`):
   - 启动 Web Server，curl REST endpoints，验证状态码和 body
3. **Web 组件测试** (`web/src/components/*.test.tsx`):
   - React Testing Library 测组件渲染、事件处理
4. **E2E 测试** (manual):
   - `pi --web` → 浏览器 → 创建 session → 看到流式响应
   - 删除 session → 验证 memory.db 增长

**测试命令**:
- 服务端: `cd packages/webui && npm test`
- 客户端: `cd packages/webui/web && npm test`
- Lint: `cd packages/webui && npm run lint`

## Dependency Map

```
1. package.json (webui)
   └── 2. tsconfig.json
       └── 3. server/index.ts (HTTP+WS 启动)
           ├── 4. server/cron-store.ts
           │   └── 5. server/test/cron-store.test.ts
           ├── 6. server/session-pool.ts
           │   └── 7. server/test/session-pool.test.ts
           ├── 8. server/memory-store.ts
           │   └── 9. server/test/memory-store.test.ts
           ├── 10. server/llm-client.ts
           │    └── 11. server/test/llm-client.test.ts
           ├── 12. server/ws/handler.ts
           └── 13. server/routes/* (REST endpoints)
                └── 14. server/test/integration/*.test.ts
15. extensions/personal-assistant/cron.ts (加 trigger_now)
    └── 16. extensions/personal-assistant/test/cron.test.ts
17. packages/coding-agent/src/cli/args.ts (加 --web 解析)
18. packages/coding-agent/src/main.ts (加 spawn web server)
19. web/* (React SPA)
    └── 20. web/test/components/*.test.tsx
```

## Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| pi 进程 spawn 失败 | session-pool 自动重试 3 次，失败后转 error 状态 |
| cron.json 并发写 (TUI 和 Web 同时写) | 进程内 mutex + fs.writeFileSync 原子操作；TUI 写后 200ms 内 Web 读到旧值（最终一致） |
| memory.db schema drift | Web Server 写 atoms 前先 init（确保表存在）；schema 与 memory.ts 同步 |
| WebUI 频繁轮询 cron.json | chokidar watch 文件变化触发推送，避免轮询 |
| LLM 抽取超时 | 5s 超时 + 1 次重试，仍失败则跳过抽取 |
| 浏览器 tab 多开 | wsClients Set，每 session 共享同一 pi 进程，多 tab 都订阅 |
| 端口冲突 | `--port` 参数；启动失败时打印明确错误 |
| React build 大小 | 路由级 code split + 虚拟滚动 |

## Out of Scope (Confirmed)

- xterm.js 嵌入式终端（不做）
- 多用户认证（不做）
- 移动端响应式（不做）
- 实时协同编辑（不做）
- WebUI 端 mcp 工具调用（不做）
- swarm / 多 profile（不做）
- 跨设备 sync（不做）

# Design: pi-webui-fixes

## Context

`pi-webui` (上一 change, 已 archive) 已在 `http://127.0.0.1:18800` 真实跑过 56 分钟。手动浏览器测试暴露 5 个不可用性问题:

1. **session 列表范围错** — `process.cwd()` 被解析成 webui 包目录 (`packages/webui/`),所以 `GET /api/sessions` 只列 `~/.pi/agent/sessions/--home--qjh--workspace--personal--pi--packages--webui--/` 下的 12 个测试 session。用户在 `~/pi` 的真 session (`--home-qjh-pi--/`) 不可见。根因: webui server 启动时 cwd = webui 包,不是用户跑 `pi --web` 的父目录。
2. **agent 答非所问** — `session-pool.ts:prompt()` 写 `{type:"prompt", text, images}` 字段,但 pi RPC 协议 (`packages/coding-agent/src/modes/rpc/rpc-types.ts:51`) 要的是 `{type:"prompt", message, images, streamingBehavior}`。`message` 字段 undefined, prompt 根本没进 LLM。1 行字段名 bug。
3. **DELETE 卡死** — `routes/sessions.ts:DELETE` `await extractAtomsSafely(sessionFile)` 等 5s+1retry=10s 才 unlink,UI 一直转无响应。POST 没乐观更新。
4. **UI 布局反人类** — 现在 `Sessions` 独立页 + `Cron` 独立页,需翻路由才能看 history。豆包/ChatGPT 风格是 session 列表常驻左栏、点开直接聊、标题 = 第一句。
5. **cron 假数据** — 7 个 job 是我手动测试时通过 API 建的,真调度没跑。污染 `~/.pi/agent/data/cron.json`。

## Goals / Non-Goals

**Goals**:
- WebUI 列当前父 cwd 的真 session,字段名匹配 pi RPC,DELETE 乐观,左栏常驻,cron 干净
- 0 改 pi core(只读 `pi-agent-core` + `modes/rpc/rpc-types` 的类型签名)
- 自动化测试 125+18 不破,新加 4 个回归测试

**Non-Goals**:
- 不做 session 搜索/标签/分享
- 不做 Memory UI
- 不做多用户/auth(loopback 假设)
- 不重做 Cron 视觉
- 不修 7 个原 `[!]` 浏览器场景

## Decisions

### 1. WebUI cwd 解析

**Decision**: webui server 用 `process.cwd()` 直接当 session root。`main.ts:spawn()` 早已传 `cwd: process.cwd()` 给子进程,所以经 `pi --web` 启动时 cwd = 用户当前目录。问题只在我们手动 `node --import tsx/esm server/index.ts` 时出现(cwd = webui 包)。

**Rationale**: 零代码改动,`SessionPool` 已实现 `cwdDir` 编码逻辑。只需验证 spawn 链而非改 server。

**Alternatives considered**:
- `PI_WEB_CWD` env 显式覆盖 → 复杂、需文档化、用户难懂
- `--cwd` flag → 重复信息(用户已在 cwd 里)
- 多 cwd session 聚合显示 → 用户明确要 A (只当前 cwd)

### 2. RPC 协议字段名修正

**Decision**: `session-pool.ts:prompt()` 把 `text` 改成 `message`,images 字段保持。1 行修改。

**Rationale**: pi RPC 是真协议,字段名错配让 prompt 静默失败。1 行 fix。

**Alternatives considered**:
- 在 WebUI 侧改字段名 → 但 WebUI 内部用 `text` 也合理,改 server 一侧更内聚
- 加适配层兼容 `text`/`message` 两种 → 没必要,新代码统一用 `message`

### 3. 标题更新机制 (RPC set_session_name)

**Decision**: 收到首条 prompt 后,server 端取 `text.slice(0, 30)`,通过 stdin 给 pi 子进程发 `{"type":"set_session_name", "id":"<corr-id>", "name":"<title>"}`,等 `{"type":"response", "command":"set_session_name", "success":true}` 确认。失败静默(title 留空,不阻塞 prompt)。

**Rationale**: pi RPC 已有 `set_session_name` 命令 (`rpc-types.ts:69`),pi 负责写 JSONL 头。复用现有协议,服务端不直接碰 session 文件。

**Alternatives considered**:
- 服务端直接 rewrite JSONL 第一行 → 越界、并发风险、与 pi 内部结构耦合
- 客户端伪标题(sessionStorage 缓存) → 刷新丢,真不靠谱

### 4. DELETE 乐观化

**Decision**: `routes/sessions.ts:DELETE` 不 `await extractAtomsSafely()`,改成 `void extractAtomsSafely(...).catch(err => console.error(...))` 后立刻 unlink + 返 200。LLM 失败日志记录。

**Rationale**: 用户操作不能等 IO。LLM 抽 atoms 是 best-effort,失败不应影响主流程。

**Alternatives considered**:
- 同步但加 loading 态 → 5-10s 体验差,且 LLM 抽 atoms 本就是可失败的
- 跳过 atoms 抽取 → 失去 memory 累积

### 5. UI 架构:完整 SPA shell

**Decision**: `App.tsx` 重写为 SPA shell:

```tsx
<BrowserRouter>
  <div className="flex h-screen">
    <Sidebar /> {/* 常驻左栏: brand + nav + session list + New Chat */}
    <main className="flex-1 overflow-hidden">
      <Routes>
        <Route path="/" element={<EmptyChat />} />
        <Route path="/session/:id" element={<ChatPage />} />
        <Route path="/cron" element={<CronPage />} />
        <Route path="/cron/:id" element={<CronPage />} />
      </Routes>
    </main>
  </div>
</BrowserRouter>
```

`Sidebar` 组件: brand `pi webui`、顶栏 nav (Sessions tab active / Cron link)、session list (左滚动)、底部 + New Chat。

**Rationale**: 豆包/ChatGPT 标配布局,翻路由不影响用户对 history 的感知。React Router 已依赖,加嵌套路由零成本。

**Alternatives considered**:
- 只 /sessions 页加侧栏 → 架构不一致,Cron 页不动很怪
- 不改架构只修 bug → 用户已选 A

### 6. Cron 数据清理

**Decision**: 用 server 一个 `cleanup-cron-jobs.ts` 一次性脚本(或在 `routes/cron.ts` 加 `DELETE /api/cron/jobs` admin 端点)清空 `~/.pi/agent/data/cron.json`。**实施时手动跑一次清理现有 7 个 job**,不写进自动化测试。

**Rationale**: 数据污染处理,只一次。

## Architecture

### 组件图

```
┌─────────────────────────────────────────────────────┐
│ main.ts (pi CLI)                                    │
│  parsed.web → spawn("node", [webuiServerPath], {   │
│    cwd: process.cwd(),                             │  ← 父 cwd
│    env: { PI_WEB_PORT, PI_WEB_MAX_SESSIONS }       │
│  })                                                 │
└─────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│ webui server (process.cwd() = 用户 cwd)            │
│  SessionPool                                        │
│    sessionsDir = ~/.pi/agent/sessions/--<cwd>--/   │
│    spawnFn → "pi --mode rpc --resume <id>          │
│                   --cwd <reconstructed>"           │
│  ┌─ routes/sessions.ts                              │
│  │   GET    /api/sessions → list from sessionsDir  │
│  │   POST   /api/sessions → mkdir + writeHeader    │
│  │   GET    /:id/messages → read JSONL             │
│  │   DELETE /:id → unlink + void extractAtoms      │
│  │      .catch(log)                                │
│  ├─ routes/cron.ts (unchanged)                      │
│  ├─ ws/handler.ts                                  │
│  │   on("event", { sessionId, event }) → forward   │
│  │   on prompt:                                    │
│  │     1. pool.prompt(id, message)                 │  ← 字段名修正
│  │     2. if first prompt:                         │
│  │        pool.setSessionName(id, name.slice(0,30))│  ← 标题
│  │        .catch(noop)                             │
│  └─ session-pool.ts                                │
│      prompt: stdin.write({"type":"prompt",         │
│        "message": text, "images": images})         │  ← 字段修正
│      setSessionName: stdin.write(                  │
│        {"type":"set_session_name", "name": name})  │
└─────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│ React SPA shell (web/src/App.tsx)                   │
│  <BrowserRouter>                                    │
│    <div flex>                                       │
│      <Sidebar />                                    │
│        <Brand />                                    │
│        <NavLink to="/">Sessions</NavLink>           │
│        <NavLink to="/cron">Cron</NavLink>           │
│        <hr/>                                        │
│        <SessionList />                              │
│        {sessions.map(s =>                           │
│          <Link to={`/session/${s.id}`}              │
│            active={s.id === currentId}>             │
│            {s.title}                               │
│          </Link>)}                                  │
│        <button onClick={newSession}>+ New Chat</button> │
│      <main>                                         │
│        <Routes>                                     │
│          <Route path="/" element={<EmptyChat />} /> │
│          <Route path="/session/:id"                 │
│                 element={<ChatPage />} />           │
│          <Route path="/cron" element={<CronPage />} />│
│        </Routes>                                    │
│      </main>                                        │
│    </div>                                           │
│  </BrowserRouter>                                   │
└─────────────────────────────────────────────────────┘
```

### 关键接口

```ts
// SessionPool 新增方法
setSessionName(sessionId: string, name: string): Promise<void> {
  const state = this.sessions.get(sessionId);
  if (!state) return;
  const msg = JSON.stringify({
    type: "set_session_name",
    id: crypto.randomUUID(),
    name,
  }) + "\n";
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        try {
          const evt = JSON.parse(line);
          if (evt.type === "response" && evt.command === "set_session_name") {
            state.proc.stdout?.off("data", onData);
            if (evt.success) resolve();
            else reject(new Error(evt.error));
            return;
          }
        } catch {}
      }
    };
    state.proc.stdout?.on("data", onData);
    state.proc.stdin?.write(msg);
  });
}
```

```ts
// SessionInfo (api.ts) 新增字段
interface SessionInfo {
  id: string;
  title: string;       // 首句前 30 字,空时 "<new chat>"
  lastActive: string;  // ISO timestamp
  status: "idle" | "running";
  messageCount: number;
  cwd: string;         // 调试用
}
```

### 关键文件清单 (实施时)

| 文件 | 改动 |
|---|---|
| `server/session-pool.ts` | `prompt` 字段 `text` → `message`;新增 `setSessionName` 方法 |
| `server/ws/handler.ts` | prompt 收到后调 `setSessionName`(若 title 未知且非空) |
| `server/routes/sessions.ts` | DELETE `await extractAtomsSafely` → `void .catch(log)` |
| `server/session-pool.test.ts` | 加测试:字段名、setSessionName |
| `server/sessions-routes.test.ts` | 加测试:DELETE 响应 <500ms |
| `web/src/App.tsx` | 重写为 SPA shell + nested routes |
| `web/src/components/Sidebar.tsx` | 新建:brand + nav + session list + New Chat |
| `web/src/pages/EmptyChat.tsx` | 新建:`/` 路由空状态 |
| `web/src/pages/ChatPage.tsx` | 改:`/session/:id` 路由,首条 prompt 后传 title |
| `web/src/pages/SessionsPage.tsx` | 删除(被 Sidebar 替代) |
| `web/src/lib/api.ts` | SessionInfo 加 title 字段类型;`firstUserMessage` 可选 |

## Risks / Trade-offs

| Risk | Mitigation |
|---|---|
| `set_session_name` 失败时 title 留空 → 用户迷惑 | UI 显示 `New Chat` 兜底,首条 prompt 后立即重试一次 |
| pi 子进程 stdout 同时被 `setSessionName` 监听 + 事件转发用,可能竞争 | 监听加 sessionId 过滤,响应有 corr-id,匹配才 resolve |
| DELETE fire-and-forget 后 LLM 抽 atoms 进程崩溃 → memory 漏抽 | 加 `process.on("uncaughtException")` 兜底,console.error 记录 |
| 16 session 上限可能频繁触发 | 文档化;UI 给"delete to free up"提示 |
| 全 SPA shell 后浏览器后退键体验差 | 监听 `popstate` 在 session 切换时正常,不强约束 |
| Cron 7 个 job 删了不可恢复 | 用户明确要求,实施前最后确认一次 |
| 自动化测试 mock 太厚无法验证 RPC 协议 | 集成测试用真的 `pi --mode rpc` 子进程,验证 `message` 字段名 |

## Testing Strategy

### 单元测试
- `session-pool.test.ts`: 验 `prompt` 写入 stdin 的 JSON 含 `message` 字段不含 `text`
- `session-pool.test.ts`: 验 `setSessionName` 发 `set_session_name` 命令,响应 success=true 时 resolve
- `sessions-routes.test.ts`: 验 DELETE 响应 <500ms(LLM 抽 atoms 强制 mock 失败)
- `api.test.ts`: 验 SessionInfo 含 `title` 字段
- `Sidebar.test.tsx`(新): 验 session 列表渲染、点击切换路由

### 集成测试
- `integration.test.ts`: 端到端真启动 server,验证
  - cwd = 父目录的 sessionsDir 编码正确(`--home-qjh-pi--` from `~/pi`)
  - 收到 prompt 后,server 给 pi 子进程发的 JSON 是 `{message:...}` 不是 `{text:...}`
  - 触发 prompt → 等 2s → `GET /:id/messages` 含新 user msg + assistant msg
  - 触发 prompt → 等 1s → 再次 GET,session header 的 `name` 字段被设了
  - DELETE 响应 <500ms 即使 LLM 抽 atoms 必然失败
- `e2e/smoke.test.ts`: 加测试,验证 5 件事: 主页空状态、sidebar 显示真 session、点 session 进 /session/:id、点 New Chat 创建、点删除 200ms 内消失

### 边界
- 0 session 时 sidebar 显 "No sessions yet"
- 第一条消息是空 → title 不更新
- 第一条消息是 emoji → title 正常显示
- 第一条消息 >30 字 → 截 30
- 第一条消息 = 30 字 → 不截
- 16 session 都跑着 → 第 17 个 prompt 报错
- `pi --web` 第二次起同端口 → 退出 + 显 "port in use"

## Implementation Notes

### 依赖顺序 (sdd:write_plan 时拆 tasks 用)
1. **先修后端 bug**(不动 UI)
   - session-pool.ts 字段名 + setSessionName
   - ws/handler.ts 接 setSessionName
   - sessions.ts DELETE 乐观
   - 加单元测试
2. **再清 cron 数据**(独立一步,`./node_modules/.bin/tsx scripts/clean-test-cron.ts` 或直接手动 `rm`)
3. **最后重做 UI**(分阶段)
   - App.tsx shell + Sidebar
   - SessionsPage 删除逻辑挪到 Sidebar
   - ChatPage 改造(支持 setSessionName 调用)
   - EmptyChat 新建
   - 加 Sidebar/EmptyChat 单元测试
4. **cwd 验证**(从 spawn 链,不是 server 改) — 单独跑一次集成测试就够

### 关键坑
- `setSessionName` 实现时:pi 子进程 stdout 上有 `event` (AgentEvent) 和 `response` (RPC response) 两种 JSON,过滤时必须按 `evt.type === "response"` 分流,否则 AgentEvent 也会触发 resolve
- `setSessionName` 的 corr-id: 建议在 session state 里存一个待响应 Set,避免误匹配旧的响应
- React Router v7: 用 `NavLink` 不是 `Link`,`active` 用 className 函数判断
- Sidebar 实时刷新 session 列表:用 `useQuery` 拉一次,`setInterval` 30s 重拉;session_created/delete 事件后乐观更新本地 state
- SPA shell 启动后,主页 `/` 没有 session,左栏也要展示历史 + New Chat(用户可能想看)

### 不动的东西
- `routes/cron.ts` 5 个 REST 端点
- `cron-store.ts` 内部实现
- `cron-watcher.ts` debounce 逻辑
- `routes/health.ts` 端点
- `routes/static.ts` 静态服务
- helmet 8.0.0、express.json 32KB、H4-6 全部安全加固
- llm-client.ts 的 5s+retry 逻辑(只是不 await 它)
- memory-store.ts 写 atoms
- `extensions/personal-assistant/cron.ts` 5 actions
- pi core 任何文件

### 自动化检查
- `npm run check` 干净
- 125/125 server tests pass
- 18/18 web tests pass
- + 新增 4 个回归测试
- 浏览器 E2E 走 4 场景

<!-- archived-with: 2026-06-04-pi-webui-fixes | status: final -->

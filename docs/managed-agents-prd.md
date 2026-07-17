# Managed Agents 三分离 PRD

| 字段 | 值 |
|---|---|
| 状态 | Draft（待评审） |
| 日期 | 2026-07-18 |
| 仓库 | L-Rocket/pi（fork of earendil-works/pi） |
| 范围包 | 新增 `packages/managed`；最小侵入 `packages/coding-agent` |

## 1. 背景

pi coding agent 目前是单体进程：LLM 推理调用、session 状态持久化、工具执行（bash/文件操作）三者耦合在同一进程内：

- **推理耦合**：agent loop 默认直接调用 `streamSimple`（`packages/agent/src/agent-loop.ts:304`），provider 凭据从本机 `~/.pi/agent/auth.json` 读取，HTTP 请求从 agent 进程直连 LLM provider。
- **Session 耦合**：`SessionManager`（`packages/coding-agent/src/core/session-manager.ts:791`）用同步 `fs` 调用读写本地 `~/.pi/agent/sessions/` 下的 JSONL 文件，本地磁盘是唯一权威存储。
- **执行耦合**：7 个内置工具（read/bash/edit/write/grep/find/ls）全部在 agent 进程内通过 `fs` / `child_process` 直接操作本机，无隔离。

这导致：agent 进程必须持有 provider 凭据；执行节点崩溃即丢失运行现场；工具执行与 agent 同权，无安全边界；无法把执行环境弹性地放到云上。

## 2. 目标与非目标

### 2.1 目标

把 agent 拆成三个**独立部署、独立演进、可组合**的组件，支撑云上 managed agents 形态：

1. **推理分离**：agent 进程不持有 provider 凭据，推理请求全部经过 Inference Gateway。
2. **Session 分离**：Session Service 是 session 状态的唯一权威存储，agent 执行节点可随时重建（远程权威）。
3. **沙箱分离**：工具执行全部发生在 Sandbox Worker 内，agent 进程不直接触碰执行环境的文件系统和进程空间。
4. **可组合**：三个组件各自独立启动、独立容器化；Agent Runtime 仅通过 URL 引用它们，任意一个可替换为本地实现（开发态）或远程实现（云态）。

### 2.2 非目标（本仓库明确不做）

- **不做编排**：多 agent 协作、任务分发、工作流编排。
- **不做资源调度**：worker 池管理、自动伸缩、负载均衡、放置策略——由外部基础设施（如 Kubernetes）负责。
- **不做多租户控制面**：租户管理、配额、计费、鉴权体系（协议预留 auth token 位置，校验逻辑留给网关前置层）。
- **不改动上游核心语义**：agent loop、工具定义、session 文件格式保持与上游一致，便于跟踪 upstream。

## 3. 术语

| 术语 | 含义 |
|---|---|
| Agent Runtime | 运行 agent loop 的进程（pi coding-agent core），三分离后本身无状态、无凭据 |
| Inference Gateway | 推理网关，集中持有 provider 凭据，转发流式 LLM 请求 |
| Session Service | session 权威存储服务，提供 load/append/rewrite/list/fork |
| Sandbox Worker | 工具执行环境，接收工具操作请求并在受控环境内执行 |
| `streamFn` | agent loop 的推理函数注入点（`packages/agent/src/agent-loop.ts:36`） |
| `*Operations` | 各工具的可插拔执行接口（`BashOperations`、`ReadOperations` 等） |
| `SessionStore` | 本 PRD 新增的 session 存储抽象（异步） |

## 4. 总体架构

```
                 ┌────────────────────────────┐
                 │       Agent Runtime        │
                 │  (pi coding-agent core,    │
                 │   无凭据 / 无本地 session)  │
                 └──────────────┬─────────────┘
                                │ 仅三个出站连接，全部走 URL 配置
        ┌───────────────────────┼────────────────────────┐
        ▼                       ▼                        ▼
┌───────────────┐   ┌────────────────────┐   ┌────────────────────┐
│ Inference     │   │ Session Service    │   │ Sandbox Worker     │
│ Gateway       │   │ (权威存储)          │   │ (工具执行环境)      │
│               │   │                    │   │                    │
│ 持 provider   │   │ load/append/       │   │ bash/read/write/   │
│ 凭据,转发流式  │   │ rewrite/list/fork  │   │ edit/grep/find/ls  │
│ LLM 请求      │   │                    │   │                    │
└───────┬───────┘   └─────────┬──────────┘   └─────────┬──────────┘
        ▼                     ▼                        ▼
  LLM providers         持久卷 / 对象存储          容器 / VM / 远程机
  (Anthropic,           (本地 JSONL 起步,          (隔离级别由部署方
   OpenAI, ...)          格式不变)                  决定,协议不变)
```

组合方式：Agent Runtime 启动时接收三个 URL（环境变量或 CLI flag）：

```bash
PI_INFERENCE_URL=http://gateway:8080 \
PI_SESSION_URL=http://session:8081 \
PI_SANDBOX_URL=http://sandbox:8082 \
pi -p "fix the bug in src/"
```

任一 URL 缺省时回落到当前本地行为（本地推理 / 本地 session 文件 / 本地工具执行），保证开发态体验与上游一致。

## 5. 组件设计

### 5.1 Inference Gateway

**职责**：集中持有 provider 凭据（auth.json / env）；接收 agent 的推理请求，调用真实 provider，把流式事件回传。agent 进程从此不需要任何 API key。

**协议**：复用现有 `streamProxy` 客户端协议（`packages/agent/src/proxy.ts:116`），本 PRD 只需实现**服务端**：

- `POST /api/stream`
  - Request: `{ model, context, options }`（`options` 仅含可序列化字段，见 `proxy.ts:59-71`）
  - Response: SSE 流，`data: <ProxyAssistantMessageEvent>\n` 事件序列（`proxy.ts:36-57`，delta 事件不含 `partial` 字段以省带宽）
  - Auth: `Authorization: Bearer <token>`，token 校验逻辑本仓库只留接口，具体实现由部署方前置
- 错误：非 200 返回 `{ error: string }`

**服务端实现**：收到请求后，用 gateway 本地的 `ModelRuntime`（`packages/coding-agent/src/core/model-runtime.ts`）解析凭据并调用 `streamSimple`，把产出的 `AssistantMessageEvent` 序列化为 `ProxyAssistantMessageEvent` 写出。

**Agent 侧接线**：`sdk.ts:289-325` 当前构造 `streamFn` 调用 `modelRuntime.streamSimple`；当 `PI_INFERENCE_URL` 存在时，改为注入 `streamProxy(model, context, { ...options, proxyUrl, authToken })`。`streamFn` 注入点上游已原生支持，改动为纯 additive。

### 5.2 Session Service

**职责**：session 状态的唯一权威存储。执行节点崩溃后，新节点凭 `sessionId` 从服务恢复全部历史。

**数据模型**：沿用现有 JSONL 格式与 `SessionEntry` 类型（v3，`session-manager.ts:32-152`），存储后端首版就是服务端的 JSONL 文件（每 session 一个文件），后续可换对象存储而协议不变。

**API**（HTTP/JSON，NDJSON 用于 entry 流）：

| 方法 | 路径 | 语义 |
|---|---|---|
| `POST` | `/sessions` | 创建 session（header：id/cwd/parentSession），返回 sessionId |
| `GET` | `/sessions/:id/entries` | 全量加载 entry 流（NDJSON） |
| `POST` | `/sessions/:id/entries` | 追加一条 entry（服务端保证同 session 内顺序） |
| `PUT` | `/sessions/:id/entries` | 全量重写（migration/fork 用，低频） |
| `GET` | `/sessions?cwd=` | 列出 session（支持按 cwd 过滤） |
| `POST` | `/sessions/:id/fork` | 复制生成新 session，返回新 sessionId |

**一致性语义**：远程权威 + turn 边界 flush。

- agent 侧每次 append 先入本地写队列，**在 assistant `message_end`（turn 结束）时 flush**；崩溃恢复粒度 = 上一个完整 turn，与上游本地行为等价（本地 JSONL 也是 turn 结束后才落盘 assistant 消息）。
- `rewrite`/`fork` 为同步等待（低频操作）。
- 单 session 同一时刻只允许一个 writer（服务端用 per-session 锁串行化 append）。

**Agent 侧接线（本 PRD 最大改动）**：新增异步 `SessionStore` 接口，注入 `SessionManager`：

```ts
interface SessionStore {
  load(sessionRef: string): Promise<string[]>;        // JSONL lines
  append(sessionRef: string, line: string): Promise<void>;   // 写队列
  rewrite(sessionRef: string, lines: string[]): Promise<void>;
  flush(sessionRef: string): Promise<void>;
  list(cwd?: string): Promise<SessionInfo[]>;
  fork(sourceRef: string): Promise<string>;           // 返回新 ref
}
```

- `LocalSessionStore`：抽取 `SessionManager` 现有 fs 逻辑，行为与上游完全一致（默认）。
- `RemoteSessionStore`：HTTP 客户端，append 走内存队列 + turn 边界 flush。
- `SessionManager` 改造原则：**外部同步 API 不变**。内存索引（`byId`/`leafId`/`fileEntries`）本来就是权威，磁盘只在 load（构造前异步预取）和 persist（写队列）两个点接触 store。新增异步工厂（如 `SessionManager.openWithStore`），现有同步工厂保留并委托 `LocalSessionStore`。
- `sessionFile` 字段语义扩展为 opaque ref（远程时为 `managed://sessions/<id>`）；orchestrator 已将其视为不透明字符串，无影响。

### 5.3 Sandbox Worker

**职责**：在受控环境内执行全部工具操作。agent 进程不再直接 `fs`/`child_process`。

**协议**（HTTP/JSON；bash 输出用 SSE 流式回传）：

| 操作 | 路径 | 对应接口 |
|---|---|---|
| 执行命令 | `POST /bash/exec`（SSE 回传 stdout/stderr/exit） | `BashOperations.exec` |
| 读文件 | `POST /fs/read` | `ReadOperations.readFile` / `EditOperations.readFile` |
| 写文件 | `POST /fs/write` | `WriteOperations.writeFile` / `EditOperations.writeFile` |
| 建目录 | `POST /fs/mkdir` | `WriteOperations.mkdir` |
| 存在性/权限 | `POST /fs/access` | `*Operations.access` / `exists` |
| stat | `POST /fs/stat` | `LsOperations.stat` |
| 列目录 | `POST /fs/readdir` | `LsOperations.readdir` |
| grep | `POST /grep`（流式） | `GrepOperations` |
| find | `POST /find` | `FindOperations` |

**Worker 实现**：独立 Node 进程，启动参数 `--root <dir>`：

- **cwd jail**：所有路径解析后必须落在 `--root` 内，逃逸请求直接拒绝（`path.resolve` + 前缀校验 + realpath 防符号链接逃逸）。
- **env scrub**：子进程环境白名单（`PATH`/`HOME`/`LANG` 等最小集），不继承 worker 进程 env，杜绝凭据泄漏进执行环境。
- bash/grep/find 在 worker 进程内 spawn（rg/fd 二进制随 worker 镜像分发）。
- 本仓库只交付到"独立进程 + 受限环境"这一档；容器/VM/远程机隔离由部署方提供——**协议不变**，worker 镜像即可作为容器 entrypoint。

**Agent 侧接线**：7 个工具全部已有 `*Operations` 注入点（`packages/coding-agent/src/core/tools/index.ts:86-94` 的 `ToolsOptions`）。新增远程实现 `RemoteBashOperations`、`RemoteReadOperations` 等（内部共用一个 sandbox HTTP client），当 `PI_SANDBOX_URL` 存在时经 `ToolsOptions` 注入。工具定义、agent loop、审批 hook 全部零改动。

## 6. 对现有代码的改动清单

原则：**additive 优先**，上游文件改动最小化，保证 fork 可持续 rebase upstream。

| 改动 | 位置 | 性质 |
|---|---|---|
| 新增 `packages/managed`：共享协议类型、三个服务、三个客户端、`managed` CLI | 新包 | 纯新增 |
| `SessionStore` 接口 + `LocalSessionStore`（抽取现有 fs 逻辑）+ 异步工厂 | `coding-agent/src/core/session-manager.ts` | 重构，外部 API 不变 |
| `PI_INFERENCE_URL` 存在时注入 `streamProxy` | `coding-agent/src/core/sdk.ts` | additive 分支 |
| `PI_SANDBOX_URL` 存在时注入远程 `*Operations` | `coding-agent` 工具装配处 | additive 分支 |
| turn 边界调用 `store.flush()` | `coding-agent/src/core/agent-session.ts`（`message_end` 处理处） | additive 调用 |

不改动：agent loop、工具定义、session 文件格式、RPC 模式协议、orchestrator。

## 7. 里程碑

每个里程碑结束系统均可运行。

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 推理分离 | `packages/managed` 骨架 + 协议类型 + Inference Gateway 服务端 + agent 侧 `PI_INFERENCE_URL` 接线 | agent 无凭据跑通一次完整 prompt（gateway 持 key） |
| M2 沙箱分离 | Sandbox Worker + 7 个远程 `*Operations` + `PI_SANDBOX_URL` 接线 | agent 在 worker 的 `--root` 内完成读写文件 + 跑 bash，逃逸路径被拒绝 |
| M3 Session 分离 | `SessionStore` 抽象 + `LocalSessionStore` + Session Service + `RemoteSessionStore` + `PI_SESSION_URL` 接线 | 杀掉 agent 进程，新进程凭 sessionId 恢复全部历史继续对话 |
| M4 组合 demo | `managed` CLI（分别启动三服务 + agent）+ 集成测试 + 使用文档 | 三服务独立启动，agent 仅通过 URL 组合，完成一个真实 coding 任务 |

测试策略：沿用仓库现有 harness（`packages/coding-agent/test/suite/harness.ts` + faux provider），gateway 在测试中注册 faux provider，不产生真实 API 调用；sandbox/session 服务测试用临时目录。

## 8. 验收标准（GWT）

**AC1 推理分离**
- Given Inference Gateway 持有 provider 凭据并运行
- And agent 进程环境内无任何 provider key
- When 用户通过 agent 发起 prompt
- Then agent 经 gateway 完成流式推理并输出结果
- And 杀掉 gateway 后 agent 推理请求失败但进程不崩溃（错误事件正常上抛）

**AC2 沙箱分离**
- Given Sandbox Worker 以 `--root /tmp/work` 运行
- When agent 执行 `bash`/`write`/`edit` 等工具
- Then 所有副作用发生在 `/tmp/work` 内
- And 任何解析后越出 root 的路径（含符号链接逃逸）被拒绝并返回错误

**AC3 Session 分离（远程权威）**
- Given agent 正在使用 Session Service 进行对话
- When 在 turn 结束后杀掉 agent 进程
- And 用同一 sessionId 在新节点启动 agent
- Then 新节点恢复全部历史并可继续对话
- And 崩溃点最多丢失最后一个未完成 turn

**AC4 可组合**
- Given 三个服务各自独立启动（可分别在不同容器/机器）
- When agent 仅通过三个 URL 启动
- Then 完成一个包含"读代码 → 改文件 → 跑命令验证"的完整 coding 任务
- And 任一 URL 缺省时 agent 回落到对应本地实现，行为与上游一致

## 9. 开放问题

1. **服务间鉴权**：三个 URL 前的 token 校验由谁做（本仓库只留 `Authorization` 透传，校验放部署方前置层？）
2. **bash 流式协议**：SSE 单向流足够覆盖 stdout/stderr/exit code，但交互式命令（stdin 写入）是否需要 WebSocket？首版不支持交互式。
3. **session 并发写**：同一 sessionId 被两个 agent 同时打开时的策略（首版：服务端 per-session 锁，后到者拒绝或只读？）
4. **大文件传输**：`fs/read`/`fs/write` 的 body 大小上限与分块策略。
5. **gateway 模型路由**：`model` 字段完全由 agent 指定，还是 gateway 可做重写/降级策略（首版：透传，不重写）。

## 附录：关键代码事实索引

| 事实 | 位置 |
|---|---|
| agent loop 的 `streamFn` 注入点 | `packages/agent/src/agent-loop.ts:36` |
| 现有 proxy 客户端（推理分离协议起点） | `packages/agent/src/proxy.ts:116-233` |
| coding-agent 当前 streamFn 装配 | `packages/coding-agent/src/core/sdk.ts:289-325` |
| SessionManager（同步 fs，唯一消费入口） | `packages/coding-agent/src/core/session-manager.ts:791` |
| session JSONL 格式与 entry 类型（v3） | `packages/coding-agent/src/core/session-manager.ts:32-152` |
| 工具 `*Operations` 注入点汇总 | `packages/coding-agent/src/core/tools/index.ts:86-94` |
| `BashOperations`（注释明示可远程委托） | `packages/coding-agent/src/core/tools/bash.ts:56-74` |
| 工具审批 hook（沙箱之上的另一道闸） | `packages/agent/src/agent-loop.ts:621-644` |

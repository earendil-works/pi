# Design: agent-loop-recall-and-file-tracking

## Context

Pi agent loop 在 TUI 使用流程中存在三个用户可验证的体验问题：

1. **Steer 入口记忆盲区** — `agent-harness.ts:679-684` 的 `steer()` 方法只 `push` 消息到队列，**不触发** `before_agent_start` 钩子。`personal-assistant` 扩展的 `pendingMemorySearch` 机制依赖 `before_agent_start` 触发，steer 路径下记忆检索彻底失效。TUI 用户在第 5 轮 steer 切换到"cron 性能"话题时，agent 仍停留在 prompt() 入口的"重构项目"记忆上。

2. **File tracking 漏报（结构化 read-only 工具）** — `packages/agent/src/harness/compaction/utils.ts:24-51` 的 `extractFileOpsFromMessage` 只跟踪 `read`/`write`/`edit` 三个工具。`grep` / `find` / `ls` 也搜索文件路径，但不被记录。压缩后 summary 漏报 → 下次 LLM 误判"哪些目录被搜过"。

3. **Satellite 子工具命名不一致 + 门控只覆盖 Satellite 路径** — `extensions/satellite/satellite-server.ts` 通过聚合 tool `satellite_remote_exec` 暴露 8 个子命令（`read_file` / `write_file` / `edit_file` / `list_dir` / `find_files` / `grep_files` / `bash` / `transfer_file`），跟本地 `read` / `write` / `edit` / `ls` / `find` / `grep` 不同名，LLM 认知负担高。同时 personal-assistant 的 bash intent guardrail (`detectBashIntent` / `checkBashIntent`) 只在 `event.toolName === "satellite_remote_exec"` 时触发，**本地 bash 完全不被门控**，LLM 仍然可以走 `bash: cat file.txt` 绕开结构化工具，compaction fileOps 跟踪失效。

三个问题经过 5 轮代码校准（包含 `extensions/personal-assistant/tools.ts` 的 `validateSatelliteCall` / `checkBashIntent` / `detectBashIntent` 实测）和用户确认触发场景为真。

## Goals / Non-Goals

**Goals**:
- `steer()` 触发 `before_agent_start` 钩子，记忆系统可见新消息
- 本地 `grep` / `find` / `ls` 工具的 `args.path` 进入 `fileOps.read`
- Satellite `satellite_remote_exec({tool: "grep"/"find"/"ls", path: ...})` 也进入 `fileOps.read`
- Satellite 子工具名跟本地同名（`read` / `write` / `edit` / `list` / `find` / `grep`），`transfer_file` 保留原名
- Bash intent guardrail 跨本地 + Satellite 共享同一套 `detectBashIntent` 逻辑，budget 分键
- 不引入新运行时依赖
- 边界 case 降级而非报错

**Non-Goals**:
- 不修改 `followUp()` / `nextTurn()` — 不是 TUI 入口
- 不做 bash AST 解析 — 用户明确否决（v1 不解析 bash command 提取文件路径，依赖结构化工具 + guardrail 引导）
- 不修改 compact 触发逻辑 / reserveTokens
- 不跨进程并发控制
- 不修改 `FileOperations` schema（不需要 `deleted` 字段，因为不解析 bash `rm`）
- 不修改 `computeFileLists` 签名
- 不动 `transfer_file` 子工具名（参数不同，保留原名）

## Decisions

### 1. Steer emit `before_agent_start` 而非 `context` 重检

**Decision**: 在 `steer()` 入口显式 `await this.emitHook("before_agent_start", { prompt: steerText, ... })`。

**Rationale**: `before_agent_start` 是 memory 扩展已知的触发点。复用现成机制比发明新钩子简单。emitHook 的 `systemPrompt` 字段直接传当前 `this.systemPrompt`（不变），扩展读取 `event.prompt` 启动 search。

**Alternatives considered**:
- 在 `context` 钩子里检测 "last message 是 steer" 重新跑 search → 复杂、跨扩展耦合
- 加新事件 `user_message_received` → 新 API surface，需要扩展都订阅

### 2. Pending search 覆盖策略

**Decision**: 每次 `before_agent_start` 触发时无条件覆盖 `pendingMemorySearch`。

**Rationale**: 简单。旧 promise 即使未完成也会 GC 后被丢弃（不 await 的话）。新 promise 完成后被下一个 `context` 消费，反映最新主题。

**Alternatives considered**:
- 等待旧 promise 完成再合并 → 引入 race、阻塞 steer 路径
- 多 pending 队列 → 复杂度上升，无实际收益（最终只消费一次）

### 3. grep / find / ls: 提取 `args.path` 到 `fileOps.read`（本地）

**Decision**: 这三个工具是"查询"，不修改文件，只把搜索目录记为"被读"。

**Rationale**: 不解析 result 输出（避免 truncated 边界、JSON 格式、多行匹配等问题）。`args.path` 即搜索根目录，够用。

**Alternatives considered**:
- 解析 result 反向提取匹配文件 → 收益小（summary 里只列 `src/` 和"被搜了"即可），复杂

### 4. Satellite remote_exec 子工具: 跟踪 grep/find/ls（args.tool 判断）

**Decision**: 在 `extractFileOpsFromMessage` switch 加 `case "satellite_remote_exec"`,内部读 `args.tool`：
- `"grep"` / `"find"` / `"ls"` → `fileOps.read.add(path)`
- 其他 (`"read"` / `"write"` / `"edit"` / `"bash"` / `"transfer_file"`) → 跳过

**Rationale**: 既然子工具名跟本地同名（决策 5），判断逻辑跟本地 case 字符串完全一致。`bash` 子工具不进 fileOps（用户否决 bash regex），`read` / `write` / `edit` 是结构化操作不在 fileOps 跟踪范围，`transfer_file` 跨本地/远端不是单一文件操作也不进。

**Alternatives considered**:
- 拆成 3 个独立 MCP tool (`satellite_grep_files` 等) → LLM 看到 3 个 tool 增加认知负担，违背用户设计意图
- 跟踪所有 satellite 子工具 → 范围过广

### 5. Satellite 子工具改名（read/write/edit/list/find/grep, transfer_file 不动）

**Decision**: `extensions/satellite/schema.ts` 的 z.enum 从 `_file` / `_dir` / `_files` 后缀改成短名，跟本地对齐。`transfer_file` 保留原名（参数 `direction` / `local_path` / `remote_path` 非标准）。

**Rationale**: LLM 看到 1 个 `satellite_remote_exec` tool，内部子工具跟本地同名后用法、参数、schema 完全一致，认知负担最小。`transfer_file` 因为参数 schema 不同（`direction` + `local_path` + `remote_path`），短化无收益。

**联动影响**:
- `extensions/personal-assistant/tools.ts:273` `BashIntent` type 同步改名
- `extensions/personal-assistant/tools.ts:286-302` `getBashGuidance` 字符串里 `tool:"read_file"` → `tool:"read"` 等
- `extensions/personal-assistant/test/satellite-guards.test.ts` 现有断言同步改

**Alternatives considered**:
- 完全去掉 prefix（让 LLM 看到 `read` / `grep` 等短名）→ 多 MCP server 撞名风险（架构层硬约束）
- 拆 3 个独立 MCP tool → LLM 看到多个 tool，违背用户设计意图

### 6. Bash intent guardrail: 跨本地 + Satellite 共享

**Decision**: 提取 `checkBashIntentCommon(command, turnId, prefix: "local" | "satellite")` 共享函数。`bashIntentBudget` 用 `${turnId}:${prefix}:${intent}` 作 key,两边独立计数。

原 `pi.on("tool_call")` 钩子拆为:
```ts
pi.on("tool_call", async (event) => {
  if (event.toolName === "bash") {
    // 本地: 走共享 guardrail
    return checkBashIntentCommon(command, turnId, "local");
  }
  if (event.toolName === "satellite_remote_exec") {
    // Satellite: 走 validateSatelliteCall (内含 guardrail "satellite" prefix)
    return validateSatelliteCall(...) ?? interceptTransferCall(event);
  }
  return undefined;
});
```

**Rationale**: 两边用同一个 `detectBashIntent` 检测函数 + 同一个 budget 逻辑，避免代码重复。`prefix` 分键确保本地 LLM 用 `bash: cat` 3 次后硬拦截,satellite LLM 仍可继续(`prefix=satellite` 独立计数)。

**Alternatives considered**:
- 本地门控另写一个独立函数 → 代码重复,bug 修两份
- 共享 budget(不分 prefix)→ 一边 3 次后另一边也被锁,语义错
- 只做本地门控(不动 satellite)→ 卫星用户仍可绕开,但 satellite 已经有 `validateSatelliteCall` 的 guardrail

## Architecture

### A. Steer 入口

```
agent-harness.ts (修改)
└── steer(text, options)
    ├── await this.emitHook({ type: "before_agent_start", prompt: text, ... })
    ├── this.steerQueue.push(createUserMessage(text, options?.images))
    └── await this.emitQueueUpdate()
```

### B. extractFileOpsFromMessage 扩展

```
harness/compaction/utils.ts (修改) + coding-agent/.../utils.ts (同步)
└── extractFileOpsFromMessage (扩展 switch)
    ├── case "read" / "write" / "edit"  (现有逻辑)
    ├── case "grep" / "find" / "ls"     → fileOps.read.add(path)  (新增)
    └── case "satellite_remote_exec"     → if (args.tool ∈ grep/find/ls) fileOps.read.add(path)  (新增)
```

两份 utils.ts 完全相同,**必须同步修改**(运行时用 coding-agent 包,agent 副本是 mirror)。

### C. Satellite 子工具改名

```
extensions/satellite/schema.ts (修改)
└── REMOTE_EXEC_INPUT_SCHEMA.tool: z.enum([bash, read, write, edit, list, find, grep, transfer_file])

extensions/satellite/satellite-server.ts (修改)
├── TOOL_HANDLERS key: read / write / edit / list / find / grep / bash / transfer_file
└── createMcpServer description: 子工具示例同步改名
```

### D. Bash intent guardrail 跨端共享

```
extensions/personal-assistant/tools.ts (修改)
├── BashIntent type:  read | write | edit | list | find | grep
├── getBashGuidance:  tool:"read"/"write"/"edit"/"list"/"find"/"grep"
├── checkBashIntentCommon(command, turnId, prefix) (提取)
│   └── bashIntentBudget key: ${turnId}:${prefix}:${intent}
├── 原 checkBashIntent → checkBashIntentCommon(..., "satellite")
└── pi.on("tool_call") 拆为: bash → "local"; satellite_remote_exec → "satellite"
```

## Data Flow

### Steer 入口记忆召回

```
用户按 Ctrl+S
  ↓
TUI 调用 session.steer("新话题")
  ↓
agent-harness.ts:679 steer() 方法
  ↓ await emitHook("before_agent_start", { prompt: "新话题", ... })
  ↓ memory 扩展: pendingMemorySearch = searchMemory("新话题", ...)
  ↓
steerQueue.push(userMessage)
  ↓
emitQueueUpdate() 通知 UI
  ↓
(返回, steer 完成, 不阻塞)
  ↓
runLoop 下次迭代处理 pending messages
  ↓
push steer 消息到 currentContext.messages
  ↓
transformContext → context 钩子
  ↓ pendingMemorySearch 存在, await → 拿到 atoms
  ↓ 把 memory 块 prepend 到 last user message (= steer 消息)
  ↓
LLM call 看到新主题记忆
```

### File tracking (本地 + Satellite)

```
agent 调用 grep({ pattern: "TODO", path: "src" })
  ↓
session 持久化 ToolCallMessage (name: "grep")
  ↓
(数小时后) 触发压缩
  ↓
extractFileOperations() 调用
  ↓
extractFileOpsFromMessage 处理 assistant message
  ↓ 命中 case "grep"
  ↓ fileOps.read.add("src")
  ↓
computeFileLists() 返回 readFiles = ["src"]
  ↓
summary += formatFileOperations(readFiles, modifiedFiles)
  ↓
<read-files>src</read-files> 出现在 summary


(Satellite 同理, name: "satellite_remote_exec" + args.tool === "grep")
```

### Bash intent guardrail (本地)

```
agent 调用 bash({ command: "cat /etc/hostname" })
  ↓
pi.on("tool_call") 钩子触发
  ↓ event.toolName === "bash"
  ↓ checkBashIntentCommon(command, turnId, "local")
  ↓ detectBashIntent 识别为 "read"
  ↓ bashIntentBudget["t1:local:read"] 计数 +1
  ↓
return { block: true, reason: "Prefer read over bash cat. Use { tool:\"read\", path:'/etc/hostname' } for offset/limit/truncation." }
  ↓
LLM 看到建议,重试调 read tool
```

## Risks / Trade-offs

| Risk | Severity | Mitigation |
|------|----------|------------|
| Steer 频繁触发 `before_agent_start` 引入延迟 | Low | emitHook 不 await async handlers；steer 调用本身不阻塞 |
| Bash guardrail 误识别 (path component 里有 `find` / `grep`) | Low | `detectBashIntent` 用 `(?<![/_\-a-zA-Z0-9])` lookbehind 守卫(已有测试覆盖) |
| Bash guardrail pipeline 误报 (`cat \| tr`) | Low | `if (/[\|<]/.test(command)) return null;` 提前 return |
| 本地 + Satellite budget 串台 | Low | budget key 加 `prefix` 字段(`local` / `satellite`),完全独立 |
| Satellite 子工具改名影响现有 session | Medium | 旧 session 里 tool_call name 是 `read_file` / `grep_files` 等,JSONL 仍能解析(extractFileOpsFromMessage switch 不命中跳过即可);下游 handler 用新 key 后会失效 — satellite 服务端已升级,不混跑 |
| 第三方 MCP server 也用 `read` / `write` 工具名 | Low | 多个 MCP server 暴露同名 tool 会被 prefix 区分(`satellite_read` / `hpc_read`); extractFileOpsFromMessage switch 看到 `satellite_read` 不命中(只匹配 `satellite_remote_exec` 聚合名),所以其他 MCP server 的同名 tool 不进 fileOps |
| Agent 用 `bash: cat` 3 次后硬拦截,LLM 困惑 | Low | 第 3 次的 reason 明确说"Use tool=read instead";LLM 必然能学会 |

## Testing Strategy

### Steer entry tests (`packages/agent/test/harness/`)
- **Unit**: `steer()` 触发 `before_agent_start` 钩子,`event.prompt === steer text`
- **Unit**: `steer()` 在无扩展监听时不抛错
- **Unit**: `steerQueue` 正常 push 消息
- **Unit**: in-flight LLM call 不被中断
- **Unit**: pending search 已存在时 steer 覆盖
- **Unit**: 5+ 次连续 steer 全部入队

### File tracking tests (`packages/agent/test/compaction/`)
- **Unit**: 本地 `grep` / `find` / `ls` 提取 `args.path` 到 `fileOps.read`
- **Unit**: 本地 `grep` 无 `path` 不抛错
- **Unit**: Satellite `remote_exec({tool: "grep"})` 提取到 `fileOps.read`
- **Unit**: Satellite `remote_exec({tool: "read"/"write"/"edit"/"bash"/"transfer_file"})` 不进 fileOps
- **Unit**: `read` / `write` / `edit` 现有逻辑不变(回归)

### Satellite schema tests (`extensions/satellite/test/`)
- **Unit**: z.enum 包含 `read` / `write` / `edit` / `list` / `find` / `grep` / `transfer_file`
- **Unit**: z.enum 不含 `read_file` / `write_file` / `edit_file` / `list_dir` / `find_files` / `grep_files`
- **Unit**: `TOOL_HANDLERS` key 与新名一致
- **Unit**: `createMcpServer` description 文本里子工具示例用新名

### Bash guardrail tests (`extensions/personal-assistant/test/`)
- **Unit**: 本地 `bash: cat` → suggest read
- **Unit**: 本地 `bash: ls` → suggest list
- **Unit**: 本地 `bash: find` → suggest find
- **Unit**: 本地 `bash: grep` → suggest grep
- **Unit**: 本地 `bash: sed -i` → suggest edit
- **Unit**: 本地 `bash: echo >` → suggest write
- **Unit**: 本地 `bash: ps aux | head` (pipeline) → 不拦截
- **Unit**: 本地 + Satellite budget 独立(同 turn 各自 2 次 guidance, 各自第 3 次硬拦截)
- **Regression**: 现有 `satellite-guards.test.ts` 全部 PASS (子工具改名同步)

### Coverage target: 80%+

## Implementation Notes

### 依赖关系 (DAG)
- **Task 1 (steer)** 不依赖 file tracking — 独立可并行
- **Task 2 (本地 fileOps)** 不依赖 satellite 改动 — 独立可并行
- **Task 3 (satellite schema 改名)** 是 Task 4 (satellite fileOps) 的前置 — 顺序
- **Task 4 (satellite fileOps)** 依赖 Task 3 — 顺序
- **Task 5 (read/write/edit 回归)** 依赖 Task 4 — 顺序
- **Task 6 (本地 guardrail)** 依赖 Task 3 (联动 BashIntent type) — 顺序

### 实施顺序 (按 DAG level)
- **Level 0** (3 parallel): Task 1.1 + Task 2.1 + Task 3.1 (3 个独立失败测试)
- **Level 1** (3 parallel): Task 1.2 + Task 2.2 + Task 3.2 (3 个独立实现)
- **Level 2** (2 parallel): Task 1.3 + Task 3.3 (BashIntent type 联动)
- **Level 3** (2 parallel): Task 1.4 + Task 4.1 (satellite fileOps 失败测试)
- **Level 4** (2 parallel): Task 1.5 + Task 4.2 (satellite fileOps 实现)
- **Level 5** (3 parallel): Task 1.6 + Task 5.1 + Task 6.1 (回归 + 本地 guardrail 失败测试)
- **Level 6** (1): Task 1.7 (steer 整体回归)
- (实际 Level 6 后还有 Task 6.2 + 6.3)

### 注意事项
- 两份 `compaction/utils.ts` 同步修改(运行时用 coding-agent 包,agent 副本是 mirror)
- `emitHook` 在 `steer()` 内调用需 `await` (确保 hook 链完成,跟 `executeTurn` 现有用法一致)
- `bashIntentBudget` key 加 `prefix` 字段,不能改老 key 格式(避免跟已发布版本状态不兼容)
- `checkBashIntentCommon` 是模块内函数,不导出(只给 `checkBashIntent` 和新本地钩子用)
- 现有 `validateSatelliteCall` 对外接口不变,只在内部用新 `checkBashIntentCommon`
- `transfer_file` 子工具名不动(参数不同,短化无收益)

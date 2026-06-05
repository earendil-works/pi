# Design: agent-loop-recall-and-file-tracking

## Context

Pi agent loop 的 TUI 使用流程存在两个用户可验证的体验问题：

1. **Steer 入口记忆盲区** — `agent-harness.ts:679-684` 的 `steer()` 方法只 `push` 消息到队列，**不触发** `before_agent_start` 钩子。`personal-assistant` 扩展的 `pendingMemorySearch` 机制依赖 `before_agent_start` 触发，steer 路径下记忆检索彻底失效。TUI 用户在第 5 轮 steer 切换到"cron 性能"话题时，agent 仍停留在 prompt() 入口的"重构项目"记忆上。

2. **File tracking 漏报** — `packages/agent/src/harness/compaction/utils.ts:24-51` 的 `extractFileOpsFromMessage` 只跟踪 `read`/`write`/`edit` 三个工具。`bash` 通过 `echo > file` / `mv` / `cp` / `rm` / `sed -i` 等改文件，但 `bash` tool call 完全不进 `<modified-files>` 列表。压缩后 summary 漏报 → 下次 LLM 误判文件状态。

两个问题都通过 4 轮代码校准验证触发场景为真。

## Goals / Non-Goals

**Goals**:
- `steer()` 触发 `before_agent_start` 钩子，记忆系统可见新消息
- bash 命令通过简单 regex 提取 6 类文件操作路径（`>` / `>>` / `tee` / `mv` / `cp` / `rm` / `sed -i`）
- grep / find / ls 从 `args.path` 提取搜索目录，加到 `fileOps.read`
- 边界 case 降级而非报错
- 不引入新依赖

**Non-Goals**:
- 不修改 `followUp()` / `nextTurn()` —— 不是 TUI 入口
- 不做 bash AST 解析 —— 用户明确选择简单 regex
- 不修改 compact 触发逻辑 / reserveTokens
- 不跨进程并发控制
- 不为"bash 改文件"做语义重写（直接用文件 IO 替代 bash）—— 那是另一个 change

## Decisions

### 1. Steer emit `before_agent_start` 而非 `context` 重检

**Decision**: 在 `steer()` 入口显式 `emitHook("before_agent_start", { prompt: steerText, ... })`。

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

### 3. bash path 提取: 简单 regex

**Decision**: 6 个 regex 模式,无 AST 解析。

**Rationale**: 用户明确选择"简单 regex"。覆盖 ~80% 真实 bash 改文件场景。代码 < 50 行,无依赖。漏网案例（for 循环、bash 函数）在 v2 改进。

**Alternatives considered**:
- shell-parse / tree-sitter-bash AST 解析 → 引入依赖,边缘 case 多
- 命令模式启发式（npm install → package.json）→ 模式库维护成本,收益边际

### 4. grep / find / ls: 提取 `args.path` 到 `fileOps.read`

**Decision**: 这些工具是"查询",不修改文件,只把搜索目录记为"被读"。

**Rationale**: 不解析 result 输出（避免 truncated 边界、JSON 格式、多行匹配等问题）。`args.path` 即搜索根目录,够用。

**Alternatives considered**:
- 解析 result 反向提取匹配文件 → 收益小（summary 里只列 `src/` 和"被搜了"即可），复杂

### 5. `fileOps.deleted` 新增 Set

**Decision**: bash `rm` 命令的目标路径加到 `fileOps.deleted` Set（新增字段），summary 里不展开（v1）。

**Rationale**: 现有 `FileOperations` 接口只有 `read`/`written`/`edited`，加 `deleted` 字段向后兼容（旧 summary 没这字段也能解析）。

**Alternatives considered**:
- 复用 `written` 集合（语义错）→ 用户看到 `<modified-files>` 里有被删的文件会困惑

## Architecture

```
agent-harness.ts (修改)
└── steer(text, options)
    └── emitHook("before_agent_start", { prompt: text, systemPrompt: this.systemPrompt, ... })
    └── this.steerQueue.push(createUserMessage(text, options?.images))
    └── await this.emitQueueUpdate()

harness/compaction/utils.ts (修改)
├── extractFileOpsFromMessage (扩展)
│   └── for each toolCall block:
│       ├── case "read" / "write" / "edit"  (现有逻辑)
│       ├── case "bash"  → extractBashPaths(args.command, fileOps)
│       ├── case "grep"  → fileOps.read.add(args.path ?? cwd)
│       ├── case "find"  → fileOps.read.add(args.path ?? cwd)
│       └── case "ls"    → fileOps.read.add(args.path ?? cwd)
├── extractBashPaths(command, fileOps) (新增)
│   ├── regex: />+\s*([^\s|&;]+)/g         → fileOps.written
│   ├── regex: /\bmv\s+\S+\s+([^\s]+)/g    → fileOps.written
│   ├── regex: /\bcp\s+\S+\s+([^\s]+)/g   → fileOps.written
│   ├── regex: /\btee\s+(?:-\w+\s+)?([^\s|&;]+)/g → fileOps.written
│   ├── regex: /\bsed\s+-i[^|;&]*\s+([^\s]+)/g    → fileOps.edited
│   └── regex: /\brm\s+(?:-r?\s+)?([^\s]+)/g       → fileOps.deleted
└── FileOperations interface (扩展)
    └── deleted?: Set<string>  (新增, optional)
```

**数据流 (steer)**:
```
用户按 Ctrl+S
  ↓
TUI 调用 session.steer("新话题")
  ↓
agent-harness.ts:679 steer() 方法
  ↓ emitHook("before_agent_start", { prompt: "新话题", ... })
  ↓ memory 扩展: pendingMemorySearch = searchMemory("新话题", ...)
  ↓
steerQueue.push(userMessage)
  ↓
emitQueueUpdate() 通知 UI
  ↓
(返回,steer 完成,不阻塞)
  ↓
runLoop 下次迭代处理 pending messages
  ↓
push steer 消息到 currentContext.messages
  ↓
transformContext → context 钩子
  ↓ pendingMemorySearch 存在,await → 拿到 atoms
  ↓ 把 memory 块 prepend 到 last user message (= steer 消息)
  ↓
LLM call 看到新主题记忆
```

**数据流 (bash file tracking)**:
```
agent 调用 bash({ command: "echo 'x' > src/config.ts" })
  ↓
executePreparedToolCall (现有)
  ↓
result 进 ToolResultMessage
  ↓
session 持久化 MessageEntry
  ↓
(数小时后) 触发压缩
  ↓
extractFileOperations() 调用
  ↓
extractFileOpsFromMessage 处理 assistant message
  ↓ 命中 case "bash"
  ↓ extractBashPaths("echo 'x' > src/config.ts", fileOps)
  ↓ regex 匹配到 "src/config.ts"
  ↓ fileOps.written.add("src/config.ts")
  ↓
computeFileLists() 把 written + edited 合并为 modifiedFiles
  ↓
summary += formatFileOperations(...)
  ↓
<modified-files>src/config.ts</modified-files> 出现在 summary
```

## Risks / Trade-offs

| Risk | Severity | Mitigation |
|------|----------|------------|
| Steer 频繁触发 `before_agent_start` 引入延迟 | Low | emitHook 不 await async handlers，memory 扩展的 search 是 fire-and-forget；steer 调用本身不阻塞 |
| Regex 误报（`echo "we > are here" > file`） | Low | v1 接受，误报文件路径会被 `<modified-files>` 列出，agent 看到会修正（最多浪费一个 turn） |
| Regex 漏报（for 循环改 10 个文件） | Low | 用户明确选择"80% 覆盖优先"；v1 TODO 注释里说明 |
| `fileOps.deleted` 新字段破坏旧 session 解析 | Low | optional 字段，序列化/反序列化兼容；summary 不展示删除文件（v1） |
| grep 输出 truncated 边界正则误判 | Low | 解析在 truncated 边界自然停止（result 末尾是 "Full output: ..." 文本，不含路径） |

## Testing Strategy

### Steer entry tests (`packages/agent/test/harness/`)
- **Unit**: `steer()` 触发 `before_agent_start` 钩子，event.prompt === steer text
- **Unit**: `steer()` 不 emit 钩子时（无扩展监听）不抛错
- **Unit**: `steerQueue` 正常 push 消息
- **Integration**: stub memory 扩展注册 `before_agent_start` handler → 验证 handler 被调用
- **Integration**: pending search 已存在时 steer 覆盖

### File tracking tests (`packages/agent/test/compaction/`)
- **Unit**: 6 个 bash regex 模式每个一个 test case
- **Unit**: bash 命令无匹配模式时 `fileOps` 不变
- **Unit**: grep/find/ls 提取 `args.path` 到 `fileOps.read`
- **Unit**: grep/find/ls `args.path` 缺省时不抛错
- **Unit**: read/write/edit 现有逻辑不变（回归）
- **Integration**: 跑一个含 `bash: echo > new.txt` 的 session，压缩后 summary 包含 `new.txt`

### Coverage target: 80%+

## Implementation Notes

### 依赖关系
- **steer 修改** 不依赖 file tracking — 独立 PR/commit
- **file tracking** 不依赖 steer — 独立 PR/commit
- 两个修改可在同一 change 内顺序实施

### 实施顺序
1. Steer 修改（agent-harness.ts:679-684, ~10 行）
2. file tracking 扩展（utils.ts:24-51, ~60 行 + tests）
3. 端到端集成测试

### 注意事项
- `emitHook` 在 `steer()` 内调用**不应 await** async handlers（emitHook 内部已经处理，但需要确认）
- 现有 `extractFileOpsFromMessage` 是同步函数，保持同步；bash regex 都是同步
- `FileOperations.deleted` 字段为可选，旧代码读不存在的字段返回 undefined，TypeScript strict mode 需用 `?.` / `??`
- 测试用 `packages/agent/test/compaction/file-tracking.test.ts` 新文件

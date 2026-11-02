# 项目结构说明（pi → 时序 agent 改造基线）

> 目的：把本仓库读清楚，作为「改造成时序 agent」的基线。
> 结论先行：**Pi 本体仍是通用 agent harness，`packages/` 核心没有改。** 时序编排在仓库根目录的 [`tsagent/`](../tsagent/README.md)：选择并调用 Google TimesFM 与 Amazon Chronos。模型 API 尚未接入，默认走 stub。
> 基线 commit：`3e0eec29f`（`docs(chord): chord.plugins is a package's manifest of plugins`）。
> 阅读顺序：§1 分层地图 → §2 请求链路 → §3 各包详解 → §4 扩展点 → §5 工程约束 → §6 时序 agent 的落点。

---

## 1. 分层地图

### 1.1 依赖方向（来自各包 `package.json` 的 `dependencies`，自下而上）

```
                    ┌─────────────────────────────────────────┐
   产品层 (L4)      │ packages/coding-agent  (CLI / TUI)       │
                    └───────┬───────────┬───────────┬─────────┘
                            │           │           │
   运行时层 (L2/L3)  ┌───────┴──────┐ ┌──┴────────┐ ┌┴───────────────┐
                    │ pi-agent-core│ │pi-codemode │ │ pi-mcp / pi-tui│
                    │  (agent loop)│ │ (JS 沙箱)  │ │                │
                    └───────┬──────┘ └──┬────────┘ └────────────────┘
                            │           │
   模型层 (L1)      ┌───────┴───────────┴──────┐
                    │        pi-ai             │  ← LLM 接入、模型目录、流式
                    └───────┬──────────────────┘
                            │
   基础设施 (L0)  ┌──┴────────┐   ┌──────────┐
                  │ pi-schema │   │pi-telemetry│
                  └───────────┘   └────────────┘

   持久化运行时 (L3)：pi-durable  ──依赖──▶ pi-ai, pi-chord, pi-codemode, pi-schema
                       pi-env      ──依赖──▶ pi-durable, pi-chord
   下一代运行时：     pi-chord/src/next（v2，切片式建设中）
```

一句话概括职责：

| 包 | npm 名 | 职责 | TS 文件数 |
|---|---|---|---|
| `packages/schema` | `pi-schema` | JSON Schema 校验（drafts 2020-12 与 7），编译成闭包，无 `eval` | 43 |
| `packages/telemetry` | `pi-telemetry` | 与厂商无关的遥测契约、参考适配器、一致性测试 | 8 |
| `packages/ai` | `pi-ai` | 统一 LLM API：多 provider、模型目录、鉴权、流式、工具、token 估算 | 205 |
| `packages/agent` | `pi-agent-core` | 最小 agent loop：消息 + 工具执行 + 事件流 + 一组钩子 | 6 |
| `packages/chord` | `chord` | 类型化 host runtime：契约、复制状态、热重载插件、JSON link 上的 RPC（v1 + v2 `src/next`） | 216 |
| `packages/codemode` | `pi-codemode` | QuickJS(WASM) 沙箱，模型写的 JS 唯一能力是调用注入的工具 | 17 |
| `packages/mcp` | `pi-mcp` | 独立 MCP 客户端（协议、传输、OAuth） | 18 |
| `packages/tui` | `pi-tui` | 终端 UI 库，差分渲染 | 46 |
| `packages/durable` | `pi-durable` | 持久化运行时：会话、compaction、任务、任务图、子 agent、文档、存储 | 97 |
| `packages/env` | `pi-env` | 远程执行环境：Rust 守护进程走 SSH，工具在远端跑 | 8 |
| `packages/coding-agent` | `pi-coding-agent` | CLI/TUI 产品层：read/bash/edit/write 工具、extensions、skills、MCP、会话 JSONL | 256 |
| `packages/evals` | `pi-evals` | 评测套件 | 5 |

### 1.2 各包的公开入口（`exports` 字段即成本契约）

`scripts/check-entry-graphs.mjs` 为每个入口设了「可达文件数」预算，例如：

- `packages/ai` 的 `./models` 最多 20 个文件，禁止触达 `providers/`；
- `packages/ai` 的 `./utils/*` 最多 3 个文件（`./utils/validation` 例外，42）；
- `packages/durable` 的 `.` 最多 123 个文件，`./tools` 最多 27；
- `packages/codemode` 的 `.` 最多 12，`./portable` 最多 8。

含义：**新增代码要放在对的位置，否则 `npm run check` 会因入口膨胀而失败**。这条对后面「时序能力放哪个包」的决策有直接约束。

---

## 2. 一次模型请求的完整链路

读懂这条链，就读懂了 Pi 的一半。

```
用户在 TUI 输入
   │
   ▼
coding-agent: AgentSession.appendMessage        packages/coding-agent/src/core/agent-session.ts:392
                        ↳ session-manager.ts:1215  → 写入 session JSONL 的一条 entry
   │
   ▼
agent: Agent.prompt()                       packages/agent/src/agent.ts:194
   │  追加消息到 state.messages，发 agent_start / turn_start / message_start|end
   ▼
agent-loop: runAgentLoop()                  packages/agent/src/agent-loop.ts:111
   │
   ├─► transformContext(messages)           packages/agent/src/types.ts:244   ← 上下文裁剪/注入的第一道
   ├─► convertToLlm(messages)               packages/agent/src/types.ts:222   ← 转成 LLM 认识的消息
   │      └─ TranscriptContext（system 消息 + tools 声明 + 历史消息）
   ▼
ai: models.streamSimple(model, context)     packages/ai/src/models.ts:1028
   │  选 provider → 鉴权（OAuth/API key/环境变量）→ 发起请求 → 流式解析
   ▼
AssistantMessageEventStream 事件回灌        assistantMessageEvent: text_delta / thinking_delta / toolCall
   │
   ▼
agent-loop 收尾：
   ├─ 无 tool call → turn_end → agent_end（若队列有 steering/follow-up 则继续下一轮）
   └─ 有 tool call → 并行/串行执行工具 → beforeToolCall / afterToolCall 钩子
                    → 产出 toolResult 消息 → turn_end → 下一轮
```

关键类型（都在 `packages/ai/src/types.ts`）：

| 类型 | 位置 | 作用 |
|---|---|---|
| `Message` = `System \| User \| Assistant \| ToolResult` | `packages/ai/src/types.ts:659` | LLM 能理解的四种消息 |
| `Tool` | `packages/ai/src/types.ts:771` | 工具定义（`parameters` 为 JSON Schema） |
| `Model<TApi>` | `packages/ai/src/types.ts:856` | 模型元数据（context window、thinking 级别、计价） |

`packages/agent` 在此之上加了 `AgentMessage`（= `Message` + 应用自定义消息，支持声明合并）与 `AgentEvent`（给 UI 的事件流）。

---

## 3. 各包详解

### 3.1 `packages/ai` — 统一 LLM API

- `src/models.ts:1028` `createModels()`：模型注册表。`models.setProvider(...)` / `models.getModel(provider, modelId)`。
- `src/providers/`：40+ 家 provider（53 个实现文件 + 42 份模型清单），含 `faux.ts`（测试用假 provider）、`all.ts`（全量）。
- `src/api/`：各家协议实现（anthropic-messages、openai-responses、bedrock-converse-stream、google-generative-ai、pi-messages 等）。
- `src/auth/`：OAuth 流、凭证存储、环境变量回退。
- `src/model-catalog.ts` / `src/models.generated.ts`：**模型目录是生成物**，改目录定义在 `packages/ai/catalog/`，不要直接改 generated 文件。
- `src/utils/estimate.ts:97` `estimateContextTokens()`：上下文 token 估算，compaction 与预算判断都依赖它。
- `src/utils/overflow.ts` / `retry.ts` / `abort.ts`：溢出、重试、取消。

### 3.2 `packages/agent` — 最小 agent loop（时序 agent 的主战场）

只有 6 个文件，但钩子齐全：

| 文件 | 作用 |
|---|---|
| `src/agent.ts:194` | `Agent` 类：状态、事件订阅、steering/follow-up 队列、abort、prompt/continue |
| `src/agent-loop.ts:111` | `runAgentLoop()`：单轮循环的真正实现（工具准备、并行/串行执行、事件发射） |
| `src/types.ts` | 所有配置项与钩子类型（551 行，全在这） |
| `src/proxy.ts` | 把 agent 挂到某对象上的代理层 |
| `src/stream-fn.ts` | 默认 stream 函数注册表 |

### 3.3 `packages/durable` — 持久化运行时（长程任务的地基）

- `src/harness/harness.ts` `Harness`：Session 的门面，`harness.open(storage, opts, context)`。
- `src/harness/agent.ts` / `generation.ts` / `prompt.ts`：会话、生成轮次、提交。
- `src/harness/compaction.ts`：上下文压缩。策略类型在 `src/harness/types.ts:566`（`CompactionPolicy`：`reserveTokens` 预留回答空间、`keepRecentTokens` 保留原文的近期大小、`backgroundTokens` 后台压缩阈值）与 `:578`（`CompactionSettings`：harness 级设置 + 按 `provider/modelId` 的 `modelOverrides`）。
- `src/harness/task-graph.ts` + `src/tasks.ts` `defineTask()`：任务定义与任务图（`pending/running/waiting/completing`）。
- `src/entries.ts`：条目类型（`pi.compaction` 等），条目只追加不改写，所以压缩前后按 entry id 读到的内容一致。
- `src/documents.ts` `defineDoc()`：类型化 JSON 文档，与条目同事务提交；`scope` 可为 conversation/session。
- `src/storage/`：`Memory` / `IndexedDB` / `SQLite`（含 Cloudflare DO）/ `JSONL` / `store`。
- `src/tools/`：read/write/edit/bash 等工具（durable 版）。
- `src/tool-search/`：按需加载工具，避免工具声明撑爆上下文。
- `src/env/`：`ExecutionEnv` 抽象（本地或远端）。

### 3.4 `packages/coding-agent` — CLI/TUI 产品层

- `src/cli/`：参数解析；`src/modes/`：`interactive`（TUI）、`rpc`（JSONL over stdin/stdout）、`print-mode.ts`、`json-event.ts`。
- `src/core/tools/index.ts:118` `createToolDefinition()` / `:213` `createAllTools()`：内置 read/bash/edit/write/ls/grep/find 的装配口。
- `src/core/extensions/`：extension 装载；`src/core/compaction/`：本层的压缩实现（可被 extension 覆盖）。
- `src/core/session-manager.ts`：会话树（entry 有父子关系，分支即从某 entry 续写）。
- `src/core/mcp-servers.ts`：MCP 服务器接入。
- `docs/`（42 篇）：`extensions.md`、`skills.md`、`mcp.md`、`compaction.md`、`sdk.md`、`rpc.md`、`how-pi-works.md`。

### 3.5 `packages/chord` — host runtime 与 v2 路线

- v1（`src/` 顶层）：`host.ts`、`cell.ts`、`cluster.ts`、`contract.ts`、`state.ts`、`link.ts`、`remote.ts`、`watch.ts`、`delta/` 等。
- v2（`src/next/`）：按垂直切片建设，路线图见 `docs/next/slices.md`（slice 1→13，含「Carry-over」段），设计规则见 `docs/next/design.md`（2626 行）。
- `src/next-node/`：Node 侧宿主（插件发现/构建、HTTP、worker）。

**对时序 agent 的意义**：v2 是长期架构目标，但仍在建设期。本轮不要把时序能力建在 `chord/src/next` 上——它一天一变。

### 3.6 `packages/codemode` — 沙箱 JS

模型写 JS 跑在 QuickJS(WASM) 里，唯一能力是调用注入的工具；嵌套工具调用不进 LLM 上下文，只有脚本输出进上下文。
适合表达「一次跑多个 TSFM、循环调用、聚合统计」这类编排逻辑——比让模型一轮轮发工具调用省 token。

### 3.7 `packages/env` — SSH 远程执行

Rust 守护进程 + stdin/stdout 帧协议；`RemoteExecutionEnv` 让工具在远端机器上跑，Durable worker 与凭证留在本地。
算力在本机 GPU 时用不上；将来推理上远程卡时它是现成通道。

### 3.8 其他

- `packages/mcp`：MCP 客户端（`transports/`、`protocol/`、`oauth/`）。TSFM 若是独立进程，也可走 MCP 暴露给 Pi。
- `packages/schema`：JSON Schema 校验器（替代 TypeBox 的 validator），工具参数校验与 `pi-schema` 的 `Static<T>` 类型推导都用它。
- `packages/telemetry`：遥测契约，供各包统一上报。
- `packages/tui`：终端组件库（`src/components/` 下 18 个组件）。
- `packages/evals`：评测套件。

---

## 4. 四个扩展点（时序 agent 的挂载位置）

这是本次改造真正要用的东西，全部**不需要改核心**。

| # | 扩展点 | 位置 | 能做什么 | 时序 agent 的用法 |
|---|---|---|---|---|
| 1 | `AgentTool` | `packages/agent/src/types.ts:478` | JSON Schema 参数 + `execute` 返回 `content`/`structuredContent`/`details` | 一次 TSFM 推理 = 一个 tool；`structuredContent` 放预测数组等结构化结果 |
| 2 | `transformContext` | `packages/agent/src/types.ts:244` | 每次请求前改写消息列表 | 上下文管理：注入序列状态摘要、裁剪旧轨迹、挂载工件引用 |
| 3 | `convertToLlm` | `packages/agent/src/types.ts:222` | AgentMessage → LLM Message | 把「数值工件」渲染成模型可读的少量文本，把明细留在外部 |
| 4 | 调度钩子 | `packages/agent/src/types.ts:155`（`FinishTurn`）、`:186`（`PrepareRequest`）、`:293`（steering）、`:306`（follow-up）、`:326`/`:341`（tool 前后钩子） | 换模型、换上下文、注入外部事件、拦截工具 | 长程多步决策：每步结束评估是否重规划、注入定时器事件、拦截危险工具 |

配合 durable：

| 能力 | 位置 | 长程多步决策中的作用 |
|---|---|---|
| Compaction 策略 | `packages/durable/src/harness/types.ts:566`（`CompactionPolicy`）、`:578`（`CompactionSettings`） | 自定义压缩：确定性状态块 + LLM 叙述，避免数值被摘要压坏 |
| 任务与任务图 | `packages/durable/src/tasks.ts`、`src/harness/task-graph.ts` | episode 层计划拆成 step 层任务，`waiting` 依赖编排 |
| 子 agent | durable README「Abort and Subagents」 | 把「独立子问题」（如单变量归因）隔离到子会话 |
| 文档 | `packages/durable/src/documents.ts` | 存 checkpoint（计划、已完成步、序列状态），崩溃后可恢复 |

---

## 5. 工程约束（动手前必须知道）

来自 `AGENTS.md` 与 `scripts/`：

1. **只写 erasable TypeScript**：禁 `enum`、`namespace`、`import =`、参数属性（在 `packages/*/src` 范围）。
2. **顶层 import**，禁止 `await import()` / 动态类型导入。
3. **不用 `any`**（除非无路可走），不用 `__dirname`（`packages/coding-agent` 走 `src/config.ts` 的资源解析）。
4. **`npm run check` 必须干净**：biome + 依赖钉死检查 + ts-imports 检查 + **entry graph 预算** + tsc + browser smoke。它不跑测试。
5. **测试**：`./test.sh`（根目录，非 e2e 全量）；单文件用 `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/xxx.test.ts`；`packages/tui` 用 `node --test`。
6. **构建**：`npm run build` 只在需要 `dist/` 时跑（测试导入构建产物、Durable 的 workerd 套件）；类型检查用 `npm run check`。
7. **不擅自提交**；提交只 stage 自己的文件；`packages/ai/src/models.generated.ts` 可随行。
8. **Changelog**：`packages/*/CHANGELOG.md` 的 `## [Unreleased]` 下追加。
9. **包依赖**：直接依赖（含内部 workspace 依赖）钉死精确版本；`npm install --ignore-scripts`。
10. **Chord v2 代码风格**（若动 `packages/chord/src/next/`）：一文件一概念、导出函数带单行文档注释、tagged union、WeakMap 缓存配 GC 测试、每个切片补 `test/next/examples/NN-topic.ts`。

---

## 6. 时序 agent 的落点

编排器在 `tsagent/`，不在 npm workspace `packages/` 里，因此不碰 entry graph，也不改 Pi 的 LLM 目录。conda 环境 `pi-time` 同时有 Python 3.11 和 Node.js 22.23：前者跑 `tsagent`，后者留给原来的 harness。

一次任务的步骤是固定的：读 CSV 或内存序列 → 画像 → 选模 → 执行 → 可选回测 → 建议。入口是 `TimeSeriesAgent.run` 和 `python -m tsagent`。

- **选模**：`auto` 在每个还能用的家族里留一个模型，所以无协变量时同时有 TimesFM 和 Chronos。协变量是硬约束，目前只有 `amazon/chronos-2` 能接。指定 id 或 `all` 可以改这个范围。
- **执行**：`GoogleTimesFMBackend` 和 `AmazonChronosBackend` 默认 `unavailable`。`fallback=stub` 时用同一请求契约跑确定性预测；`fallback=strict` 不编造数值。步长超过模型单次上限就滚动拼接。
- **建议**：只有 `execution=native` 的回测 MAE 才会选出模型。全是 stub 时 `recommendation.basis` 为 `stub`。
- **接入 API**：子类化上述 backend 并实现 `_invoke`。调用形状写在两个模块的文档字符串里。覆盖 `_invoke` 之后 registry 自动改走原生 backend。

Pi 侧的使用说明在 `.pi/skills/tsfm-orchestrate/SKILL.md`。长程多步决策如果以后要进 LLM 循环，仍应挂到 §4 的 `AgentTool`，工具内部调用现在的 `TimeSeriesAgent`，而不是把数值轨迹塞进上下文。

明确没做的事：

- 不改 `packages/` 核心，也不改 `packages/chord/src/next/`；
- 不把 TimesFM / Chronos 加进 `packages/ai` 的 LLM provider 目录；
- 不在 stub 里导入 `timesfm` 或 `chronos`。

---

## 附：常用命令

```bash
npm run check                     # 类型 + lint + 依赖钉死 + entry graph 预算（改代码后必跑）
npm run build                     # 需要 dist/ 时
./test.sh                         # 根目录跑非 e2e 测试
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/x.test.ts
npm run generate:models           # 改 packages/ai/catalog/ 后重新生成模型目录
```

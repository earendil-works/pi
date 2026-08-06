# 安卓本地 Agent 角色扮演应用（酒馆替代）— 项目介绍与二开计划

> 基于 `earendil-works/pi`（⭐84k，MIT）二次开发
> 目标：安卓本地运行的 agent 式角色扮演应用，替代 SillyTavern（酒馆）静态角色卡方案
> 修订版 v2：App 壳改为原生 Kotlin + Jetpack Compose，运行时改为 Node 官方 android-arm64 构建，自写薄 RP 服务而非复用 CLI 的 `--mode rpc`

---

## 一、项目介绍

### 1.1 为什么做这个

酒馆（SillyTavern）的角色卡本质是**静态脚本**：人格设定、世界书、正则都是"开演前写好的剧本"，角色不会主动查资料、不会根据局势调整策略、记忆全靠塞上下文。

用户已用 Hermes Agent 实测验证：**agent 式角色扮演（agent loop 动态调整 + 工具调用信息获取）效果远超静态角色卡**。本项目把这种 agent 体验搬到安卓本地。

### 1.2 核心卖点

- **agent 式动态调整**：agent loop 让角色能评估局势 → 决定行动 → 执行 → 根据结果修正，是"活的"
- **信息获取能力**：工具调用 = 角色的"感官"。角色可以"查手机"（搜索）、"回忆"（记忆检索）、"思考"（推理链）
- **安卓本地运行**：不依赖任何服务器，编排逻辑跑在手机本地，LLM 推理走用户自配的云端 API
- **本地 API 配置**：App 内设置 base_url + API key + 模型（OpenAI 兼容，可接 one-api 或任意厂商）
- **角色卡兼容**：支持导入 SillyTavern V2 角色卡（JSON 或 PNG 嵌入）

### 1.3 运行时选型对比（为什么选 pi 而不是 Hermes）

| 维度 | Hermes | pi（选定） |
|---|---|---|
| 运行时 | CPython + site-packages | Node（官方 android-arm64 构建，Node 22+） |
| APK 估算 | 150MB+（含桌面架构，裁剪麻烦） | 100MB+（Node 二进制 brotli 后 ~30MB + 依赖裁剪） |
| App 化架构 | 无现成 server/client 分层 | agent loop 独立函数可脱离 CLI 直接驱动 |
| 依赖体量 | 重 | 339 packages（实测 1 分钟装完） |
| 扩展方式 | Python 桌面代码裁剪 | 注入式扩展点，不动核心循环 |

**Termux 方案已否决**：Android Doze/后台限制会暂停 Termux 进程，无解。

### 1.4 App 壳选型：原生 Kotlin，为什么不用 Capacitor + WebView

| 维度 | Capacitor + Vue/React | 原生 Kotlin + Compose（选定） |
|---|---|---|
| 桥接层数 | 三层：WebView JS → 插件 → Node | 一层：Kotlin → Node |
| Node 集成 | 不可避免的 native 活，照样要写 Kotlin/Java 插件 | 直接写进主工程，省一层框架 |
| RP 聊天 UI | 生态丰富但有学习成本 | Compose 可界定，气泡/流式/设置页/卡片导入 |
| 保活/进程/加密 | 插件化，间接 | 前台服务、ProcessBuilder、Keystore 原生顺手 |
| 个人熟悉度 | 弱 | 强（决定单人二开效率） |

> 结论：Node 集成是绕不开的 native 工作，两种方案都躲不掉；Kotlin 原生省掉 Capacitor 插件层，代价是 UI 手写——而聊天 UI 是可界定的小工作量，且用户更熟 Kotlin。选 Kotlin 原生。

---

## 二、技术架构

### 2.1 整体架构

```
┌────────────────────────── 安卓手机 ──────────────────────────┐
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Kotlin App (Jetpack Compose)                       │    │
│  │  ├─ 聊天 UI（流式输出、消息气泡、"角色思考中"动画）   │    │
│  │  ├─ 角色卡导入（PNG/JSON 解析）                      │    │
│  │  ├─ API 设置页（base_url / key / model，Keystore 加密）│    │
│  │  ├─ 会话持久化（Room / JSON）                        │    │
│  │  └─ IPC Client ───────────────┐                     │    │
│  │     (ProcessBuilder + 管道)   │                     │    │
│  └───────────────────────────────┼─────────────────────┘    │
│                                  │ stdio JSONL (本地 IPC)    │
│  ┌───────────────────────────────┼─────────────────────┐    │
│  │  Node 22 android-arm64（assets 内 brotli 压缩，     │    │
│  │  首启解压到 files 目录，ProcessBuilder 拉起）        │    │
│  │  rp-server.mjs（自写薄服务，packages/rp-server/）   │    │
│  │  ├─ packages/agent：runAgentLoop 独立驱动           │    │
│  │  ├─ packages/ai：LLM 客户端（openai-completions）   │    │
│  │  ├─ 角色卡层（自研）：人格锚 systemPrompt           │    │
│  │  ├─ 记忆系统（自研）：node:sqlite / JSON            │    │
│  │  ├─ RP 工具集（自研）：记忆检索/知识查询             │    │
│  │  └─ 精简版 compaction（移植自 coding-agent 逻辑）    │    │
│  └─────────────────────────────────────────────────────┘    │
│  Android Foreground Service 保活（通知常驻，防进程被杀）      │
└──────────────────────────────────────────────────────────────┘
          │
          ▼  HTTPS（用户自配的 OpenAI 兼容端点）
   one-api / DeepSeek / 任意厂商 / 本地模型网关
```

### 2.2 数据流

```
用户消息 → App UI → IPC Client → rp-server
  → runAgentLoop（systemPrompt=人格锚 + 记忆注入 + 对话历史）
  → LLM 调用（streamSimple，openai-completions 端点）
  → 工具调用（memory_search/knowledge_query）→ 叙事转译 → 结果回注
  → 最终 assistant 回复（流式 text_delta 事件）→ IPC → App UI 渲染
```

### 2.3 pi 关键包结构（monorepo，实际用途）

| 包 | 作用 | 本项目用途 |
|---|---|---|
| `packages/agent` | agent loop 核心（`runAgentLoop` / `agent-loop.ts`） | 保留，直接驱动（不用 coding-agent CLI） |
| `packages/ai` | LLM 客户端（providers + api + compat） | 保留，`createProvider` + `openai-completions` 接任意端点 |
| `packages/session-backends` | 会话持久化后端（`sqlite-node` 用内置 `node:sqlite`） | 可选，记忆系统参考 |
| `packages/coding-agent` | CLI 主体 | **不打包进 APK**，仅参考其 compaction/胶水实现 |
| `packages/server` / `client` / `protocol` | 实验性 unix-socket CBOR 远程会话框架 | **不用**（未接 main，且传输非项目所需） |
| `packages/tui` | Ink 终端 UI | **不需要**，剥离 |

**关键认知修正**：
- `--mode rpc` 的传输是 **stdio JSONL**，不是 TCP/127.0.0.1。`packages/server/client/protocol` 是另一套实验性 unix-socket + CBOR 框架，**未接入 main**，不是 App 通信的现成层。
- `packages/agent` 的 `AgentHarness` 是 stub（`prompt()/compact()/steer()` 均抛 `HarnessNotImplemented`），不可作实现参考；真正可驱动的是 `runAgentLoop` / `agentLoop` 独立函数。
- `AgentContext.systemPrompt` 是纯 string（`agent.ts:75`），无函数式；人格锚在 JS 侧拼好字符串直接赋值即可。
- `setDefaultStreamFn`（`packages/agent/src/stream-fn.ts`）可注册默认 streamFn；实际按 coding-agent `sdk.ts:302` 的写法用 `getApiProvider(model.api).streamSimple(model, context, options)`。

---

## 三、已验证的扩展点（二开地图）

> 全部为注入/替换式扩展，**不需要修改 agent 核心循环**，pi 升级时可合并。

| # | 扩展点 | 位置 | 用途 |
|---|---|---|---|
| 1 | `AgentContext.systemPrompt` 赋值 | `packages/agent/src/agent.ts:75`；`agent-loop.ts:298-302` 注入 LLM | 角色卡 → 人格锚（string 直拼） |
| 2 | `AgentState.tools` 动态赋值 | `packages/agent/src/types.ts:335` | 工具裁剪/替换 |
| 3 | `AgentTool extends Tool` | `types.ts:380`（label / prepareArguments / execute） | 自定义 RP 工具 |
| 4 | `beforeToolCall` / `afterToolCall` 钩子 | `agent-loop.ts:619,720`；`types.ts:271,286` | 工具调用拦截、叙事转译控制 |
| 5 | `thinkingLevel` | `types.ts:294,333` | 思考级别控制（沉浸感） |
| 6 | `createProvider` + `openai-completions` | `packages/ai/src/models.ts:762`；`api/openai-completions.ts`；`compat.ts` 注册 | 本地 API 配置（OpenAI 兼容） |
| 7 | `runAgentLoop` 独立驱动 | `packages/agent/src/agent-loop.ts:95` | rp-server 的核心，事件 sink 自行接管 |

**工具裁剪**：内置工具全部是工厂函数，位于 `packages/agent/src/harness/tools/`（bash.ts / edit.ts / read.ts / write.ts；edit-diff.ts / image.ts 是 helper 不是工厂）。**不注册 = 不加载**，无需删代码。bash/edit/read/write 均不注册（RP 不需要，且 bash 依赖 child_process）。

---

## 四、需要补的四块（核心开发任务）

### 补块 1：裁剪工具集（对应 todo t5）

- 不注册 coding 工具（bash/edit/read/write/image）
- 注册 RP 工具（实现 `AgentTool` 接口）：
  - `memory_search(query)` — 角色记忆检索
  - `knowledge_query(topic)` — 知识查询（调外部搜索 API 或让 LLM 自答）
  - 可选：`get_time` / `get_weather` 等感知类工具
- 工具结果格式需符合叙事转译规范（见补块 4）

### 补块 2：角色卡层（t6）

- 解析 SillyTavern V2 角色卡：
  - JSON 文件：直接解析
  - PNG 嵌入：读取 PNG tEXt chunk 的 `chara` 字段（base64 JSON）
- 提取字段：`name` / `description` / `personality` / `scenario` / `first_mes` / `mes_example` / `system_prompt` / `post_history_instructions`
- 生成人格锚 systemPrompt = description + personality + scenario + RP 规则（思考隐藏、叙事转译规范、工具行为约束）
- `first_mes` 作为开场白，`mes_example` 作为 few-shot 示例注入

### 补块 3：记忆系统（t7）

- pi 无长期记忆（只有会话存储），需自研
- 设计：node:sqlite（官方 Node 22 内置，无原生模块编译问题；`session-backends/sqlite-node` 已验证）或先上 JSON 文件
  - 角色档案：事实列表（用户偏好、剧情进展）
  - 对话摘要：每 N 轮自动摘要历史
- 接入点：
  - systemPrompt 组装时注入档案/摘要
  - `memory_search` 工具供角色主动"回忆"
- 初期用 JSON + 关键词检索跑通，再平滑迁到 node:sqlite

### 补块 4：叙事转译（t8）

- **核心规则**：工具结果 = 角色的内部感知，不得直接复述；模型必须用角色口吻自然表达
- 实现方式：
  - systemPrompt 中明确规定转译规则（"工具结果是你看到/查到的信息，不要复述原始数据，用你的口吻表达"）
  - `beforeToolCall` 钩子控制工具可见性/拦截
  - `thinkingLevel` 调低或隐藏思考（UI 不渲染思考/工具事件，只渲染最终回复）
- rp-server 事件流：只向 App 转发 `message_start` / `message_update`（text_delta）/ `message_end`；工具/思考事件映射为"角色思考中…"状态

---

## 五、实施计划

### 阶段 0：开发环境准备（开发机本地，与部署服务器无关）

- 本仓库即 pi fork（Kumos），已就绪
- Node.js >= 22.19（推荐 24 LTS，用 nvm 或官方安装包安装）
- 安装依赖：`npm install --ignore-scripts`（约 339 packages，1 分钟）
- 验证环境：`npm run build` 或 `./test.sh`

### 阶段 1：RP 核心开发（开发机 Node，不碰安卓，t5-t9）

> 先验证逻辑再打包。测试可用 `packages/ai/src/providers/faux.ts`（假 provider）或真实 API。

1. **t5** rp-server 骨架：新建 `packages/rp-server/`，接线 `runAgentLoop`（streamFn = `getApiProvider(model.api).streamSimple`）、`convertToLlm` 恒等、JSONL-over-stdio 协议、faux provider 冒烟
2. **t6** 角色卡解析器：V2 解析 + 人格锚生成
3. **t7** 记忆系统：node:sqlite/JSON 存储 + systemPrompt 注入 + memory_search 工具
4. **t8** 叙事转译：工具结果规范 + thinkingLevel + 事件过滤（只转 text_delta）
5. **t9** 集成验证：用真实角色卡跑通 agent RP 对话（重点验证：动态调整 + 信息获取 + 不出戏）

### 阶段 2：安卓打包（t10-t11）

6. **t10** 运行时方案：
   - **Node 官方 android-arm64 构建（Node 22+）**，brotli 压缩进 APK assets，首启解压到 files 目录，ProcessBuilder 拉起（设执行权限）
   - 验证点：rp-server 在目标运行时能启动并响应 JSONL
   - 仿真器需同时带 x86_64 构建
7. **t11** Kotlin App（`android/` Gradle 工程）：
   - Compose 聊天 UI（流式渲染、消息气泡、"角色思考中"动画）
   - 本地 API 设置页（Keystore 加密存储 key）
   - 角色卡导入（PNG/JSON）
   - 会话持久化（Room / JSON）
   - IPC 客户端（ProcessBuilder + 协程管道读写 JSONL）
   - Android Foreground Service 保活（解决 Termux 被杀的痛点）

### 阶段 3：真机验证优化（t12-t13）

8. **t12** 真机测试：RP 体验、后台行为、内存/耗电占用
9. **t13** APK 体积优化：node_modules tree-shake（只留 ai/agent + openai-completions + 必要 provider）、剔除无用 models catalog

---

## 六、注意事项与风险

### pi 开发规则（AGENTS.md 要点）
- 依赖安装用 `npm install --ignore-scripts`；不要跑生命周期脚本
- 测试用 `./test.sh`（从仓库根），不要跑完整 vitest（含 e2e）
- 不要 `git add -A`；只暂存自己改的文件；不 commit 除非用户要求
- 不要动 `packages/ai/src/models.generated.ts`（改 `scripts/generate-models.ts` 再生成）

### 风险与对策

| 风险 | 对策 |
|---|---|
| agent loop 思考泄漏出戏 | thinkingLevel 控制 + 事件过滤 + systemPrompt 规则 |
| 人设漂移（动态过头） | 人格锚硬约束（静态）+ 策略动态（工具/调整），动态是手段静态是人格 |
| 工具裁剪后信息获取弱 | knowledge_query 工具走外部搜索 API 或 LLM 自答 |
| Node 二进制体积大（~70MB，brotli ~30MB） | assets brotli 压缩 + 首启解压 + 依赖 tree-shake；预计 APK 100MB+，可接受 |
| NodeJS-mobile 与 Node 22+ 需求冲突 | 已弃用 NodeJS-mobile（停留在 Node 16/18），选官方 android-arm64 构建 |
| 精简版 compaction 自研 | 移植 coding-agent `compaction.ts` 摘要逻辑（~100 行），复用阈值/保留策略 |
| 流式管道健壮性 | JSONL 行缓冲 + 容错读取；Kotlin 协程读写 |
| 手机内存 | 会话数据用本地文件，长对话靠摘要压缩（精简版 compaction） |
| coding-agent 的 bash/grep/find 工具依赖 child_process | 不打包 coding-agent，rp-server 只用 agent/ai 包，天然规避 |

---

## 七、关键文件索引

```
packages/agent/src/agent-loop.ts      # runAgentLoop 独立驱动（rp-server 核心）
packages/agent/src/agent.ts           # Agent 类 / AgentContext.systemPrompt 注入点
packages/agent/src/types.ts           # AgentTool/AgentLoopConfig/beforeToolCall/thinkingLevel
packages/agent/src/stream-fn.ts       # setDefaultStreamFn
packages/agent/src/harness/tools/     # 内置工具工厂（裁剪对象；bash 依赖 child_process 不注册）
packages/ai/src/api/openai-completions.ts # OpenAI 兼容端点（baseUrl+apiKey+fetch）
packages/ai/src/compat.ts             # getApiProvider / registerApiProvider
packages/ai/src/models.ts             # createProvider
packages/ai/src/providers/faux.ts     # 测试用假 provider
packages/coding-agent/src/core/sdk.ts # streamFn 接线参考（sdk.ts:302）
packages/coding-agent/src/core/compaction/ # 精简版 compaction 移植来源
packages/session-backends/sqlite-node # node:sqlite 后端参考（零原生依赖）
```

> 注：以上均为本仓库（pi fork）根目录下的相对路径。`packages/rp-server/`（新包）与 `android/`（Gradle 工程）为本项目新增。本计划不依赖任何特定服务器，全部在开发机本地执行。

**建议开发顺序**：t5 → t6 → t8 → t7 → t9（先验证核心体验，记忆系统最后接）；阶段 2 的运行时 smoke test（t10）可提前与 t5 并行，尽早暴露 Node android-arm64 兼容性问题。

---

## 八、相对 v1 计划的修订记录

| 项 | v1 计划 | v2 修订 |
|---|---|---|
| App 壳 | Capacitor + Vue/React WebView | 原生 Kotlin + Jetpack Compose |
| Node 运行时 | NodeJS-mobile 首选 / 官方 android-arm64 备选 | 官方 android-arm64 构建（Node 22+，因仓库要求 Node>=22.19，NodeJS-mobile 不兼容） |
| Node 服务 | 复用 coding-agent `--mode rpc` | 自写薄服务 `packages/rp-server/`（agent loop 独立驱动） |
| RPC 传输 | 图注"本地 IPC (127.0.0.1)" | stdio JSONL（ProcessBuilder + 管道） |
| systemPrompt 注入 | 引 harness 函数式 | string 直拼（agent.ts:75 仅 string） |
| server/client/protocol 包 | 列为 App 通信现成层 | 明确不用（实验性、未接 main） |
| 记忆存储 | 纯 JS 规避 SQLite | node:sqlite（官方 Node 22 内置，无编译问题） |

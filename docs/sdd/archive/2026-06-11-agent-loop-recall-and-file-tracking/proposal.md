# 变更提案: agent-loop-recall-and-file-tracking

## 动机

Pi agent loop 在 TUI 使用场景下存在两个真实可验证的问题，影响用户对会话连续性和状态追踪的体验：

1. **Steer 入口不触发记忆召回** — TUI 用户在 agent 跑任务时用 `/steer` 插嘴换话题（这是真实高频操作），但 `agent-harness.ts:679-684` 的 `steer()` 只把消息 push 到 `steerQueue`，**不触发 `before_agent_start`**。`personal-assistant` 记忆扩展的 `pendingMemorySearch` 机制在 steer 路径上完全失效。后果：用户以为"agent 记得我"，但 agent 实际上仍在用 prompt() 入口那次检索出来的"开场快照"记忆。中间换话题后，注入的记忆和当前任务可能完全无关。

2. **File operation 跟踪漏 bash/grep/find/ls** — `packages/agent/src/harness/compaction/utils.ts:24-51` 的 `extractFileOpsFromMessage` 只跟踪 `read`/`write`/`edit` 三个工具。bash 命令实际可以改文件（`echo > file` / `mv` / `cp` / `npm install` 修改 package.json / `sed -i` 等），但 `bash` tool call 完全不进 `<modified-files>` 列表。后果：压缩后的 summary 漏报文件改动，**下次 LLM 看到 summary 可能误判文件状态**（如以为 `src/utils/new.ts` 没被动过）。

两个问题都经过 4 轮深度代码校准和用户确认触发场景。

## 影响范围

- 修改 Capability: `agent-harness-steering` — `steer()` 触发 `before_agent_start` 让扩展钩子系统能感知新消息
- 修改 Capability: `compaction-file-tracking` — `extractFileOpsFromMessage` 扩展到 7 个工具（新增 bash/grep/find/ls）

## 非目标

- 不修改 `followUp()` / `nextTurn()` —— 这两个不是 TUI 可见入口
- 不修改 compact 触发逻辑（threshold / 16K reserve）—— 独立 change
- 不实现 bash 完整 AST 解析 —— 只做简单 regex 模式
- 不修改 `before_agent_start` 在 prompt() 入口的现有行为
- 不添加新的 memory tool —— 维持被动注入范式
- 不跨进程并发控制 —— 假设单 session 单进程

## 验收标准

### A. Steer 入口

1. **触发召回** — 用户在 agent 跑任务时调用 `session.steer("看下 cron 性能问题")`，memory 扩展的 `pendingMemorySearch` 被设置，**使用 steer 文本作为 query**
2. **注入位置正确** — 检索结果被 prepend 到 steer 消息（不是上一条 user 消息）前面
3. **不破坏原 turn** — steer 不影响当前 in-flight 的 LLM call，只对 steer 触发后的下一个 LLM call 生效
4. **不重复搜索** — 如果 `pendingMemorySearch` 已有未消费的结果，steer 触发的新 `before_agent_start` 覆盖它，旧 promise 静默丢弃
5. **失败降级** — memory 扩展未启用时，steer 正常工作不报错

### B. File tracking 扩展

1. **bash 覆盖** — 6 个 regex 模式命中时提取文件路径：
   - `>` / `>>` 重定向（合并为一条 `/>+/g` regex）
   - `mv` / `cp` 第二个参数
   - `tee` / `sed -i` 目标
   - `rm` 删除
2. **grep/find/ls 覆盖** — 从 result 内容 regex 解析文件路径，加到 `fileOps.read`
3. **summary 正确显示** — 跑一个含 `bash: echo "x" > new.txt` 的 session，压缩后 summary 的 `<modified-files>` 包含 `new.txt`
4. **不影响 read/write/edit** — 已有 3 个工具的跟踪逻辑不变
5. **空结果降级** — bash 命令不包含已知模式时，`fileOps` 不变（不报错）
6. **错误参数降级** — grep 输出不含 `path:line:content` 格式时，跳过该条（不抛错）

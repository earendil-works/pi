# 使用场景

## 正常流程

### Scenario: Steer 触发新主题记忆召回
- **GIVEN** 用户在 prompt() 入口已用 `prompt("重构 pi 项目的 auth 模块")`，agent 跑了 3 轮后用户在 TUI 按 Ctrl+S 输入 steer
- **WHEN** 用户输入 `steer("顺便看下 cron 模块的性能问题")`
- **THEN** `before_agent_start` 钩子被 emit（event.prompt = "顺便看下 cron 模块的性能问题"），memory 扩展启动 `searchMemory`；检索结果在下一个 LLM call 的 `context` 事件中被 consume，prepend 到 steer 消息前面；UI status 显示 `mem: <model> searching` 然后 `mem: <model> 3 found`

### Scenario: Steer 不影响 in-flight LLM call
- **GIVEN** agent 正在执行一个 LLM call（streaming 中），用户在 TUI 输入 steer
- **WHEN** `steer()` 方法被调用
- **THEN** 当前 streaming LLM call 不被中断；steer 消息被 push 到 `steerQueue`；新触发的 `before_agent_start` 设置 `pendingMemorySearch`；当前 LLM call 完成后，runLoop 处理 pending messages（steer 消息），进入下一轮 LLM call，memory 在那一轮被注入

### Scenario: Bash echo 重定向被跟踪
- **GIVEN** agent 调用 `bash({ command: "echo 'export const X = 1' > src/config.ts" })`
- **WHEN** `extractFileOpsFromMessage` 处理这条 tool call
- **THEN** `src/config.ts` 被加到 `fileOps.written`；压缩后 summary 的 `<modified-files>` 包含 `src/config.ts`

### Scenario: Bash mv 命令被跟踪
- **GIVEN** agent 调用 `bash({ command: "mv src/old.ts src/new.ts" })`
- **WHEN** `extractFileOpsFromMessage` 处理这条 tool call
- **THEN** `src/new.ts` 被加到 `fileOps.written`，`src/old.ts` 被加到需要删除跟踪（v1 加 `fileOps.deleted` Set）；`src/new.ts` 出现在 summary 的 `<modified-files>`

### Scenario: Grep 输出被解析
- **GIVEN** agent 调用 `grep({ pattern: "TODO", path: "src" })`，result 内容包含 `src/foo.ts:42: // TODO: ...`
- **WHEN** `extractFileOpsFromMessage` 处理这条 tool call
- **THEN** regex 提取 `src/foo.ts`，加到 `fileOps.read`；压缩后 summary 的 `<read-files>` 包含 `src/foo.ts`

## 异常流程

### Scenario: Steer 在 memory 扩展未启用时正常工作
- **GIVEN** 用户配置 `personalAssistant.memory.enabled = false`（或未安装 personal-assistant 扩展）
- **WHEN** 用户调用 `steer("新消息")`
- **THEN** `before_agent_start` 钩子 emit 后无 handler 响应；`steerQueue.push` 正常；agent 后续 turn 正常处理 steer 消息；**不抛错**

### Scenario: Bash 命令无可识别模式
- **GIVEN** agent 调用 `bash({ command: "ls -la | head -20" })`（没有 `>` / `mv` / `cp` 等）
- **WHEN** `extractFileOpsFromMessage` 处理这条 tool call
- **THEN** 所有 regex 不匹配，`fileOps` 不变；不抛错

### Scenario: Bash 重定向路径含特殊字符
- **GIVEN** agent 调用 `bash({ command: "echo 'x' > /tmp/test file.txt" })`（含空格的文件名）
- **WHEN** regex 尝试匹配
- **THEN** v1 简单 regex 只取第一个空格分隔的 token，得到 `/tmp/test`（不完美但不报错）；记录在 TODO 注释里，v2 改进

### Scenario: Grep 输出格式异常
- **GIVEN** grep 调用失败或 result 内容是错误信息（不含 `path:line:content`）
- **WHEN** `extractFileOpsFromMessage` 处理这条 tool call
- **THEN** regex 不匹配，`fileOps` 不变；不抛错

### Scenario: 之前 pendingMemorySearch 未消费，steer 覆盖
- **GIVEN** prompt() 触发的搜索 promise 还没完成（还在网络请求中），此时用户 steer
- **WHEN** steer 触发新的 `before_agent_start`，设置新 `pendingMemorySearch`
- **THEN** 旧 promise 引用被覆盖（GC 后静默 resolve 但结果被丢弃）；新 promise 完成后被下一个 `context` 事件消费；steer 消息前面 prepend 的是**新搜索结果**

## 边界条件

### Scenario: Bash 输出在 `>` 后是变量而非字面路径
- **GIVEN** `bash({ command: "echo $CONTENT > $OUTPUT_FILE" })`
- **WHEN** regex 匹配
- **THEN** v1 regex 取到 `$OUTPUT_FILE` 字面字符串，加到 `fileOps.written`（不完美，路径无效但不报错）；v2 TODO 改进——检测 `$VAR` 跳过

### Scenario: 第一次 `before_agent_start` 还未消费，steer 立即再次
- **GIVEN** 用户在 100ms 内连续两次 steer（罕见但可能）
- **WHEN** 两次 steer 都 emit `before_agent_start`
- **THEN** `pendingMemorySearch` 总是被最新值覆盖；最终 memory 反映最后一次 steer 的主题

### Scenario: Steer 队列有 5+ 条消息
- **GIVEN** 用户在 agent 跑任务时连续 steer 5 次（agent 还没来得及处理）
- **WHEN** runLoop 处理 pending messages
- **THEN** 5 条 steer 消息依次 push 到 `currentContext.messages`；只有最新 steer 触发的 `pendingMemorySearch` 被消费（因为 pending 早被覆盖）；memory 块 prepend 到第 5 条 steer 消息前

### Scenario: Grep 输出 > 50KB（truncate 后）
- **GIVEN** grep 调用结果被 truncate 到 50KB（DEFAULT_MAX_BYTES）
- **WHEN** `extractFileOpsFromMessage` regex 解析
- **THEN** 解析在 truncated 边界处停止；尾部 truncated 部分（"Full output: ..."）不含路径，自然不匹配；不报错

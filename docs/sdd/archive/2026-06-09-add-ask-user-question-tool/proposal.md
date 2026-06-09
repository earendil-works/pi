# 变更提案: add-ask-user-question-tool

## 动机

**问题**:Model 在用户用 webui 调用 `minimax` provider 时,会凭"训练数据里的 Claude Code 印象"生成 `ask_user_question` 工具调用。当前 pi-mono 框架里**完全没有注册这个 tool**,导致 `agent-loop.ts:573` 兜底返回 `Tool ask_user_question not found`。Model 看到错误后无脑重试(同样的 query 再调一次),还是 not found,最终被用户 abort 终止 turn。

**Why now**:
- 用户实际 session `~/.pi/agent/sessions/--home-qjh-.pi-agent--/2026-06-02T15-20-09.141Z_34022d26-...jsonl` 至少 3 次出现该错误(`2026-06-08T16:43:51` 那条最典型,model 调 2 次都被 `Tool ask_user_question not found` 拒掉,最终 abort)
- pi-mono 上游有 `ctx.ui.select()` / `ctx.ui.input()` / `ctx.ui.confirm()` 这些 stock 原语 + RPC 协议(`extension_ui_request` 出 / `extension_ui_response` 入)但** webui 端从未实现** RPC 响应路径
- 框架 80% 现成,我们只需要补 extension + webui 端两段连线

**期望效果**:Model 调用 `ask_user_question` 时,TUI 弹选项 UI 用户选 / webui 弹 modal 用户点,选完返回 label 给 model 继续推演。Not-found 错误彻底消失,用户被 model 主动问的体验打通。

## 影响范围

- **新增 Capability**:
  - `personal-assistant/ask_user_question_tool`: 在 personal-assistant extension 注册 `ask_user_question` tool,接受 Claude Code spec 的参数(`question` / `header` / `options` / `multiSelect`),normalize model 实际给的多种畸形参数形态,call `ctx.ui.select()` 或 `ctx.ui.input()` 走 stock pi 询问原语
  - `webui/rpc_extension_ui_response_bridge`: webui server 透传 web client 发回的 `extension_ui_response` 到对应 pi 子进程 stdin
  - `webui/ask_user_question_modal`: webui client 监听 `extension_ui_request` 事件,弹 modal(question + options + 提交),回发 response
  - `webui/ask_user_question_pending_placeholder`: webui 聊天页在 tool call 未完成时插入"⏳ 等待用户回答"占位,提交后替换为完整 tool call + result
  - `webui/ask_user_question_queue`: webui 支持多个未答 modal 排队(同一 session 内),并提供"还有 N 个未答"顶部提示 + 列表拉起
- **修改 Capability**:
  - `webui/ws_protocol`: 扩展 `ClientMessage` union 加 `extension_ui_response` 类型,server 端 ws/handler.ts 解析并调 session-pool
  - `webui/session_pool_rpc`: session-pool.ts 加 `sendExtensionUIResponse(sessionId, response)` 方法,走与 `prompt` / `abort` 相同的 stdin 写入路径
  - `personal-assistant/index.ts`: 调 `registerAskUserQuestion(pi)` 把新 tool 加入 entry
- **删除 Capability**:
  - 无

## 非目标

- **不修改 pi 上游**:不 fork pi-mono 仓库 / 不提 PR / 不给 `ctx.ui.select` 加新 method。完全在本地 extension + webui 层连接
- **不支持 per-option description 的丰富 UI**:TUI `ExtensionSelectorComponent` 的 `select()` 只接 `string[]`,把 description 字段拼到 label 后面(如 `"加 [remote] — 和现有依赖区分: 本地工具不加, HPC 工具加"`)。这意味着 TUI 下 description 是 inline text,不是 Claude Code 那种"label + 下面小字 description"的双行渲染。**未来如果 pi 上游支持,后续 change 再升级**
- **不支持真正的 TUI multi-select 勾选框 UI**:TUI 模式下 `multiSelect: true` 走 `ctx.ui.input()` 让用户手输逗号分隔 label。Webui 模式下走带 checkbox 的 modal(TUI 模式与 webui 模式体验不完全对齐,但**两者都能用**)
- **不修改 session jsonl 历史**:已有的 `Tool ask_user_question not found` 错误记录原样保留,作为"这个问题曾经存在过"的真实历史
- **不重命名 / 改写模型 prompt**:不通过 system prompt 强制 model 用别的 tool 名,也不注册第二个 `AskUserQuestion`(PascalCase)的别名。Tool name 严格 `ask_user_question`
- **不支持嵌套 follow-up 询问**:model 在 option label 里再问一个 follow-up question 的场景,本期不做
- **不持久化未答 modal 状态**:用户刷新页面 / 切 session 时未答 modal 丢失(走 "cancel + model 自行决定" 路径)
- **不支持多 session 并发 modal 路由**:同一 web client 打开多个 session tab 时,每个 session 的 modal 独立排队,不在 client 侧做跨 session 顺序

## 验收标准

1. **TUI 单选体验**:`pi --mode interactive` 下,model 调 `ask_user_question({question, header, options: [{label, description}]})` 时,屏幕弹出 `ExtensionSelectorComponent`,label + description 拼接到单行选项中,上下键切换 + Enter 选 + Esc 取消。选完返回 label 字符串给 model
2. **TUI multi-select 体验**:TUI 模式下 `multiSelect: true` 走 `ctx.ui.input()`,placeholder 列出所有 options 的 label + 提示"逗号分隔多项",用户输入 `a, c` 后返回 `"a, c"` 字符串给 model
3. **Webui 单选体验**:Web 浏览器调起 `ask_user_question` 时,聊天页面末尾插入"⏳ 等待用户回答: <question>"占位,同时弹出 modal 显示 question + options (label + description 两行),用户点选某项后 modal 关闭,占位被替换为完整 `tool call: ask_user_question + tool result: <chosen label>`,model 继续推演
4. **Webui multi-select 体验**:Web 浏览器下 `multiSelect: true` 弹带 checkbox 的 modal,用户可勾多项,提交后返回逗号分隔 label 字符串
5. **Timeout 行为**:5 分钟(`ExtensionUIDialogOptions.timeout: 5*60*1000`,可配)无响应,自动 cancel + 返回 "User did not respond within 5 minutes" 给 model,TUI 选区消失 / webui modal 关闭、占位被替换为"User did not respond..."tool result。TUI 与 webui 行为一致
6. **Model 参数 tolerance**:Tool 接受以下参数形态(实测 model 至少输出 3 种):
   - 标准 Claude Code spec: `{question, header, options: [{label, description}], multiSelect?}`
   - 实际 model 经常输出的: `{question, header, options: {item: [{label, description}]}}`
   - 更深嵌套: `{question, header, options: {item: {item: [...]}}}`
   - 缺 `header`(model 有时省): 只用 question
   - 缺 `multiSelect`: 默认 `false`
   - 缺 `options`: 报错"options required",不动
7. **历史 not-found 错误保留**:已有 session 里 6+ 处 `Tool ask_user_question not found` 错误显示不变(不抹历史)
8. **测试覆盖**:
   - 5 个 extension 单元测试(参数 normalize 5 种形态 + TUI/Webui 双路径 execute + timeout cancel)
   - 3 个 webui server 集成测试(`sendExtensionUIResponse` 写入 stdin / ws handler 接收 / RPC 协议 round-trip)
   - 3 个 webui client 组件测试(modal 弹窗 / 多 modal 排队 / 提交后占位替换)
9. **没引入回归**:209 个 webui server 测试 + 219 个 webui client 测试 + 8 个 personal-assistant extension 测试全部 pass
10. **可升级性**:实现方式严格走 stock pi 原语,未来 pi 上游提供更丰富 UI 时,只需改 `ask_user_question.ts` 内部即可,不动 webui 协议层

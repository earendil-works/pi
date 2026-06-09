# CLAUDE.md

Project-wide principles distilled from archived SDD changes. These apply to all
work in this repo; per-change principles are in `docs/sdd/archive/<change>/principles.md`.

## Satellite 远程执行原则

- Guardrail 拦截后返回 guidance error,不静默默重定向——让模型看见错误才能自纠正
- satellite 子工具 schema 与原生 pi 工具完全对齐:参数名、类型、可选性、description 一致
- `transfer_file` 走 HTTP body 传输,文件内容不经过 LLM context tokens
- `transfer_file` direction 字面量只有 `upload`/`download`,agent 必须显式声明方向
- bash guardrail 最多容忍 2 次同一模式违规,第 3 次返回硬错误
- 合法 bash 命令不受拦截(仅拦截 cat/sed/echo >/find 模式)
- 远程路径模式通过 `SATELLITE_GUARD_PATTERN` env var 配置,默认为空(不启用 guardrail)

## ask_user_question tool + webui card 原则

- **Extension tool schema 宽松接住、严格使用**: TypeBox schema 必须能接住 model 实际给出的所有畸形参数形态(嵌套 wrapper / 缺字段 / 字段类型不严),在 execute 内部 normalize 后再走严格逻辑。"model 幻觉 + 严 schema = 直接 422"是绝对要避免的反模式
- **Pi 上游已有的能力用 stock 原语组合,不去 fork 上游**: `ctx.ui.select` + `ctx.ui.input` 已经够用,不要为了"理想 UI"去提 PR;失去的可升级性是真实代价,得到的完美 UI 是稀薄收益
- **历史错误不重写**: session jsonl 里的 `Tool X not found` 之类历史错误是真实事件,fix 上线后不改写
- **Webui card 卡片不阻 flow**: 卡片 inline 流内,不 z-index/fixed,不遮挡其他内容
- **Webui card 操作后回显**: 用户选后 disabled 卡片不消失,上方显示选择结果,history 可回溯
- **Webui card 集成助手消息**: 卡片嵌入包含 toolCall 的助手消息内部,不是独立 message entry
- **Webui card 后端不改**: 保留 ask_user_question.ts / session-pool.ts / ws/handler.ts 不动,只改 webui client 渲染
- **Webui card 单选即时**: 点 option 瞬间发 ws 并 disable,不需额外 Submit 按钮
- **Webui card 多选编号**: 卡片内 input box 输 "1,3" 格式,Submit 发逗号分隔 label
- **Webui card 超时不丢人**: 卡片 disabled + 显示 "已超时",保留历史(不消失不隐)
- **rpc-mode 协议 id ≠ toolCall id**: `extension_ui_request.id` 是 `crypto.randomUUID()`,跟 toolCall 的 `call_00_...` 无关。Client 必须按 recency 匹配最近的 ask_user_question toolCall,不能用 id 字段匹配
- **server 回传 id 是 request UUID,不是 toolCall id**: server 的 `pendingExtensionRequests` map key by 请求 UUID,client 必须存 `requestId` 在 cardState 上,提交时 echo 这个 UUID
- **`tool_execution_end.result` 是对象不是字符串**: pi agent runtime 把 tool 的 return value `{content:[{type:"text", text:"..."}], details:{...}}` 作为 result 字段。Client 必须先 extract `result.content[0].text`,不能直接调 `.includes` 等 string method — 否则 React 整个 ChatPage 子树会因为未捕获异常被卸载

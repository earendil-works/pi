# Principles: add-ask-user-question-card

> 每条原则一句话。Archive 时追到 CLAUDE.md。

1. **卡片不阻 flow** — 卡片 inline 流内,不 z-index/fixed,不遮瑕其他内容
2. **操作后回显** — 用户选后 disabled 卡片不消失,上方显示选择结果,history 可回溯
3. **集成助手消息** — 卡片嵌入包含 toolCall 的助手消息内部,不是独立 message entry
4. **后端不改** — 保留 ask_user_question.ts / session-pool.ts / ws/handler.ts 不动,只改 webui client 渲染
5. **单选即时** — 点 option 瞬间发 ws 并 disable,不需额外 Submit 按钮
6. **多选编号** — 卡片内 input box 输 "1,3" 格式,Submit 发逗号分隔 label
7. **超时不丢人** — 卡片 disabled + 显示 "已超时",保留历史,(不消失不隐)

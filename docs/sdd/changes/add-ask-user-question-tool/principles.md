# 本变更原则

<!-- 一句话一条，里程碑追加到 CLAUDE.md -->

- Model 输出参数的 schema 校验要"宽松接住、严格使用":extension tool 的 TypeBox schema 必须能接住 model 实际给出的所有畸形参数形态(嵌套 wrapper / 缺字段 / 字段类型不严),在 execute 内部 normalize 后再走严格逻辑。**避免 model 幻觉 + 严 schema = 直接 422,业务走不通**
- Pi 上游没有的能力用 stock 原语组合,不去 fork 上游:`ctx.ui.select` + `ctx.ui.input` 已经够用,不要为了"理想 UI"去提 PR;失去的可升级性是真实代价,得到的完美 UI 是稀薄收益
- Extension UI 双向通信的"请求已发出"和"响应已回"是**两次不同状态机**:请求到达时插入占位(等),响应到达时不立即替换占位(等),等到 pi emit `tool_execution_end` 时一次性用 tool call + result 替换占位。中间态闪烁是不被允许的回归
- 历史错误不重写:已 session jsonl 里 `Tool X not found` 之类的历史错误是真实事件,fix 上线后不改写。Fix 的作用范围从 fix 后开始算
- Modal 排队按 session 隔离,不在 client 侧做跨 session 顺序:每个 web client tab 自己管自己 session 的 modal 队列,简单且可预测

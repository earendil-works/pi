# 本变更原则

- WebUI 永远跑在调用 `pi --web` 时的父 cwd,不是 webui 包 cwd
- session 标题 = 第一条 user 消息的前 30 字符(创建时未知,首次发送后写定)
- DELETE 永远乐观:UI 不等后端 IO(LLM 抽 atoms 是 fire-and-forget,失败日志记录)
- 主路由 `/` 是 chat-first 布局,左栏常驻 session 列表,新对话是空状态
- WebUI 和 pi 子进程走真 RPC 协议(`message` 不是 `text`),任何字段名错配都让 prompt 静默失败

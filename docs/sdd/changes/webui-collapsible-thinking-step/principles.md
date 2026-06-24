# 本变更原则

<!-- 一句话一条，里程碑追加到 CLAUDE.md -->

- **Step wrapper 是 webui-only 渲染抽象**: 把 assistant turn 包成可折叠 step 是 webui 的 UI 关注点,TUI / JSONL / 后端都不感知。Step 边界由 `MessageParts` 渲染层自己定,不动数据模型
- **Step body 内容是完整 turn**: 含 thinking + tool + 所有 text,无内容切分。`Part[]` 顺序就是 step body 顺序,不做"中间思考 vs 最终响应"语义拆分
- **Step wrapper 触发条件:含 thinking 或 tool**: 纯 text turn 不裹,保持改动前视觉。判断由 parts 的 type set 决定,0 运行时成本
- **isStreaming 是单向上下文**: 父组件 (ChatPage) 知道 `isThinking`,通过 prop 透传到 MessageBubble → MessageParts。子组件不读 store / 不发请求
- **Step collapsed/expanded 状态用 useState**: 用户点击 toggle 改变本地 state,无持久化、无 URL 参数。刷新页面后 step 默认按 `isStreaming` 决定(流中展开,流完折叠)
- **Duration 显示 = "已过秒数" 近似,非真实耗时**: `Date.now() - timestamp` 不冻结,过去 turn 会缓慢增长。客户端唯一 source of truth,不依赖后端 `durationMs`。setInterval 1s tick 触发 re-render

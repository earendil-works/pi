# 本变更原则

<!-- 一句话一条，里程碑追加到 CLAUDE.md -->

- **Step wrapper 是 webui-only 渲染抽象**: 把 assistant turn 包成可折叠 step 是 webui 的 UI 关注点,TUI / JSONL / 后端都不感知。Step 边界由 `MessageParts` 渲染层自己定,不动数据模型
- **Step body 只包 inference (thinking + tool + image),text 在 fold 外**: fold 用于隐藏"过程"(可折叠 = 过程性、可隐藏),text 是"结果"(必须始终可见)。`chunks` 拆为 `inferenceChunks` + `textChunks`,fold 包前者,后者作为 sibling 渲染。Streaming 中间 text delta + 最终 reply 都走 textChunks 路径
- **Step wrapper 触发条件:含 thinking 或 tool 或 image**: 纯 text turn 不裹 fold,保持改动前视觉。判断由 parts 的 type set 决定,0 运行时成本
- **isStreaming 是单向上下文**: 父组件 (ChatPage) 知道 `isThinking`,通过 prop 透传到 MessageBubble → MessageParts。子组件不读 store / 不发请求
- **Step collapsed/expanded 状态用 useState**: 用户点击 toggle 改变本地 state,无持久化、无 URL 参数。刷新页面后 step 默认按 `isStreaming` 决定(流中展开,流完折叠)
- **Duration 显示 = "已过秒数" 近似,非真实耗时**: `Date.now() - timestamp` 不冻结,过去 turn 会缓慢增长。客户端唯一 source of truth,不依赖后端 `durationMs`。setInterval 1s tick 触发 re-render

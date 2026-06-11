# 变更提案: 将 ask_user_question 交互从全屏 Modal 改为 Inline 卡片

## 动机
当前实现(来自 `add-ask-user-question-tool`)的 `AskUserQuestionModal` 是全屏 modal(
`fixed inset-0 z-50` + `bg-black/50`),跟飞书风格不符。用户期望:**卡片 inline 嵌入助手消息末尾**,
单选点卡片直接提交,多选输入编号逗号分隔。卡片在用户操作后 disabled + 显示选择结果,不消失。

## 影响范围
- **保留**:
  - `extensions/personal-assistant/ask_user_question.ts`(tool 逻辑 / normalize / execute — 不动)
  - `packages/webui/server/session-pool.ts`(sendExtensionUIResponse — 不动)
  - `packages/webui/server/ws/handler.ts`(extension_ui_response routing — 不动)
- **修改 Capability**:
  - Webui Client:AskUserQuestion 从 full-screen modal 改为 inline 卡片
- **删除 Capability**:
  - `AskUserQuestionModal.tsx`(全屏 modal → 替换)
  - `AskUserQuestionProvider.tsx`(z-50 队列 → 替换)
  - `AskUserQuestionPending.tsx`(占位 strip → 不需要)
  - `AppShell.tsx` 恢复原样(不再包裹 Provider)
- **新增 Capability**:
  - `AskUserQuestionCard.tsx`(inline 卡片,嵌入助手消息)
  - ChatPage 新 integration(卡片 inline,不分离 Provider)

## 非目标
- 不改动 TUI 端(TUI 端仍用 `ctx.ui.select/input`,不动)
- 不改动 server/ws 协议(已对)
- 不改动 ext tool 逻辑(已对)
- 不做 i18n(单语言 English + Chinese)
- 不做点击外部取消(Esc 键保留,但无 backdrop 可点)

## 验收标准
 1. 卡片 inline 渲染在包含 `ask_user_question` toolCall 的助手消息末尾(不是单独 message entry)
 2. 单选:option 以 button/card 形式列出,点选后立即发 `extension_ui_response`,卡片所有选项 disabled + 上方显示 "你的选择:<label>"
 3. 多选:option 以编号列表列出,卡片底部有小型 input + Submit 按钮,
    用户输 "1,3" 后 Submit 提交 `extension_ui_response`,卡片 disabled + 显示 "你的选择:label1,label2"
 4. 已 disabled 的卡片在 session history 中保留(重新进入 session 时可见过去的交互记录)
 5. Timeout(5 分钟)后卡片 disabled + 显示 "已超时" / "User didn't respond"
 6. 其他 tool 仍正常渲染(不受影响)
 7. 无 full-screen modal / 无 backdrop / 无 z-50 overlay
 8. 全量 client 测试:232 pass(sdd-review 时验证)
 9. 全量 server 测试:218 pass
10. 全量 ext 测试:143 pass

# Verification Checklist: add-ask-user-question-card

> 生成时间: 2026-06-09 | 审查者必须逐项验证并附可追溯证据
> 状态格式: (空格) 待验证 | (x) 通过 | (!) 失败

## 场景验证 (Scenarios)

| # | 场景 | 来源 | 验证方式 | 验证命令/步骤 | 期望结果 | 状态 |
|---|------|------|----------|--------------|---------|------|
| S1 | 单选卡片 — 点选提交 → 卡片 disabled + "你的选择: 红色" + ws.send | scenarios.md:L9 | 单元测试 | `cd packages/webui/web && npx vitest run src/components/AskUserQuestionCard.test.tsx -t "single-select"` | 1 passed | [ ] |
| S2 | 多选卡片 — 编号列表 + input box → 输 "1,3" Submit → "你的选择: label1, label2" | scenarios.md:L16 | 单元测试 | `cd packages/webui/web && npx vitest run src/components/AskUserQuestionCard.test.tsx -t "multi-select"` | 1 passed | [ ] |
| S3 | 卡片在 session history 保留 — toolResult Content 显示 "User selected: ..." | scenarios.md:L23 | 集成测试 | `cd packages/webui/web && npx vitest run src/pages/ChatPage.test.tsx -t "card disabled"` | 1 passed | [ ] |
| S4 | Model 发畸形 options → normalize 返 [] → execute 返 isError → 无卡片 | scenarios.md:L31 | 单元测试 | `cd extensions/personal-assistant && npx vitest run test/ask-user-question.test.ts -t "normalizeOptions"` | 8 passed (已有) | [ ] |
| S5 | options=1(非法) → 不触发 extension_ui_request | scenarios.md:L37 | 单元测试 | `cd extensions/personal-assistant && npx vitest run test/ask-user-question.test.ts -t "options=1"` | 1 passed | [ ] |
| S6 | Disabled 卡片上点选 → 无 ws.send | scenarios.md:L42 | 单元测试 | `cd packages/webui/web && npx vitest run src/components/AskUserQuestionCard.test.tsx -t "disabled"` | 1 passed (options not clickable) | [ ] |
| S7 | ws 断开时卡片仍显示(离线) | scenarios.md:L47 | code-review | `packages/webui/web/src/pages/ChatPage.tsx` — cardStates 不依赖 ws 连通性 | card render 基于 state(不抛 ws 异常) | [ ] |
| S8 | options=4 + 长 description → 卡片不溢出 | scenarios.md:L52 | 单元测试 | `cd packages/webui/web && npx vitest run src/components/AskUserQuestionCard.test.tsx -t "renders"` | 卡片高度自适应,文本 scroll | [ ] |
| S9 | 其他 tool(如 bash) → 不渲染卡片 | scenarios.md:L58 | 代码审查 | `packages/webui/web/src/components/message/MessageParts.tsx` — 仅 `name === "ask_user_question"` 才 render card | 其他 tool 无 card | [ ] |
| S10 | 卡片在消息流内跟随滚动 | scenarios.md:L62 | 代码审查 | AskUserQuestionCard 不设 position:fixed / z-50 | 卡片在 bubble 内流式 | [ ] |
| S11 | 5 分钟 timeout → 卡片 disabled + "已超时" | scenarios.md:L67 | 单元测试 | `cd packages/webui/web && npx vitest run src/components/AskUserQuestionCard.test.tsx -t "timeout"` | 1 passed | [ ] |
| S12 | 多选输入 "a,b" → parse 失败 → filter 取有效 | scenarios.md:L73 | 单元测试 | `cd packages/webui/web && npx vitest run src/components/AskUserQuestionCard.test.tsx -t "multi-select invalid"` | 1 passed (只返回有效编号的 label) | [ ] |

## 需求验证 (Requirements)

| # | 需求 | 来源 | 验证方式 | 期望证据 | 状态 |
|---|------|------|----------|---------|------|
| R1 | Webui Inline Card Rendering — 卡片嵌入助手 message bubble | spec.md ADDED #1 | 代码审查 | `MessageParts.tsx` 在 toolCall name="ask_user_question" 后渲染 `<AskUserQuestionCard>` | [ ] |
| R2 | Single-Select Click Submits — 点 option 立即 ws.send | spec.md ADDED #2 | 代码审查 | `AskUserQuestionCard.tsx` — active + single-select → option.onClick → onSubmit(label) | [ ] |
| R3 | Multi-Select Numbered Input — 编号列表 + input box + Submit | spec.md ADDED #3 | 代码审查 | `AskUserQuestionCard.tsx` — active + multiSelect → numbered options + input + Submit | [ ] |
| R4 | Disabled Card Retains State — grayed + result text | spec.md ADDED #4 | 代码审查 | `AskUserQuestionCard.tsx` — disabled/timeout status renders differently | [ ] |
| R5 | No Fixed Overlay — card not fixed z-50 | spec.md ADDED #5 | 代码审查 | `AskUserQuestionCard.tsx` 不含 `position: fixed` / `inset-0` / `z-50` | [ ] |
| R6 | ChatPage pendingQuestions Removal — 不再用独立占位 | spec.md MODIFIED #1 | 代码审查 | `ChatPage.tsx` 删掉 `pendingQuestions` state + `AskUserQuestionPending` import | [ ] |
| R7 | AppShell Provider Removal | spec.md MODIFIED #2 | 代码审查 | `AppShell.tsx` 不再 import `AskUserQuestionProvider` | [ ] |
| R8 | Server/Ext 零更改 — ask_user_question.ts / session-pool.ts / ws/handler.ts 不动 | design.md | 代码审查 | `git diff 1651e455..HEAD -- extensions/personal-assistant/ packages/webui/server/` 为空 | [ ] |

## 通过标准

- [ ] 所有场景 (S1-S12) 状态为 [x]，每项有可追溯证据
- [ ] 所有需求 (R1-R8) 状态为 [x]，每项有源码行号
- [ ] 全量测试基线: server 218 / web 231 / ext 143 = **592 tests pass**
- [ ] e2e 浏览器截图: 卡片 inline 渲染 + 单选 disabled + 多选编号输入 = 3 张
- [ ] git history: 6-9 atomic commits

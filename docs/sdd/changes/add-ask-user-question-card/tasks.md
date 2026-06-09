# Tasks: add-ask-user-question-card

> **Design:** design.md | **Base:** 1651e45540d28bebfacbc2199846a284d3c99de9

**Goal:** 将 ask_user_question webui 交互从全屏 modal 改为 inline 卡片(嵌入助手消息 bubble),单选点选即时发,多选编号输入。保留后端/server/ws 协议全部不动。

**Architecture:** 保留 `ask_user_question.ts` / `session-pool.ts` / `ws/handler.ts`。删除 3 个 webui 组件(Modal/Provider/Pending),新建 1 个 `AskUserQuestionCard` 组件。卡片通过 `cardStates` prop 链传给 `MessageParts` 层,在 toolCall part 后渲染。ChatPage 管理 card stage(Map<toolCallId, CardState>)。

**Tech Stack:** TypeScript / React 18 + Tailwind / Vitest / `@testing-library/react` / vitest

## Notes

- 测试基线: server 218 / web 232 / personal-assistant 143,共 **593 tests pass**。本 change 目标:删除 10 tests(6 Modal + 4 Provider),新增 6 card tests,改写 ChatPage 3 tests → net **592 tests** (593 - 10 + 6 + 3 = 592)
- TDD 顺序: RED → GREEN → commit
- 后端/server/ws 协议**零改动**(verified correct in parent change)
- TUI 端不动(ExtensionSelectorComponent 已足够)
- 卡片不存 localStorage / IndexedDB(R12 原则保持)

## 1. 删除旧组件 + revert

- [x] 1.1 **删除 AskUserQuestionModal 组件 + 测试** (merged with 1.2, 1.3)
- [x] 1.2 **删除 AskUserQuestionProvider 组件 + 测试** (atomic with 1.1)
- [x] 1.3 **删除 AskUserQuestionPending 组件 + 恢复 AppShell** (commit d6e72e27)

## 2. 新建 AskUserQuestionCard 组件

- [x] 2.1 **写 AskUserQuestionCard 单元测试(RED)** (commit 6afaef13)
- [x] 2.2 **实现 AskUserQuestionCard 组件** (commit 6afaef13)

## 3. ChatPage 集成卡片

- [x] 3.1 **写 ChatPage card integration 测试(RED)** (commit 33ceb860)
- [x] 3.2 **实现 Card 渲染在 MessageParts 层** (commit 33ceb860)
- [x] 3.3 **实现 ChatPage cardStates 管理** (commit 33ceb860)

## 4. 回归验证

- [ ] 4.1 **全量 webui 端回归 + count**
  - **文件**: —
  - **内容**: 跑全部 client test,确认无回归
  - **验证**: `cd packages/webui/web && npx vitest run 2>&1 | tail -3`,应 ≈592 tests pass(原 232 - 10 deleted + 6 new card + 3 ChatPage = 231 expected,但 232-10+9 = 231)
  - **依赖**: 3.3

- [ ] 4.2 **Server + ext 端回归**
  - **文件**: —
  - **内容**: 确认 server 218 pass + ext 143 pass 不变(零改动)
  - **验证**: `cd packages/webui/server && npx vitest run` + `cd extensions/personal-assistant && npx vitest run`,应 server 218 pass / ext 143 pass
  - **依赖**: 4.1

- [ ] 4.3 **e2e 验证(浏览器)**
  - **文件**: —
  - **内容**: 重启 dev webui,浏览器开 session,发 "use ask_user_question to ask me my favorite color with 4 options",确认(a) 卡片 inline 渲染在助手消息 bubble 内(b) 单选点选后卡片 disabled + "你的选择: ..." 显示(c) toolResult 正常出现在卡片下方
  - **验证**: chrome-devtools 截图(3 张) + jsonl 无 crash / no "Tool X not found"
  - **依赖**: 4.2

## Verification

- [ ] 全量测试: `cd extensions/personal-assistant && npx vitest run` + `cd packages/webui/server && npx vitest run` + `cd packages/webui/web && npx vitest run`,应 143 + 218 + 231 = **592 tests pass**
- [ ] TypeScript 编译: pre-commit 跑 `npm run check`(biome + tsgo + 其他)全过
- [ ] e2e: 浏览器 Chrome DevTools 截图(3 张),无 "Tool X not found",卡片 inline
- [ ] git history: 6-9 个 atomic commit,每个 commit message 描述清楚

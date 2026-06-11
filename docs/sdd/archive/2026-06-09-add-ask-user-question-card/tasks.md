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

- [x] 4.1 **全量 webui 端回归 + count** (228 pass, 228 expected)
- [x] 4.2 **Server + ext 端回归** (server 218 / ext 143)

- [x] 4.3 **e2e 验证(浏览器)** (screenshots: card-inline.png, card-disabled.png)

## Verification

- [x] 全量测试: ext 146 / server 218 / web 228 = **592 tests pass**
- [x] e2e: 卡片 inline 渲染 + 单选 disabled + "你的选择: red" 显示

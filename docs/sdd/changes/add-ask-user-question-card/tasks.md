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

- [ ] 2.1 **写 AskUserQuestionCard 单元测试(RED)**
  - **文件**: `packages/webui/web/src/components/AskUserQuestionCard.test.tsx` (Create)
  - **内容**: 6 个 it:
    1. 渲染 question + options(label+description 两行)
    2. 单选: click option → onSubmit(label) called
    3. 多选: 渲染 numbered list (1. label / 2. label) + input box placeholder "输入选项编号,逗号分隔" + Submit 按钮
    4. 多选: type "1,3" → Submit → onSubmit called with joined labels "label1, label2"
    5. status=disabled: options grayed/not clickable + result text "你的选择: label" 显示
    6. status=timeout: options grayed + "已超时" 显示
  - **验证**: 初始 `npx vitest run ...` 应 RED(import 失败 — 组件未创建)
  - **依赖**: 1.3

- [ ] 2.2 **实现 AskUserQuestionCard 组件**
  - **文件**: `packages/webui/web/src/components/AskUserQuestionCard.tsx` (Create)
  - **Props**:
    ```ts
    interface AskUserQuestionCardProps {
      question: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect: boolean;
      status: 'active' | 'disabled' | 'timeout';
      selected?: string;
      onSubmit: (value: string) => void;
      onCancel: () => void;
    }
    ```
  - **渲染逻辑**:
    - `active` + single-select: options as clickable cards/buttons,点选 → onSubmit(label)
    - `active` + multi-select: numbered list + `<input>` box "输入选项编号,逗号分隔" + Submit button,Submit → parse 编号取 label → onSubmit(labels.join(", "))
    - `disabled`: options grayed + 静态文本 "你的选择: {selected}"
    - `timeout`: options grayed + 静态文本 "已超时"
    - Cancel 按钮(小字,在 card footer)
    - 样式: Tailwind border/rounded/bg,跟 ToolGroup 风格一致(border-gray-200, rounded, bg-white)
  - **验证**: `cd packages/webui/web && npx vitest run src/components/AskUserQuestionCard.test.tsx 2>&1 | tail -3`,6 tests GREEN
  - **依赖**: 2.1

## 3. ChatPage 集成卡片

- [ ] 3.1 **写 ChatPage card integration 测试(RED)**
  - **文件**: `packages/webui/web/src/pages/ChatPage.test.tsx` (Modify — 重写 "Ask user question placeholder" describe block 为 "Ask user question card")
  - **内容**: 3 个 it:
    1. 收到 `extension_ui_request` → 卡片渲染在助手消息 bubble 内(找 toolCall part 后面的 card element with question text)
    2. 收到 `tool_execution_end` with toolName="ask_user_question" → 卡片 status 变 disabled + 显示 toolResult content 作为 selected text
    3. 收到 `tool_execution_end` with 不同 toolName → 卡片保持 active
  - **验证**: 初始 RED(因为 ChatPage 未改)
  - **依赖**: 2.2

- [ ] 3.2 **实现 Card 渲染在 MessageParts 层**
  - **文件**:
    - `packages/webui/web/src/components/message/MessageParts.tsx` (Modify — add cardStates prop + card rendering in ToolGroup)
    - `packages/webui/web/src/components/ChatMessages.tsx` (Modify — add cardStates prop, pass to MessageBubble)
    - `packages/webui/web/src/components/message/MessageBubble.tsx` (Modify — accept cardStates, pass to MessageParts)
  - **内容**:
    - `MessageParts.tsx`: 加 `import AskUserQuestionCard from "../AskUserQuestionCard"` + 加 `cardStates?: Map<string, CardState>` prop + 在 ToolGroup 的 parts.map 循环中,如果 part.type === "toolCall" && part.name === "ask_user_question" && cardStates.has(part.id),渲染 `<AskUserQuestionCard>` 在该 toolCall 后面
    - `ChatMessages.tsx`: 接口加 `cardStates?: Map<string, CardState>`,传给 MessageBubble
    - `MessageBubble.tsx`: 接口加 `cardStates`,传给 MessageParts
    - CardState 类型定义(放在 `AskUserQuestionCard.tsx` 或 lib/api.ts):
      ```ts
      export interface CardState {
        id: string;
        question: string;
        options: Array<{ label: string; description?: string }>;
        multiSelect: boolean;
        status: 'active' | 'disabled' | 'timeout';
        selected?: string;
        sessionId: string;
      }
      ```
  - **验证**: `cd packages/webui/web && npx vitest run 2>&1 | tail -3`,全 GREEN,无 regression
  - **依赖**: 3.1

- [ ] 3.3 **实现 ChatPage cardStates 管理**
  - **文件**: `packages/webui/web/src/pages/ChatPage.tsx` (Modify)
  - **内容**:
    1. 删掉 `AskUserQuestionPending` import + `pendingQuestions` state + pendingQuestionsStrip JSX
    2. 新增 `cardStates` state(Map<toolCallId, CardState>)
    3. 在现有 ws.subscribe handler 中(已合并到同一个 subscribe),`extension_ui_request` → 从 `event.options` 提取(复制 normalizeOptions 逻辑到 `../../extensions/personal-assistant/ask_user_question.ts` — 不,用内联复制 40 行 normalize 函数);设定 cardStates[id] = {status: 'active', ...}
    4. `tool_execution_end` with toolName=ask_user_question → 更新对应 card 到 disabled/timeout(status 从 result text 判断:含 "cancelled"/"timeout" 则 timeout)
    5. 传 `cardStates` 给 `<ChatMessages>`
  - **验证**: `cd packages/webui/web && npx vitest run src/pages/ChatPage.test.tsx 2>&1 | tail -3`,3 个新 card test GREEN + 原有 13 tests 无 regression
  - **依赖**: 3.2

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

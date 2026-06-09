# Design: add-ask-user-question-card

## Context

`add-ask-user-question-tool`(parent change)已经正确实现了：
- **Extension 端**: `ask_user_question` tool 注册 + normalize + execute(有 2 arg 签名 bug 但 fix 在 98d0cb1a)
- **Server 端**: `sendExtensionUIResponse` stdin write + ws handler routing
- **Client 端**: `AskUserQuestionModal`(全屏 modal) + `AskUserQuestionProvider`(z-50 队列)

**但 client UI 选错了交互模式**。用户期望 flutter 风格 inline 卡片(嵌入助手消息内部),不是全屏 overlay。本 change 保留后端 100%,重做 webui 客户端渲染。

## Goals / Non-Goals

**Keep(不动)**:
- `extensions/personal-assistant/ask_user_question.ts`
- `packages/webui/server/session-pool.ts`(sendExtensionUIResponse)
- `packages/webui/server/ws/handler.ts`(extension_ui_response case)

**Change(webui 端)**:
- Delete: `AskUserQuestionModal.tsx` + `AskUserQuestionProvider.tsx` + `AskUserQuestionPending.tsx`
- Revert: `AppShell.tsx`(不再包裹 Provider,恢复原样)
- Create: `AskUserQuestionCard.tsx`(inline 卡片组件)
- Modify: `ChatPage.tsx`(card 状态管理 + inline 渲染)
- Modify: `ChatMessages.tsx`(接受 cardStates prop,在助手消息渲染 ask_user_question 卡片)

**Non-goals**: TUI mode / ext logic / server logic / i18n / 固定位置

## Decisions

### D1: 卡片嵌入助手消息内,不是独立 message entry
**Rationale**: 用户期望的飞书风格是卡片出现在助手消息下方,作为消息的一部分。用独立 message entry 会多余一条空白气泡、破坏流式对话体验。
**Alternatives considered**: 独立 message entry — 拒绝了,因为 card 不属于对话历史模型(是 UI 层交互)

### D2: Card state 由 ChatPage 层管理,通过 props 传给 ChatMessages
**Rationale**: ChatPage 已有 `ws.subscribe("session_event")` 逻辑,直接在该处管理 card state。ChatMessages 是纯渲染组件,通过 props 接收 `cardStates: Map<toolCallId, CardState>`。
**Alternatives**: Provider 方案 — 拒绝了,因为 card 不跨组件共享(只在消息流内)

### D3: 单选点选即时提交,无需 Submit 按钮
**Rationale**: 飞书风格 option 是 button/card,点选 = 提交 = 发 ws。减少一次 click。
**Design detail**: card 里 option 用 `<button onClick={() => onSubmit(label)}>` 渲染。
**Alternatives**: 加 Submit 按钮 — 拒绝了,因为增加操作步数。

### D4: 多选用编号输入 + Submit,不用 checkbox
**Rationale**: 小 input box 不占用卡片空间,用户输 "1,3" → parse = emit `extension_ui_response` 带 value "label1, label2"。
**Alternatives**: checkbox 方案 — 拒绝了,因为挤占垂直空间且交互跟飞书风格不符。

### D5: Disabled state 保留卡片 + 显示结果文字
**Rationale**: 用户要求操作后卡片不消失,history 可见。disabled 时所有 option 灰色 + 不可点,卡片上方静态文本显示选择/超时结果。
**Alternatives**: 卡片消失 — 拒绝了,因为不可回溯。

### D6: 不复用 MessagePart 协议的 `toolResult`
**Rationale**: `toolResult` part 包含 model 返回的 content text(如 "User selected: 红色")。卡片在 `toolCall` 和 `toolResult` 之间渲染。disabled 后的结果文字从 card state 或 toolResult content 提取。

## Architecture

```
ChatPage(pendingQuestions Map + ws.subscribe)
  └─ ChatMessages(cardStates prop)
       └─ 助手消息渲染循环
            ├─ text part → <Markdown>
            ├─ toolCall part → <ToolCallComponent>
            │  (if name=ask_user_question + cardStates.has(id))
            │    → <AskUserQuestionCard>
            │        (single: click option → ws.send → card.disabled)
            │        (multi: input "1,3" + Submit → ws.send → card.disabled)
            │    → result text(disabled 后显示)
            └─ toolResult part → <ToolResultComponent>
```

### Component: AskUserQuestionCard

```ts
interface AskUserQuestionCardProps {
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
  status: 'active' | 'disabled' | 'timeout';
  selected?: string;       // 用于 disabled/timeout 状态的展示
  onSubmit: (value: string) => void;
  onCancel: () => void;
}
```

**渲染**:
- `active` + single-select: option 列表(button with hover),无 footer
- `active` + multi-select: 编号列表 + input box "输入选项编号,逗号分隔" + Submit button
- `disabled`: 所有 option grayed,上方显示 "你的选择: <selected>"
- `timeout`: 所有 option grayed,上方显示 "已超时"

**Wireframe**:
```
┌─ 助手消息 ───────────────────────────────┐
│ Boss,请选择您最喜欢的颜色:                 │
│                                            │
│ 问题: 您最喜欢的颜色是什么?(card)          │
│ ┌──────────────────────────────────────┐  │
│ │ [红色]   温暖明亮的红色               │  │
│ │ [蓝色]   清新平静的蓝色               │  │
│ │ [绿色]   生机勃勃的绿色               │  │
│ │ [紫色]   高贵神秘的紫色               │  │
│ └──────────────────────────────────────┘  │
│                                            │
│ (disabled 后) 你的选择: 红色               │
│ (toolResult)  User selected: 红色          │
└────────────────────────────────────────────┘
```

### State Management (ChatPage)

```ts
interface CardState {
  id: string;            // toolCallId
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
  status: 'active' | 'disabled' | 'timeout';
  selected?: string;
  sessionId: string;
}

const [cardStates, setCardStates] = useState<Map<string, CardState>>(new Map());

// useEffect: ws.subscribe("session_event", handler)
//   handler:
//     extension_ui_request (active):
//       → add to cardStates (status=active)
//     tool_execution_end (toolCallId match):
//       → update card status to disabled/timeout + extract selected from result
```

### Card rendering in ChatMessages

在助手消息的 content 遍历中:
```tsx
{message.content.map((part, i) => {
  if (part.type === 'toolCall') {
    const card = cardStates.get(part.id);
    const nextPart = message.content[i+1];
    const toolResult = nextPart?.type === 'toolResult' ? nextPart.content : null;
    
    return (
      <React.Fragment key={part.id}>
        <ToolCallPart part={part} />
        {card && (card.status === 'active' || card.status === 'disabled' || card.status === 'timeout') && (
          <AskUserQuestionCard
            question={part.args.question}
            options={normalizeOptions(part.args.options)}
            multiSelect={part.args.multiSelect}
            status={card.status}
            selected={card.selected}
            onSubmit={(value) => { ws.send({ ... }); /*will be handled by tool_execution_end*/ }}
            onCancel={() => { ws.send({ ... cancelled: true }); }}
          />
        )}
        {card?.status !== 'active' && card?.selected && (
          <div className="...">你的选择: {card.selected}</div>
        )}
      </React.Fragment>
    );
  }
  return <MessagePart part={part} />;
})}
```

### Files to Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/webui/web/src/components/AskUserQuestionCard.tsx` | **CREATE** | Inline card component |
| `packages/webui/web/src/components/AskUserQuestionCard.test.tsx` | **CREATE** | Card tests |
| `packages/webui/web/src/components/AskUserQuestionModal.tsx` | **DELETE** | Remove full-screen modal |
| `packages/webui/web/src/components/AskUserQuestionModal.test.tsx` | **DELETE** | Remove modal tests |
| `packages/webui/web/src/components/AskUserQuestionProvider.tsx` | **DELETE** | Remove provider |
| `packages/webui/web/src/components/AskUserQuestionProvider.test.tsx` | **DELETE** | Remove provider tests |
| `packages/webui/web/src/components/AskUserQuestionPending.tsx` | **DELETE** | Remove placeholder strip |
| `packages/webui/web/src/components/AppShell.tsx` | **MODIFY** | Revert Provider wrapper |
| `packages/webui/web/src/components/AppShell.test.tsx` | **MODIFY** | Remove Provider-related assertion if any |
| `packages/webui/web/src/pages/ChatPage.tsx` | **MODIFY** | cardStates + inline rendering |
| `packages/webui/web/src/pages/ChatPage.test.tsx` | **MODIFY** | Update placeholder tests → card tests |

## Risks / Trade-offs

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Card rendering in ChatMessages 破坏现有布局 | Medium | 卡片用 flexbox 流式,不设 absolute/fixed; test 覆盖 |
| 多选编号输入 parse error(用户输 "a,b") | Low | 简单 filter: `split(",").map(s => s.trim()).filter(n => !isNaN(+n))`,取对应序号 label |
| `normalizeOptions` 在 client 端重复调用 | Low | 包装 `normalizeCardOptions` 函数,sharing 逻辑 from ext(或 copy 40 行) |
| 卡片不显示全屏 backdrop,误触几率 | Low | 卡片有 Cancel 按钮、Esc 键仍支持(但无 backdrop 可点) |
| Session history 丢失 card 交互记录 | Low | Card state 不 persist(session 刷新丢失),但 toolResult 仍显示最终结果 |
| `toolCall` 和 `toolResult` 在同一 message 可能时序不同 | Low | 确保 tool_execution_end event 正确处理(toolCallId match),不依赖先后顺序 |

## Testing Strategy

- **Unit tests(AskUserQuestionCard)**: 6 tests:
  1. 渲染 question + options
  2. 单选: click option → onSubmit called with correct label
  3. 多选: render numbered list + input box
  4. 多选: type "1,3" + Submit → onSubmit called with joined labels
  5. disabled 状态: options grayed + result text 显示
  6. timeout 状态: options grayed + "已超时" 显示
- **Integration tests(ChatPage)**: 3 tests(rewrite existing placeholder tests):
  1. extension_ui_request → card appears in assistant message
  2. tool_execution_end → card disabled + result text
  3. tool_execution_end with wrong toolName → card unaffected
- **删除 tests**: 10 tests removed (6 Modal + 4 Provider)
- **Net test count**: 6 (card) - 10 (deleted) + 3 (rewritten ChatPage) = 232 - 1 = **231 expected** (212 original + 0)

## Implementation Notes

1. Card renders **after** the toolCall part and **before** the toolResult part (when toolResult exists)
2. Card 的 `options` 从 toolCall `arguments.options` 取,可能为 `{item:[...]}` 形态 — 在 client 端重新 normalize(复制 normalizeOptions 函数逻辑 40 行到 utils)
3. ChatPage 删掉 `pendingQuestions` state + `AskUserQuestionPending` import
4. ChatMessages 通过新 prop `cardStates?: Map<string, CardState>` 接收
5. 删掉 4 个组件文件 + 2 个 test 文件 = 6 个文件删除(加之前的 5 个,一共 11 个变化)

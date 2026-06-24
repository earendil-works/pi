# Design: webui-collapsible-thinking-step

## Context
当前 webui 在 `MessageParts.tsx:268` 把 assistant turn 内的 thinking / text / toolCall / toolResult / image 按顺序平铺渲染,每个 part 独立卡片/按钮。问题:
- 长 CoT 占满聊天流,挤掉用户真正想看的内容
- 6+ 个 tool call 卡片纵向堆叠,噪音 > 信息
- 翻历史 turn 时,看到 5KB thinking 文本 + 一堆 tool card 容易迷路
- 推理时缺乏明确"模型还在跑"信号,容易误判卡死

`/api/sessions/:id/messages` 已经返回 structured `Part[]`(见 `chat-message-rendering` spec),有 `thinking | text | toolCall | toolResult | image` 5 种类型。改动在渲染层做 step wrapper,不动数据模型、不动后端、不动 TUI。

## Goals / Non-Goals
- **Goals**:
  - 整个 assistant turn 包裹成可折叠 step(thinking + tool + 全部 text)
  - header 永远显示 `● Executing (Xs) ▼` / `✓ Completed (Xs) ▲`,点击 toggle
  - streaming 时 body 默认展开,推理完自动折叠
  - 纯 text turn 不裹,保持改动前视觉
  - 纯前端,不动 JSONL / 后端 / TUI
- **Non-Goals**:
  - TUI 不动 (pi TUI 已有 hideThinkingBlock,风格紧凑)
  - 精确 duration (用 `Date.now() - timestamp` 近似,过去 turn 会增长)
  - abort/error 特殊 icon (需 Message interface 加 stopReason,本次不动)
  - 持久化 collapsed state
  - 全部展开/折叠快捷键

## Decisions

### 1. 在 MessageParts 内做 step 包装,不动 MessageBubble 职责
**Decision**: step wrapper 完全在 `MessageParts.tsx` 内实现,`MessageBubble.tsx` 只加 1 行 prop 转发
**Rationale**: MessageParts 已经持有 `parts: Part[]` + chunks 算法,step 是 part 数组的渲染概念,放在这里最自然。MessageBubble 保持"user vs assistant 卡片样式"职责,不混入 step 状态
**Alternatives considered**:
- B: step 在 MessageBubble 包 → MessageParts 失去 ToolGroup 折叠能力 (chunks 算法要下沉),职责变重
- C: Context 共享 collapsed → 过度工程,单组件 useState 已够

### 2. isStreaming prop 透传,无新 state store
**Decision**: ChatPage 算出 `isLastMessageStreaming`,沿 ChatMessages → MessageBubble → MessageParts 透传
**Rationale**: ChatPage 已持有 `isThinking`,新逻辑 `isThinking && lastMessage?.role === "assistant"` 一行可算。`StepHeader` 不读 store,父→子单向数据流,与现有 React 模式一致
**Alternatives considered**:
- React Context → 单 prop 透传不过度抽象,加 Context 反而绕
- 全局 zustand/jotai store → 项目未引入,本次不开新依赖

### 3. collapsed 状态用 userOverride pattern
**Decision**: `StepHeader` 内部 `useState<boolean | null>(null)`,`open = userOverride ?? isStreaming`。**追加规则**: 若 parts 里有 toolCall 出现在 cardStates map 中(active AskUserQuestionCard),force `open=true`,覆盖 userOverride 行为,确保 active card 始终可见。
**Rationale**: 用户点击一次后,该 turn 的折叠状态锁定,不被 `isStreaming` 后续变化覆盖;新 message 拿到新 StepHeader 实例,override=null 重置为跟随流状态。Force-open 是必要的: agent 在 ask_user_question 上 pause 等用户输入时 `isThinking=false` → `isStreaming=false` → body 会折叠 → 用户看不到 card → 卡住。Active card 时无视 collapse 是数据驱动的决策。
**Alternatives considered**:
- 只用 `useState<boolean>` → 首次 `isStreaming=false` 时 step 永远折叠,user 展开后下次 `isStreaming` 变 true 会被打回原形
- localStorage 持久化 → 跨刷新状态保留,本次不做
- 不 force-open 而是在 card active 时不包 step → 失去 step header 在 long turn 中的视觉锚点

### 4. duration 用 setInterval 1s tick 触发 re-render
**Decision**: `useReducer` + `useEffect` + `setInterval(forceTick, 1000)`,duration = `Math.floor((Date.now() - startedAt) / 1000)`
**Rationale**: 当前 turn `isStreaming=true` 时 tick 让秒数自增;`isStreaming=false` 后 tick 仍跑(不优化),但秒数继续增长体现"已过秒数"语义,简单可控
**Alternatives considered**:
- 后端算 `durationMs` 写 JSONL → 需 TUI 改写盘逻辑,扩大 scope
- useState(seconds) + tick → 一样能跑,useReducer 略省 React DevTools 噪声

### 5. 触发条件由 parts 的 type set 决定
**Decision**: `hasStepContent = parts.some(p => p.type === "thinking" || p.type === "toolCall" || p.type === "toolResult" || p.type === "image")`
**Rationale**: 0 运行时成本,纯类型判断;用户确认"有 thinking 或 tool 就包",符合预期
**Alternatives considered**:
- 所有 assistant message 都包 → 纯 text 回复也加 step 框,视觉冗余
- 只包有 toolCall 的 → thinking-only turn 不包,违背 user 决策

## Architecture

**Component tree** (改动部分标 *):

```
ChatPage
  └─ ChatMessages (turn grouping, 已有)
       └─ MessageBubble  *+isStreaming?: boolean
            ├─ MessageHeader (不变)
            ├─ MessageParts  *+isStreaming?: boolean  *+timestamp?: string  *new algorithm
            │    └─ (条件渲染) <div className="rounded-lg border ...">
            │         ├─ *StepHeader  (新组件,在 MessageParts.tsx 同文件)
            │         │    ├─ useState<boolean|null>(userOverride)
            │         │    ├─ useEffect + setInterval 1s
            │         │    └─ 渲染: status icon + text + (Xs) + chevron
            │         └─ (条件渲染) <div> body = chunks (用原算法)
            │              ├─ ThinkingItem (已有,不变)
            │              ├─ TextItem (已有,不变)
            │              └─ ToolGroup (已有,不变)
            └─ MessageFooter (不变)
```

注意: `StepContainer` / `StepBody` 是**伪组件名**用来描述 step 包裹的视觉层次,实际实现是 `MessageParts` 内的内联 `<div>` + `{open && <div>...chunks...</div>}`,不抽成独立组件。`StepHeader` 才是真组件。

**关键 type / interface**:

```ts
// MessageParts.tsx
interface MessagePartsProps {
  parts: Part[];
  cardStates?: Map<string, CardState>;
  onCardSubmit?: (id: string, value: string) => void;
  onCardCancel?: (id: string) => void;
  // 新增
  isStreaming?: boolean;
  timestamp?: string;  // ISO string from message.timestamp
}

// StepHeader (新)
interface StepHeaderProps {
  isStreaming: boolean;
  startedAt: Date;
}

// MessageBubble.tsx
interface MessageBubbleProps {
  message: Message;
  cardStates?: Map<string, CardState>;
  onCardSubmit?: (id: string, value: string) => void;
  onCardCancel?: (id: string) => void;
  // 新增
  isStreaming?: boolean;
}

// ChatPage.tsx (compute)
const lastMessage = messages[messages.length - 1];
const isLastMessageStreaming =
  isThinking && lastMessage?.role === "assistant";

// 透传
<MessageBubble message={...} isStreaming={isLastMessageStreaming} ... />
```

**`StepHeader` 实现关键代码** (受控组件, parent owns `userOverride` state):

```ts
interface StepHeaderProps {
  isStreaming: boolean;
  startedAt: Date;
  open: boolean;
  onToggle: () => void;
}

function StepHeader({ isStreaming, startedAt, open, onToggle }: StepHeaderProps) {
  const [, forceTick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const id = setInterval(forceTick, 1000);
    return () => clearInterval(id);
  }, []);
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000));
  const icon = isStreaming ? "●" : "✓";
  const iconColor = isStreaming ? "text-blue-500" : "text-green-600";
  const statusText = isStreaming ? "Executing" : "Completed";
  const chevron = open ? "▼" : "▲";
  return (
    <button
      onClick={onToggle}
      aria-expanded={open}
      className={`w-full flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-gray-50 rounded ${iconColor}`}
    >
      <span className="font-bold">{icon}</span>
      <span className="font-medium">{statusText}</span>
      <span className="text-gray-500">({seconds}s)</span>
      <span className="ml-auto text-gray-400">{chevron}</span>
    </button>
  );
}
```

Parent (`MessageParts`) owns the override state and force-open rule:

```ts
const [userOverride, setUserOverride] = useState<boolean | null>(null);
const hasActiveCard = parts.some(
  (p) => p.type === "toolCall" && cardStates?.has(p.id),
);
const open = hasActiveCard ? true : (userOverride ?? isStreaming);
// ...
<StepHeader
  isStreaming={isStreaming}
  startedAt={startedAt}
  open={open}
  onToggle={() => setUserOverride(!open)}
/>
```

**`MessageParts` chunks 新算法**:

```ts
export function MessageParts({ parts, isStreaming = false, timestamp, cardStates, onCardSubmit, onCardCancel }: MessagePartsProps) {
  if (parts.length === 0) {
    return <div className="text-xs text-gray-400 italic">(empty turn)</div>;
  }
  const hasStepContent = parts.some(
    (p) => p.type === "thinking" || p.type === "toolCall" || p.type === "toolResult" || p.type === "image"
  );

  if (!hasStepContent) {
    // 原 path: 纯 text 直接渲染
    return (
      <div className="flex flex-col gap-2">
        {parts.map((p, i) => p.type === "text" ? <TextItem key={i} part={p} /> : null)}
      </div>
    );
  }
  // 有 step content: 包裹
  const startedAt = timestamp ? new Date(timestamp) : new Date();
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 flex flex-col gap-2">
      <StepHeader isStreaming={isStreaming} startedAt={startedAt} />
      {open && (
        <div className="flex flex-col gap-2 border-t border-gray-100 pt-2">
          {chunks.map((chunk, i) => { /* 原 chunks 渲染逻辑 */ })}
        </div>
      )}
    </div>
  );
}
```

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| 过去 turn 的 duration 持续增长(几小时后显示"5h") | principles.md 已声明是 trade-off;用户接受 |
| `isStreaming` prop 漏传 → step 永远折叠 | ChatPage 必传,默认 `false` 在 MessageParts/MessageBubble 都是 fallback |
| Step 折叠时 polling 间隙不显示新 turn header | agent emit done 后 `isThinking=false`,几百 ms 内最后一条仍是上轮;新 message 一旦 poll 进来立刻有 header |
| 多 text 中间夹 tool 看起来割裂 | step body 顺序保留原 `Part[]` 顺序,内容连贯 |
| setInterval 1s tick 浪费 CPU (用户在看旧 turn) | useEffect cleanup 在 unmount 时 clearInterval;长时间 tab inactive 时 React 会降低 timer 精度,自动节能 |

## Testing Strategy
- **单元测试** (`MessageParts.test.tsx` 新增 4 case):
  - 纯 text turn 不显示 step header
  - 含 thinking + isStreaming=true → header `● Executing (Xs) ▼` + body 展开
  - 含 toolCall + isStreaming=false → header `✓ Completed (Xs) ▲` + body 折叠
  - 点击 header toggle body
- **回归测试**: 现有 21 个 MessageParts case 不变(thinking 折叠、toolCall 渲染、ToolGroup 折叠、cardStates 等)
- **集成测试**: `MessageBubble.test.tsx` 加 1 case 验证 `isStreaming` prop 透传
- **手动 smoke**:
  - 浏览器开 `http://127.0.0.1:8741`,触发一次有 thinking + tool 的 turn,确认 step 包裹正确
  - 推理中 step 展开,done 后 step 自动折叠
  - 切到旧 session,确认过去 turn step 默认折叠,header 显示近似的 Xs

## Implementation Notes

- **依赖顺序** (sdd-develop 任务拆分):
  1. `MessageParts.tsx` 加 `isStreaming` prop + 改 chunks + 加 `StepHeader` 内部组件
  2. `MessageBubble.tsx` 加 `isStreaming` prop 转发
  3. `ChatPage.tsx` 算 `isLastMessageStreaming` + 透传
  4. `MessageParts.test.tsx` 新增 4 case
- **startedAt 来源**: Message interface 已有 `timestamp: string`,在 MessageParts 顶层 props 加 `timestamp?: string` 可选,或直接从 message 传。最简:在 MessageBubble 把 `message.timestamp` 传下去,`MessageParts` 接 `startedAt: string`,内部 `new Date(startedAt)` 转换
- **关键点**: 不要在 chunks 算法里改 single/tools 分类,只把"是否要 step 包裹"的判断加在外层;chunks 算法保持不变
- **不要碰**:
  - `chat-message-rendering` spec 现有 `Part` 5 类型定义
  - `Message` interface
  - ToolGroup 内部逻辑
  - ChatMessages turn grouping
  - Markdown / AskUserQuestionCard
- **commit message** 建议: `feat(webui): wrap assistant turn in collapsible step with status + duration`

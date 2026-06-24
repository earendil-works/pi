# Verification Checklist: webui-collapsible-thinking-step

> 生成时间: 2026-06-24 | 审查者必须逐项验证并附可追溯证据
> 状态: [ ] 待验证 | [x] 通过 | [!] 失败（必须修复或记录偏差）

## 场景验证 (Scenarios)

| # | 场景 | 来源 | 验证方式 | 验证命令/步骤 | 期望结果 | 状态 |
|---|------|------|----------|--------------|---------|------|
| S1 | 含 thinking+tool+final response turn 出现 step wrapper | scenarios.md:9 | 单元测试 | `cd packages/webui/web && npx vitest --run src/components/message/MessageParts.test.tsx` → "StepHeader" case 2 (thinking+text, isStreaming=true) | 该 case 通过 | [x] |
| S2 | 推理完成 step 自动折叠 | scenarios.md:18 | 单元测试 | 同上 case 3 (toolCall + isStreaming=false) | 文本 "/x" 不在 DOM | [x] |
| S3 | 点击 header 手动展开/折叠 | scenarios.md:28 | 单元测试 | 同上 case 4 (case 3 + click header) | 点击后 "/x" 进入 DOM | [x] |
| S4 | 纯 text turn 不裹 step | scenarios.md:38 | 单元测试 | 同上 case 1 (纯 text) | "Execut"/"Completed" 文本不在 DOM | [x] |
| S5 | turn 中途被中止 | scenarios.md:48 | 单元测试 (覆盖 by case 3) | "StepHeader" case 3 (toolCall + isStreaming=false,body 折叠) — aborted turn 行为相同 | case 3 通过 | [x] |
| S6 | 推理中 turn 还未持久化 | scenarios.md:55 | 手动 + 代码审查 | tmux attach pi-web 浏览器, 触发 turn 立刻在 done 前 1s 截图。代码侧: ChatPage.tsx:632 `{isThinking && <ThinkingIndicator />}` 渲染在 ChatMessages 外,messages 列表里没新 message | ThinkingIndicator 在底部,新 message 不在 list | [x] |
| S7 | 推理完成到下次 poll 之间 | scenarios.md:64 | 手动 + 代码审查 | 浏览器观察 done → poll 间隙。代码侧: ChatPage 的 isLastMessageStreaming 在 isThinking→false 时立刻变 false (session_status_changed listener),旧 message step 切到 Completed,新 message poll 进来后 isStreaming=false | 旧 message 维持状态,新 message isStreaming=false | [x] |
| S8 | 极长 turn (>100 tool) | scenarios.md:72 | 单元测试 | MessageParts.test.tsx ToolGroup >4 case (现有 "collapses a 14-tool group behind a summary and shows it on click") | 仍通过 (不回归) | [x] |
| S9 | 纯 thinking turn 包 step | scenarios.md:78 | 单元测试 (implicit) | existing case "renders thinking header with Brain icon and 思考 label" — parts=[thinking only], step wrap 触发,isStreaming default true → body open → "思考" button 可见 | step header 存在 + 思考 button 可见 | [x] |
| S10 | 纯 tool turn 包 step | scenarios.md:86 | 单元测试 (implicit) | "StepHeader" case 3 — parts=[toolCall only], step wrap 触发,header + ToolGroup 都渲染 | step header 存在, body 内有 ToolGroup | [x] |
| S11 | 多 text 中间夹 tool 顺序保留 | scenarios.md:95 | 单元测试 (新增) | "preserves the chronological order of 5 mixed parts in the step body" case | 5 个 part 顺序渲染, final text 在 body 内 | [x] |
| S12 | 空 parts 占位符 | scenarios.md:106 | 单元测试 | existing case "shows (empty turn) placeholder when parts is empty" | 不显示 step header | [x] |
| S13 | 1h+ 旧 turn 显示 elapsed 时间 | scenarios.md:113 | 单元测试 (新增) | "renders the elapsed-since-timestamp seconds for an old completed turn" case — 1h 前 timestamp, isStreaming=false, header 含 "(3600s)" | 数字 ≥ 3595 | [x] |
| S14 | done 后 header 状态变 Completed | spec.md:58 | 单元测试 | "StepHeader" case 3 (toolCall + isStreaming=false) | "Completed" + "✓" 同时存在 | [x] |
| S15 | streaming 时 header 含 "Executing" + "●" | spec.md:50 | 单元测试 | "StepHeader" case 2 (含 thinking + isStreaming=true) | "Executing" + "●" 同时存在 | [x] |
| S16 | MessageBubble 透传 isStreaming + timestamp | spec.md:96 (implied) | 单元测试 | `npx vitest --run src/components/message/MessageBubble.test.tsx` 找 "forwards isStreaming and timestamp to MessageParts" | 该 case 通过 | [x] |
| S17 | ChatPage 算 isLastMessageStreaming | spec.md:100 | 代码审查 | ChatPage.tsx:607-608 `const lastMessage = messages[messages.length - 1]; const isLastMessageStreaming = isThinking && lastMessage?.role === "assistant";` 然后 ChatPage.tsx:638 透传到 ChatMessages → ChatMessages.tsx:121 `isStreaming={Boolean(isLastMessageStreaming) && i === turns.length - 1}` | 变量定义存在, 透传到 ChatMessages | [x] |
| S18 | 旧 message 在 active turn 中不显示 streaming | spec.md:107 | 单元测试 | `npx vitest --run src/pages/ChatPage.test.tsx` 找 "isLastMessageStreaming propagation > isLastMessageStreaming only applies to the last message" | 该 case 通过 | [x] |
| S19 | 推理完成 step 自动折叠 (transition test) | spec.md:62 | 单元测试 | "StepHeader" case 5 (transition test with rerender) | re-render 后 "y" 文本不在 DOM | [x] |
| S20 | 用户点击后 isStreaming 变化不覆盖 | spec.md:84 | 单元测试 (新增) | "preserves user override when isStreaming flips after a click" case — click during done, flip isStreaming false→true→false, body stays visible | body 持续可见 | [x] |
| S21 | active card force-open | spec.md (3.3 scenario) | 单元测试 | "force-opens the body when an active AskUserQuestionCard is present" case | 文本 "Color?" 可见 (card rendered + body open) | [x] |

## 需求验证 (Requirements)

| # | 需求 | 来源 | 验证方式 | 期望证据 | 状态 |
|---|------|------|----------|---------|------|
| R1 | Step Wrapper Trigger (有 thinking/tool 裹,纯 text/空 parts 不裹) | spec.md ADDED #1 | 单元测试 + 代码审查 | `MessageParts.tsx:327-333` `hasStepContent` 判断; S1/S4/S9/S10/S12 全部 PASS | [x] |
| R2 | Step Header Status + Duration (icon + status word + seconds + chevron) | spec.md ADDED #2 | 单元测试 | `MessageParts.tsx:274-296` StepHeader 组件渲染; S14/S15 PASS, duration 公式 `Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000))` 在 line 280; S13 (1h+ test) 验证 elapsed 时间 | [x] |
| R3 | Step Body Collapsible (streaming 默认展开,done 默认折叠,user override 锁定) | spec.md ADDED #3 | 单元测试 | `MessageParts.tsx:348` `const [userOverride, setUserOverride] = useState<boolean | null>(null)`; S1/S2/S3/S20 PASS (S20 新增 click-then-istreaming-flip 测试) | [x] |
| R4 | Streaming State Propagation (ChatPage 算 isLastMessageStreaming, 只传给最后一条) | spec.md ADDED #4 | 代码审查 + 单元测试 | `ChatPage.tsx:607-608` `isLastMessageStreaming` 定义; `ChatPage.tsx:638` 透传到 ChatMessages; `ChatMessages.tsx:121` `isStreaming={Boolean(isLastMessageStreaming) && i === turns.length - 1}`; S17/S18 PASS | [x] |

## 通过标准

- [x] 所有场景 (S1-S21) 状态为 [x]，每项有可追溯证据
- [x] 所有需求 (R1-R4) 状态为 [x]，每项有源码行号
- [x] 证据格式: R 类 → 源码文件:行号，S 类 → vitest 输出

## Review 备注

- **pre-existing 10 failures** (MemoryPage + MemoryTypeBadge): 与本 change 无关,在 base `6965fe18` 已存在 (269 pass / 10 fail);本 change 引入 +11 new tests, 全部 PASS, 0 new fails
- **force-open 设计** (spec R5 等价物): 3.3 RED + 3.4 GREEN 添加,修复 step wrapper 引入的 ask_user_question card 不可见 UX bug
- **Critical findings**: 无
- **Important findings**: 无
- **Minor findings** (已修): design.md StepHeader 代码块对齐实际 controlled 实现;补充 3 个 regression test (S11/S13/S20)

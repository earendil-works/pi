# Verification Checklist: webui-collapsible-thinking-step

> 生成时间: 2026-06-24 | 审查者必须逐项验证并附可追溯证据
> 状态格式: ` ` 待验证 | `x` 通过 | `!` 失败（必须修复或记录偏差）

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
| S11 | 多 text 中间夹 tool: inference 在 fold, text 在 fold 外 | scenarios.md:95 (修订) | 单元测试 (修订) | "preserves the order of 5 mixed parts (inference in fold, text after fold)" case — fold 内容 (思考/bash/file1) 先, text (interim-text/final-text) 后 | 5 part 顺序保留, text 在 fold 外 | [x] |
| S12 | 空 parts 占位符 | scenarios.md:106 | 单元测试 | existing case "shows (empty turn) placeholder when parts is empty" | 不显示 step header | [x] |
| S13 | 1h+ 旧 turn 显示 elapsed 时间 | scenarios.md:113 | 单元测试 (新增) | "renders the elapsed-since-timestamp seconds for an old completed turn" case — 1h 前 timestamp, isStreaming=false, header 含 "(3600s)" | 数字 ≥ 3595 | [x] |
| S14 | done 后 header 状态变 Completed | spec.md:58 | 单元测试 | "StepHeader" case 3 (toolCall + isStreaming=false) | "Completed" + "✓" 同时存在 | [x] |
| S15 | streaming 时 header 含 "Executing" + "●" | spec.md:50 | 单元测试 | "StepHeader" case 2 (含 thinking + isStreaming=true) | "Executing" + "●" 同时存在 | [x] |
| S16 | MessageBubble 透传 isStreaming + timestamp | spec.md:96 (implied) | 单元测试 | `npx vitest --run src/components/message/MessageBubble.test.tsx` 找 "forwards isStreaming and timestamp to MessageParts" | 该 case 通过 | [x] |
| S17 | ChatPage 算 isLastMessageStreaming | spec.md:100 | 代码审查 | ChatPage.tsx:607-608 `const lastMessage = messages[messages.length - 1]; const isLastMessageStreaming = isThinking && lastMessage?.role === "assistant";` 然后 ChatPage.tsx:638 透传到 ChatMessages → ChatMessages.tsx:121 `isStreaming={Boolean(isLastMessageStreaming) && i === turns.length - 1}` | 变量定义存在, 透传到 ChatMessages | [x] |
| S18 | 旧 message 在 active turn 中不显示 streaming | spec.md:107 | 单元测试 | `npx vitest --run src/pages/ChatPage.test.tsx` 找 "isLastMessageStreaming propagation > isLastMessageStreaming only applies to the last message" | 该 case 通过 | [x] |
| S19 | 推理完成 fold 自动折叠, text 仍可见 (transition test) | spec.md:62 (修订) | 单元测试 (修订) | "auto-collapses the fold when isStreaming transitions from true to false, but keeps text visible (outside fold)" case — re-render 后 "思考" 消失, "visible-reply" 仍在 DOM | fold 折叠 + text 可见 | [x] |
| S20 | 用户点击后 isStreaming 变化不覆盖 (修订: 用 toolCall 而非 text) | spec.md:84 (修订) | 单元测试 (修订) | "preserves user override when isStreaming flips after a click" case (改用 toolCall[name=read,path=/x]) — click 后 /x 出现, flip isStreaming false→true→false 保持可见 | body 持续可见 | [x] |
| S21 | active card force-open | spec.md (3.3 scenario) | 单元测试 | "force-opens the body when an active AskUserQuestionCard is present" case | 文本 "Color?" 可见 (card rendered + body open) | [x] |
| **S22** | **推理过程展开时, text 在 fold 外可见** | **scenarios.md (核心 spec, 5.x 修订)** | 单元测试 | `MessageParts.test.tsx` → "preserves the order of 5 mixed parts (inference in fold, text after fold)" case (isStreaming=true) | text "interim-text" + "final-text" 在 fold 外 sibling 位置可见 | [x] |
| **S23** | **推理过程自动折叠后, text 仍可见** | **scenarios.md (核心 spec, 5.x 修订)** | 单元测试 | `MessageParts.test.tsx` → "auto-collapses the fold when isStreaming transitions from true to false, but keeps text visible" case | fold 折叠后 "visible-reply" 仍在 DOM | [x] |
| **S24** | **纯 text turn 无 fold, text 直接渲染** | **scenarios.md (5.x 修订)** | 单元测试 | `MessageParts.test.tsx` → "renders pure text turn as a plain TextItem, no fold wrapper at all" case — parts=[{text:"hello-world"}] | text 可见 + 无 StepHeader + 无 思考 + 无 `div.rounded-lg.border` | [x] |
| **S25** | **fold 包 inference (含 toolCall), text 在 fold 外** | **scenarios.md (5.x 修订)** | 单元测试 | `MessageParts.test.tsx` → "keeps text visible when fold is collapsed (toolCall + text turn)" case — parts=[{toolCall,name:read,path:/secret}, {text:"user-visible-reply"}] | isStreaming=false 时 read + /secret 不在 DOM, "user-visible-reply" 可见 | [x] |
| **S26** | **5-part mixed turn fold 折叠后, 所有 text 仍可见** | **scenarios.md (5.x 修订)** | 单元测试 | `MessageParts.test.tsx` → "keeps all text parts visible when fold auto-collapses after a 5-part mixed turn" case — isStreaming=false 时 思考/bash/file1 不在 DOM, interim-text + final-text 可见 | fold 折叠 + 2 text 均可见 | [x] |

## 需求验证 (Requirements)

| # | 需求 | 来源 | 验证方式 | 期望证据 | 状态 |
|---|------|------|----------|---------|------|
| R1 | Step Wrapper Trigger (有 thinking/tool 裹,纯 text/空 parts 不裹) | spec.md ADDED #1 | 单元测试 + 代码审查 | `MessageParts.tsx:327-333` `hasStepContent` 判断; S1/S4/S9/S10/S12 全部 PASS | [x] |
| R2 | Step Header Status + Duration (icon + status word + seconds + chevron) | spec.md ADDED #2 | 单元测试 | `MessageParts.tsx:274-296` StepHeader 组件渲染; S14/S15 PASS, duration 公式 `Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000))` 在 line 280; S13 (1h+ test) 验证 elapsed 时间 | [x] |
| R3 | Step Body Collapsible (streaming 默认展开,done 默认折叠,user override 锁定) | spec.md ADDED #3 | 单元测试 | `MessageParts.tsx:348` `const [userOverride, setUserOverride] = useState<boolean | null>(null)`; S1/S2/S3/S20 PASS (S20 修订为用 toolCall 验证 fold visibility) | [x] |
| R4 | Streaming State Propagation (ChatPage 算 isLastMessageStreaming, 只传给最后一条) | spec.md ADDED #4 | 代码审查 + 单元测试 | `ChatPage.tsx:607-608` `isLastMessageStreaming` 定义; `ChatPage.tsx:638` 透传到 ChatMessages; `ChatMessages.tsx:121` `isStreaming={Boolean(isLastMessageStreaming) && i === turns.length - 1}`; S17/S18 PASS | [x] |
| **R5** | **Text Parts Outside Fold Wrapper (text 始终在 fold 外, 不受 fold 状态影响)** | **spec.md ADDED (5.x 修订)** | 单元测试 + 代码审查 | `MessageParts.tsx:393-446` 拆 chunks 为 `inferenceChunks` + `textChunks`; JSX 改为 Fragment, fold 包 inference, textChunks 作为 sibling 渲染; S19/S22/S23/S25/S26 全部 PASS (5 case 覆盖 text 在 fold 外场景) | [x] |

## 通过标准

- [x] 所有场景 (S1-S26) 状态为 [x]，每项有可追溯证据
- [x] 所有需求 (R1-R5) 状态为 [x]，每项有源码行号
- [x] 证据格式: R 类 → 源码文件:行号，S 类 → vitest 输出

## Review 备注

- **pre-existing 10 failures** (MemoryPage + MemoryTypeBadge): 与本 change 无关,在 base `6965fe18` 已存在 (284 pass / 10 fail);本 change 引入 +12 new tests (含修订 3 个), 全部 PASS, 0 new fails
- **force-open 设计** (spec R5 等价物): 3.3 RED + 3.4 GREEN 添加,修复 step wrapper 引入的 ask_user_question card 不可见 UX bug
- **text-outside-fold 修订** (5.x 任务): 用户反馈 final reply 在 fold 折叠后被隐藏。修订 design.md / scenarios.md / principles.md / spec.md 描述,在 `MessageParts.tsx` 拆 chunks 为 `inferenceChunks` (fold 内) + `textChunks` (fold 外 sibling)。新增 3 case (S22/S24/S25) + 修订 2 case (S11/S19) 覆盖 text 始终可见核心 spec。5-part mixed turn 测试 (S26) 验证 fold 折叠时所有 text (interim + final) 均可见
- **Critical findings**: 无
- **Important findings**: 无
- **Minor findings** (已修): design.md StepHeader 代码块对齐实际 controlled 实现;补充 3 个 regression test (S11/S13/S20);S22-S26 新增测试覆盖 text-outside-fold 行为

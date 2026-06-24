# Verification Checklist: webui-collapsible-thinking-step

> 生成时间: 2026-06-24 | 审查者必须逐项验证并附可追溯证据
> 状态: [ ] 待验证 | [x] 通过 | [!] 失败（必须修复或记录偏差）

## 场景验证 (Scenarios)

| # | 场景 | 来源 | 验证方式 | 验证命令/步骤 | 期望结果 | 状态 |
|---|------|------|----------|--------------|---------|------|
| S1 | 含 thinking+tool+final response turn 出现 step wrapper | scenarios.md:9 | 单元测试 | `cd packages/webui/web && npx vitest --run src/components/message/MessageParts.test.tsx` → 找 "StepHeader (via MessageParts)" 块 case 2 (含 thinking) | 该 case 通过 (PASS) | [ ] |
| S2 | 推理完成 step 自动折叠 | scenarios.md:18 | 单元测试 | 同上 case 3 (toolCall + isStreaming=false) | 文本 "/x" 不在 DOM (body 折叠) | [ ] |
| S3 | 点击 header 手动展开/折叠 | scenarios.md:28 | 单元测试 | 同上 case 4 (case 3 + click header) | 点击后 "/x" 进入 DOM | [ ] |
| S4 | 纯 text turn 不裹 step | scenarios.md:38 | 单元测试 | 同上 case 1 (纯 text) | "Execut"/"Completed" 文本不在 DOM | [ ] |
| S5 | turn 中途被中止 | scenarios.md:48 | 单元测试 (覆盖 by case 3) | 复用 `MessageParts.test.tsx` "StepHeader" case 3 (toolCall + isStreaming=false,body 折叠) — aborted turn 行为相同 (header 存在 + body 折叠)。`⚠` aborted icon 在 Non-Goals 外 | 该 case 通过即视为 S5 覆盖 | [ ] |
| S6 | 推理中 turn 还未持久化 | scenarios.md:55 | 手动 | tmux attach pi-web 浏览器, 触发 turn, 立刻在 done 前 1s 截图 | `ThinkingIndicator` 在底部显示,新 message 不在 list | [ ] |
| S7 | 推理完成到下次 poll 之间 | scenarios.md:64 | 手动 | tmux attach pi-web 浏览器, 观察 done → 下次 poll 之间的 ~100-300ms | 旧 message 维持原状态,新 message poll 进来后 isStreaming=false | [ ] |
| S8 | 极长 turn (>100 tool) | scenarios.md:72 | 单元测试 | `cd packages/webui/web && npx vitest --run src/components/message/MessageParts.test.tsx` 找 ToolGroup >4 case (现有) | 仍通过 (不回归) | [ ] |
| S9 | 纯 thinking turn 包 step | scenarios.md:78 | 单元测试 | 扩展 case 1: `parts = [{type:"thinking", text:"x"}]` 单独 | step header 存在 | [ ] |
| S10 | 纯 tool turn 包 step | scenarios.md:86 | 单元测试 | 扩展: `parts = [toolCall, toolResult]` 单独 | step header 存在, body 内有 ToolGroup | [ ] |
| S11 | 多 text 中间夹 tool 顺序保留 | scenarios.md:95 | 单元测试 | 扩展: `parts = [thinking, text("interim"), toolCall, toolResult, text("final")]` | step body 内 5 个 part 顺序渲染, final text 在 body 内 (不被抽出) | [ ] |
| S12 | 空 parts 占位符 | scenarios.md:106 | 单元测试 | 现有 case 验证 `(empty turn)` 文本 | 不显示 step header | [ ] |
| S13 | 1h+ 旧 turn 显示 elapsed 时间 | scenarios.md:113 | 单元测试 | 扩展: timestamp=1h 前, isStreaming=false, 验证 header 含 "(3600s)" | 数字 ≥ 3595 (允许 setInterval 漂移) | [ ] |
| S14 | done 后 header 状态变 Completed | spec.md:58 | 单元测试 | case 3 (toolCall + isStreaming=false) 验证含 "Completed" + "✓" | 文本 + icon 同时存在 | [ ] |
| S15 | streaming 时 header 含 "Executing" + "●" | spec.md:50 | 单元测试 | case 2 (含 thinking + isStreaming=true) 验证含 "Executing" + "●" | 文本 + icon 同时存在 | [ ] |
| S16 | MessageBubble 透传 isStreaming + timestamp | spec.md:96 (implied) | 单元测试 | `cd packages/webui/web && npx vitest --run src/components/message/MessageBubble.test.tsx` 找 "forwards isStreaming" case | 该 case 通过 | [ ] |
| S17 | ChatPage 算 isLastMessageStreaming | spec.md:100 | 手动 + 代码审查 | 读 `packages/webui/web/src/pages/ChatPage.tsx` ChatPage 函数体内,搜 `isLastMessageStreaming` | 变量定义存在, 透传到 ChatMessages | [ ] |
| S18 | 旧 message 在 active turn 中不显示 streaming | spec.md:107 | 单元测试 | `cd packages/webui/web && npx vitest --run src/pages/ChatPage.test.tsx` 找 "isLastMessageStreaming only applies to the last message" case | 该 case 通过 | [ ] |
| S19 | 推理完成 step 自动折叠 (transition test) | spec.md:62 | 单元测试 | `cd packages/webui/web && npx vitest --run src/components/message/MessageParts.test.tsx` 找 "StepHeader" case 5 (transition test with rerender) | re-render 后 "y" 文本不在 DOM | [ ] |

## 需求验证 (Requirements)

| # | 需求 | 来源 | 验证方式 | 期望证据 | 状态 |
|---|------|------|----------|---------|------|
| R1 | Step Wrapper Trigger (有 thinking/tool 裹,纯 text/空 parts 不裹) | spec.md ADDED #1 | 单元测试 + 代码审查 | `MessageParts.tsx` 含 `hasStepContent` 判断; S1/S4/S9/S10/S12 全部 PASS | [ ] |
| R2 | Step Header Status + Duration (icon + status word + seconds + chevron) | spec.md ADDED #2 | 单元测试 | `MessageParts.tsx` StepHeader 组件渲染; S14/S15 PASS, duration 公式 `Math.floor((Date.now() - startedAt.getTime()) / 1000)` 在 source | [ ] |
| R3 | Step Body Collapsible (streaming 默认展开,done 默认折叠,user override 锁定) | spec.md ADDED #3 | 单元测试 | `MessageParts.tsx` 含 `userOverride: useState<boolean \| null>`; S1/S2/S3 PASS | [ ] |
| R4 | Streaming State Propagation (ChatPage 算 isLastMessageStreaming, 只传给最后一条) | spec.md ADDED #4 | 代码审查 + 单元测试 | `ChatPage.tsx` 含 `isLastMessageStreaming` 定义; `MessageBubble` 透传; S17/S18 PASS | [ ] |

## 通过标准

- [ ] 所有场景 (S1-S19) 状态为 [x]，每项有可追溯证据
- [ ] 所有需求 (R1-R4) 状态为 [x]，每项有源码行号
- [ ] 证据格式: R 类 → 源码文件:行号，S 类 → vitest 输出 / chrome-devtools 截图

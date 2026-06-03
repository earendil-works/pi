# Verification Checklist: pi-webui-fixes

> 生成时间: 2026-06-02 | 审查者必须逐项验证并附可追溯证据
> 状态: [ ] 待验证 | [x] 通过 | [!] 失败(必须修复或记录偏差)

## 场景验证 (Scenarios)

| # | 场景 | 来源 | 验证方式 | 验证命令/步骤 | 期望结果 | 状态 |
|---|------|------|----------|--------------|---------|------|
| S1 | WebUI 列出当前 cwd 的真 sessions | scenarios.md 正常流程 #1 | curl + chrome-devtools | `curl -s http://127.0.0.1:8741/api/sessions \| jq 'length'` 对比 `ls ~/.pi/agent/sessions/--home-qjh-pi--/*.jsonl \| wc -l` | 数字一致 | [ ] |
| S2 | 新建 session 立刻可见 | scenarios.md 正常流程 #2 | chrome-devtools | `chrome-devtools_navigate_page` 到 `/`,点 New Chat,evaluate_script 算 React state 从 0 到 1 的时间 | <200ms | [ ] |
| S3 | 发送消息收到真 LLM 响应 | scenarios.md 正常流程 #3 | chrome-devtools | `evaluate_script` 检查 ChatPage 显示的 assistant 消息 !== "nihao" | 真 LLM 文本 | [ ] |
| S4 | 乐观删除 session | scenarios.md 正常流程 #4 | chrome-devtools | 点删除按钮,`evaluate_script` 测从点按钮到 React state 移除该 session 的耗时 | <500ms (UI 层) | [ ] |
| S5 | Cron 页面空表 | scenarios.md 正常流程 #5 | curl | `curl -s http://127.0.0.1:8741/api/cron/jobs \| jq '.jobs \| length'` | `0` | [ ] |
| S6 | LLM 抽 atoms 超时不阻塞删除 | scenarios.md 异常流程 #1 | unit-test | `cd packages/webui && timeout 30 npx vitest run server/test/sessions-routes.test.ts -t "DELETE returns within 500ms even when LLM extraction fails"` | PASS | [ ] |
| S7 | pi RPC 子进程崩溃显示错误 | scenarios.md 异常流程 #2 | unit-test | `cd packages/webui && timeout 30 npx vitest run server/test/session-pool.test.ts -t "process exit"` — mock spawnFn 返回退出的 child process | PASS,EventEmitter 发 'exit' | [ ] |
| S8 | WS 断线自动重连 | scenarios.md 异常流程 #3 | unit-test | `cd packages/webui/web && timeout 30 npx vitest run src/lib/api.test.ts -t "reconnect"` | PASS,1s 内重连 | [ ] |
| S9 | 同一 session 两个 tab | scenarios.md 异常流程 #4 | manual | 开两个 tab 同 session,A 发 prompt,B 同步看到 | 行为符合 | [ ] |
| S10 | 空 prompt 拒绝 | scenarios.md 边界 #1 | chrome-devtools | `evaluate_script` 测 `document.querySelector('button[disabled]')` 存在 | disabled | [ ] |
| S11 | prompt > 256KB 拒绝 | scenarios.md 边界 #2 | unit-test | `cd packages/webui && timeout 30 npx vitest run server/test/ws-handler.test.ts -t "256KB"` | WS 收 error 消息 | [ ] |
| S12 | 第一条消息正好 30 字 | scenarios.md 边界 #3 | unit-test | `cd packages/webui && timeout 30 npx vitest run server/test/ws-handler.test.ts -t "first 30 chars"` | title 完整 30 字 | [ ] |
| S13 | 第一条消息包含换行 | scenarios.md 边界 #4 | unit-test | 同上 -t "newline" | title 取前 30 字符(原样,含换行) | [ ] |
| S14 | cwd 没 .pi/agent/sessions | scenarios.md 边界 #5 | curl | `mkdir -p /tmp/empty-test && cd /tmp/empty-test && node --import tsx/esm server/index.ts &` 然后 `curl localhost:8741/api/sessions` | `[]` | [ ] |
| S15 | 16 session 上限 | scenarios.md 边界 #6 | unit-test | `cd packages/webui && timeout 30 npx vitest run server/test/session-pool.test.ts -t "max sessions"` | 17th prompt 抛错 | [ ] |
| S16 | 同时开两个 pi --web 进程 | scenarios.md 边界 #7 | bash | 跑两个 `node --import tsx/esm server/index.ts` 同端口,第二个退出码非 0 + 显 "port in use" | exit 1 + stderr 含 "port" | [ ] |

## 需求验证 (Requirements)

| # | 需求 | 来源 | 验证方式 | 期望证据 | 状态 |
|---|------|------|----------|---------|------|
| R1 | WebUI 列出父 cwd 的 session | spec.md ADDED #1 | code-review | `main.ts:spawn({cwd: process.cwd()})` + `session-pool.ts:62` (process.cwd() 默认) | [ ] |
| R2 | WebUI 走真 RPC 协议 (message 字段) | spec.md ADDED #2 | unit-test | `session-pool.test.ts -t "prompt writes message field"` PASS + `session-pool.ts:236` 写 `message` | [ ] |
| R3 | Session 标题 = 首条 user 消息前 30 字 | spec.md ADDED #3 | unit-test | `ws-handler.test.ts -t "setSessionName called once on first prompt"` PASS + `session-pool.test.ts -t "setSessionName"` 3 子测试 PASS | [ ] |
| R4 | DELETE 乐观化 | spec.md ADDED #4 | unit-test | `sessions-routes.test.ts -t "DELETE returns within 500ms"` PASS + `routes/sessions.ts:148` `void extractAtomsSafely(...).catch(...)` | [ ] |
| R5 | 主页为 chat-first 布局 | spec.md ADDED #5 | chrome-devtools | `/` 显空状态卡 + 左栏 session list 可见 + `/sessions` 重定向到 `/` (4.4 截图 `/tmp/webui-fixes-empty.png`) | [ ] |
| R6 | 移除 deriveTitle 改为空 title 占位 | spec.md MODIFIED #1 | code-review | `routes/sessions.ts:deriveTitle` 引用被删,新逻辑 `title: header.name ?? ""` | [ ] |
| R7 | SessionsPage 独立页已删 | spec.md REMOVED #1 | code-review | `pages/SessionsPage.tsx` 不存在 + `App.tsx` 无 `/sessions` route | [ ] |

## 通过标准

- [ ] 所有场景 (S1-S16) 状态为 [x],每项有可追溯证据
- [ ] 所有需求 (R1-R7) 状态为 [x],每项有源码行号
- [ ] 证据格式: R 类 → 源码文件:行号,S 类 → curl 输出/screenshot/测试结果
- [ ] 152 个单元测试全过(125 server + 5 new server + 18 web + 4 new web)
- [ ] `npm run check` 干净
- [ ] vite build 成功
- [ ] 4 个 E2E 截图保存到 /tmp/webui-fixes-*.png

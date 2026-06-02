# Tasks: pi-webui-fixes

> **Design:** design.md | **Base:** 08c37a0a

**Goal:** 修 5 个真实使用问题:WebUI 读真 cwd 的 session、agent 不再 echo 用户输入、DELETE 不卡、UI 改豆包式左栏、cron 清假数据。

**Architecture:** 后端 1 行字段名 + 1 个新方法(`setSessionName`)+ DELETE 改 fire-and-forget。前端 Sidebar 加 session 列表、路由 `/` 空状态 + `/session/:id` 聊天、删 SessionsPage。零 pi core 改动。

**Tech Stack:** Node 22 + tsx + express 4 + ws 8 + React 19 + react-router-dom 7 + vitest 2 + tailwind 4

## Notes

- **`依赖`** = execution order (consumed by `sdd:develop` DAG for parallel dispatch)
  - `无` — no dependency
  - `1.1, 2.3` — comma-separated task IDs that must complete first
- **后端先修**(Tasks 1.1-1.5)→ **清 cron**(Task 2.1)→ **前端重做**(Tasks 3.1-3.7)→ **E2E 验证**(Task 4.1-4.4)
- 实施时严格 TDD:写失败测试 → 跑确认失败 → 改代码 → 跑确认通过 → 提交

## 1. 后端修复 (3 文件)

- [x] 1.1 **修正 RPC prompt 字段名 (text → message)**
  - **文件**: `packages/webui/server/session-pool.ts:236` (Modify)
  - **内容**: 把 `prompt()` 方法写入 stdin 的 JSON payload 字段从 `text` 改成 `message`,其他字段保持(images 数组、sessionId)。`abort()` 等其他方法不动。
  - **验证**: `cd packages/webui && timeout 30 npx vitest run server/test/session-pool.test.ts -t "prompt writes message field"` — 新测试 mock 一个 `spawnFn`,验证 stdin 收到 `{type:"prompt", message:"hello", images:[]}`,**不**含 `text` 字段
  - **依赖**: 无
  - **前置阅读**: `packages/coding-agent/src/modes/rpc/rpc-types.ts:51` (确认真实字段名)

- [x] 1.2 **SessionPool 新增 `setSessionName` 方法 + titlesSeen 跟踪**
  - **文件**: `packages/webui/server/session-pool.ts` (Modify,新增方法 + 改 SessionState interface)
  - **内容**:
    1. `SessionState` interface 加 `titlesSeen: Set<string>`(空 Set)字段,记录已发过 set_session_name 的 sessionId
    2. `spawnIfNeeded` 创建 state 时初始化 `titlesSeen: new Set()`
    3. 在 `prompt()` 之后新增 `async setSessionName(sessionId: string, name: string): Promise<void>`,先 `await this.spawnIfNeeded(sessionId)`,向 stdin 写 `{"type":"set_session_name","id":"<corrId>","name":name}\n`,监听 stdout 直到收到 `{"type":"response","command":"set_session_name","id":"<sameCorrId>", success:true}` 才 resolve。失败 reject。5s 超时 reject。resolve/reject 后清理 stdout 监听器避免泄漏。
  - **验证**: `cd packages/webui && timeout 30 npx vitest run server/test/session-pool.test.ts -t "setSessionName"` — 3 个子测试:成功路径(mock stdout 发正确 response)、失败路径(success:false)、超时路径(无响应,5s 后 reject)
  - **依赖**: 无
  - **前置阅读**: `packages/coding-agent/src/modes/rpc/rpc-types.ts:69` (`set_session_name` 协议)

- [x] 1.3 **WS handler 在 prompt 后调 setSessionName (用 titlesSeen 去重)**
  - **文件**: `packages/webui/server/ws/handler.ts` (Modify,prompt case 末尾)
  - **内容**: 收到 `prompt` 消息并 `pool.prompt()` 之后,查 `SessionPool.getTitlesSeen(sessionId): Set<string> | undefined`,若 set 为空(表示该 session 从未设过 title),取 `text.slice(0, 30)`,调 `pool.setSessionName(sessionId, name)`,失败 console.error 不抛。setSessionName 内部会把 sessionId 加入 titlesSeen,所以第二次 prompt `getTitlesSeen(sessionId).size > 0` 时不再调。
  - **辅助**: SessionPool 加 `getTitlesSeen(sessionId): Set<string> | undefined` 公开方法(在 1.2 已初始化 titlesSeen,这里只暴露访问)
  - **验证**: `cd packages/webui && timeout 30 npx vitest run server/test/ws-handler.test.ts -t "setSessionName called once on first prompt"` — 模拟 client 发 2 次 prompt,验证 SessionPool.setSessionName 被调用 1 次,第二次不再调
  - **依赖**: 1.1, 1.2

- [x] 1.4 **DELETE 改成 fire-and-forget (不等 LLM 抽 atoms)**
  - **文件**: `packages/webui/server/routes/sessions.ts:148` (Modify)
  - **内容**: `extractAtomsSafely` 之前 `await` 改成 `void`:`void extractAtomsSafely(jsonlContent, deps).catch(err => console.error("Background atom extraction failed:", err));`,**unlink 不变**(紧接着执行)。响应立刻返 `{ok: true, atomsExtracted: undefined}` 或 `{ok: true}`。
  - **验证**: `cd packages/webui && timeout 30 npx vitest run server/test/sessions-routes.test.ts -t "DELETE returns within 500ms even when LLM extraction fails"` — mock LLMClient.extractAtoms 返回 8s 延迟 + reject,验证 DELETE 响应时间 <500ms 且 unlink 已发生
  - **依赖**: 无

- [x] 1.5 **SessionPool 单元测试 + WS 集成测试合并**
  - **文件**: `packages/webui/server/test/session-pool.test.ts`, `packages/webui/server/test/ws-handler.test.ts` (Modify)
  - **内容**: 把 1.1/1.2/1.3 写的测试和原有测试整合,确保 `npm run check` 干净。
  - **验证**: `cd packages/webui && timeout 60 npx vitest run` — 125 个原有测试 + 5 个新测试全过
  - **依赖**: 1.1, 1.2, 1.3, 1.4

## 2. Cron 数据清理

- [x] 2.1 **清 `~/.pi/agent/data/cron.json` 7 个假 job**
  - **文件**: `~/.pi/agent/data/cron.json` (直接清空,不走 git)
  - **内容**: `rm` 整个文件 或 `echo '[]' > ~/.pi/agent/data/cron.json`。验证 `GET /api/cron/jobs` 返回 `[]`。
  - **验证**: `curl -s http://127.0.0.1:8741/api/cron/jobs | jq '.jobs | length'` → `0`
  - **依赖**: 无

## 3. 前端 UI 重构 (5 文件 + 1 删)

- [x] 3.1 **api.ts SessionInfo 加 title 字段类型**
  - **文件**: `packages/webui/web/src/lib/api.ts` (Modify)
  - **内容**: `SessionInfo` interface 加 `title: string;`(必填,后端已返),`cwd?: string`(可选,调试用)。`firstUserMessage` 不需要(后端算好)。
  - **验证**: `cd packages/webui/web && timeout 30 npx vitest run src/lib/api.test.ts` — 现有 18 测试全过
  - **依赖**: 无

- [x] 3.2 **Sidebar 组件加 session 列表 + New Chat**
  - **文件**: `packages/webui/web/src/components/Sidebar.tsx` (Create)
  - **内容**: 新建组件,从 `api.listSessions()` 拉 sessions(`useEffect + useState`),用 `setInterval` 30s 刷新一次。渲染:
    - 顶部 brand `pi webui` + NavLink to `/cron`
    - 分隔线
    - "Chats" 标签
    - 滚动列表,每项 `<Link to={\`/session/\${s.id}\`}>` 显示 `s.title`(`<New Chat>` 兜底空 title),active 状态加 `bg-blue-100`
    - 底部 `<button onClick={newChat}>` 创建并 navigate
  - **验证**: `cd packages/webui/web && timeout 30 npx vitest run src/components/Sidebar.test.tsx` — 4 子测试:(1) 空列表显 "No sessions yet" (2) 有 sessions 渲染标题 (3) 点击 session 触发 onSelect prop 回调 (4) 点 New Chat 调用 onNewChat
  - **依赖**: 3.1

- [x] 3.3 **EmptyChat 组件: 主页空状态**
  - **文件**: `packages/webui/web/src/pages/EmptyChat.tsx` (Create)
  - **内容**: 新建组件,显示居中卡片"Start a new chat from the sidebar, or click + New Chat",无功能。
  - **验证**: 无 (简单组件,跳过单测,UI 验证 4.2)
  - **依赖**: 无

- [x] 3.4 **App.tsx 重写路由**
  - **文件**: `packages/webui/web/src/App.tsx` (Modify,大部分重写)
  - **内容**:
    - 删除 `import SessionsPage` 和 `import ChatPage`(从 pages 目录)
    - 路由从 `<Route path="/sessions" element={<SessionsPage />} />` + `<Route path="/chat/:id" element={<ChatPage />} />` 改成 `<Route path="/" element={<EmptyChat />} />` + `<Route path="/session/:id" element={<ChatPage />} />`
    - `Layout` 的 `Sidebar` 替换成新 Sidebar 组件(`<Sidebar />` 改为 `<SidebarShell />` 或直接 import 新的)
    - 顶栏 nav:Cron link 移到 Sidebar 内(Sidebar 顶部)
  - **验证**: `cd packages/webui/web && timeout 30 npm run build` — vite build 成功
  - **依赖**: 3.2, 3.3

- [x] 3.5 **删除 SessionsPage,改 ChatPage 路径 param**
  - **文件**: `packages/webui/web/src/pages/SessionsPage.tsx` (Delete), `packages/webui/web/src/pages/ChatPage.tsx` (Modify)
  - **内容**: 删 SessionsPage.tsx;ChatPage 路由从 `/chat/:id` 改成 `/session/:id`,内部用 `useParams<{id:string}>()` 一样。`navigate("/sessions")` 改成 `navigate("/")`。
  - **验证**: `cd packages/webui/web && timeout 30 npm run build` — 无未解析 import
  - **依赖**: 3.4

- [x] 3.6 **SessionsPage 逻辑迁移到 Sidebar 交互**
  - **文件**: `packages/webui/web/src/components/Sidebar.tsx` (Modify,扩展 3.2)
  - **内容**: Sidebar 的 New Chat 按钮:`api.createSession() → const s = await api.createSession(); navigate(\`/session/\${s.id}\`)`,乐观更新本地 list(把新 session push 到顶部)。Delete 按钮:每个 session 旁边加删除 icon,点 → `api.deleteSession(id)`,**乐观从本地 list 移除**(不等响应,失败再回滚+alert)。
  - **验证**: `cd packages/webui/web && timeout 30 npx vitest run src/components/Sidebar.test.tsx -t "delete"` — mock api.deleteSession,点删除,验证 list 立即不含该 id(不 await)
  - **依赖**: 3.5

- [x] 3.7 **SessionList 组件重构或删除**
  - **文件**: `packages/webui/web/src/components/SessionList.tsx` (Modify 或 Delete)
  - **内容**: 若 SessionsPage 删除后无引用,直接删;若有别处用,改成纯展示无路由跳转的版本。
  - **验证**: `cd packages/webui/web && timeout 30 npm run build` — 无未解析 import
  - **依赖**: 3.5

- [x] 3.8 **前端测试 + build 整合**
  - **文件**: `packages/webui/web/src/lib/api.test.ts`,所有 component test (Modify)
  - **内容**: 跑全量 web vitest + vite build,确认 18 个原有测试 + 4 个新 Sidebar 测试全过。
  - **验证**: `cd packages/webui/web && timeout 60 npx vitest run && timeout 30 npm run build` — 全过
  - **依赖**: 3.6, 3.7

## 4. E2E 浏览器验证 (4 场景)

- [ ] 4.1 **场景 1: cwd 解析 + 真 sessions 显示**
  - **文件**: 无
  - **内容**: 在 `~/pi` 跑 `./pi-test.sh --web --port 8742`,开 `chrome-devtools_new_page` 访问 `http://127.0.0.1:8742/`,截图,验证左栏 session 数与 `ls ~/.pi/agent/sessions/--home-qjh-pi--/ | wc -l` 一致。
  - **验证**: 截图保存到 `/tmp/webui-fixes-sessions.png`,显示至少 1 个真 session 卡片。
  - **依赖**: 3.8, 2.1

- [ ] 4.2 **场景 2: agent echo 修复 + 标题更新**
  - **文件**: 无
  - **内容**: 浏览器新建 chat,输入 "nihao" 回车,等 5s,验证:
    1. assistant 消息内容 ≠ "nihao"(真 LLM 响应)
    2. 左栏该 session 标题 = "nihao"
  - **验证**: 截图 `/tmp/webui-fixes-echo.png`,显示完整一轮对话 + 左栏标题已变。
  - **依赖**: 4.1

- [ ] 4.3 **场景 3: DELETE 乐观**
  - **文件**: 无
  - **内容**: 浏览器创建一个新 session,等它出现在左栏,点删除,确认弹窗,验证 200ms 内从左栏消失(用 `chrome-devtools_evaluate_script` 测时间戳)。**`/api/sessions/:id` GET 返 404**。
  - **验证**: 截图 `/tmp/webui-fixes-delete.png`,左栏 session 数 -1。
  - **依赖**: 4.2

- [ ] 4.4 **场景 4: 空 cron 页面 + 主页空状态**
  - **文件**: 无
  - **内容**: 浏览器 navigate 到 `/`,截图,验证空状态;再 navigate 到 `/cron`,截图,验证 "No scheduled jobs"。
  - **验证**: 截图 `/tmp/webui-fixes-empty.png`, `/tmp/webui-fixes-cron.png`。
  - **依赖**: 4.3

## Verification

- [ ] 全量测试: `cd packages/webui && timeout 90 npx vitest run` — 125 + 5 server + 18 + 4 web = 152 测试全过
- [ ] Lint: `cd /home/qjh/workspace/personal/pi && timeout 120 npm run check` — 干净
- [ ] 构建: `cd packages/webui/web && timeout 30 npm run build` — vite build 成功
- [ ] E2E: 4 场景全部 `/tmp/webui-fixes-*.png` 已生成
- [ ] Cron: `curl -s http://127.0.0.1:8741/api/cron/jobs | jq '.jobs | length'` → `0`

# Tasks: memory-pipeline-hardening

> **Design:** design.md | **Base:** 2a9dfb05ceab27d62318dc2c8e51dc0e82405670

**Goal:** 给 memory 管线加 CAS 冲突防护、cosine supersede 自动门、SSE 单 atom 推送、tag 双侧归一化、score 公式扩 tag_overlap + freshness 五项能力。

**Architecture:** 抽 3 个纯函数 helper(`tag-alias.ts` / `scoring.ts` / `dedup.ts`)放 `extensions/personal-assistant/`;`PersonalAssistantConfig.memory` 扩 `tagAliases` + 两个 weight 字段;`memory.ts` PATCH route 加 `If-Match` 校验 + 调 `supersedeIfSimilar` + `normalizeTags`;新增 SSE 路由用 module-level `Map<atomId, Set<Response>>` 维护订阅;`MemoryDetail.tsx` 用 `EventSource` 替 `setInterval`;`MemoryEditor.tsx` 标签输入即时归一化。

**Tech Stack:** TypeScript、Express、better-sqlite3 + sqlite-vec + FTS5、vitest、React 19 EventSource、express `res.write()` SSE。

## Notes

- **`依赖`** = execution order (consumed by `sdd-develop` DAG for parallel dispatch)
  - `无` — no dependency
  - `1.1, 2.3` — comma-separated task IDs. Comma is the ONLY delimiter.
  - Task ID format: `<section>.<task>[letter]` e.g. `1.1`, `2.3a`
- **`前置阅读`** = context only (not execution order)
- 测试隔离约定:每个 server test case 用独立 `createApp + listen(0)`,SSE 订阅表是 module-level Map,独立 app 避免 state 污染

## 1. 基础 helper(extensions 层)

- [ ] 1.1 **`normalizeTags` 实现**
  - **文件**: `extensions/personal-assistant/tag-alias.ts` (Create)
  - **内容**: 实现 `normalizeTags(input: string[], aliases?: Record<string,string>): string[]` —— trim → 空字符串过滤 → alias 折叠(用 `aliases[raw.toLowerCase()] ?? raw`)→ `new Set` 去重 → 保序。`aliases` 为空/undefined/非对象时跳过折叠,直接 Set 去重。
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/tag-alias.test.ts` 全绿
  - **依赖**: 无

- [ ] 1.2 **`computeTagOverlap` + `computeFreshness` 实现**
  - **文件**: `extensions/personal-assistant/scoring.ts` (Create)
  - **内容**: `computeTagOverlap(query: string, tags: string[], queryAliases?: Record<string,string>): number` —— split query 到 token,经 alias 折叠,求与 tags 集合交集大小 / 归一化查询 token 数,范围 [0,1]。`computeFreshness(updatedAt: number, now?: number): number` —— `Math.exp(-daysSinceUpdate / 30)`,**固定半衰期 30 天,无 importance 因子**(与 spec R4 一致);`now` 用于测试注入固定时间。
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/scoring.test.ts` 全绿
  - **依赖**: 无

- [ ] 1.3 **`supersedeIfSimilar` 抽出**
  - **文件**: `extensions/personal-assistant/dedup.ts` (Create)
  - **内容**: 实现 `supersedeIfSimilar(index: MemoryIndex, atomsDir: string, newAtom: MemoryAtom, embedding: number[] | null, threshold?: number): Promise<{status:"supersede"|"create"; atom: MemoryAtom}>` —— 复用 `extraction.ts:122-162` 的逻辑:embedding 非 null 时调 `index.findMostSimilarEmbedding(embedding, threshold ?? 0.92)`,命中则 `index.markSupersededTx` + `writeAtomToFile`,返回 supersede;否则返回 create。`buildAtomFromItem` 不能直接复用(PATCH 已有 atom),改为接受外部传入 atom。
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/dedup.test.ts` 全绿
  - **依赖**: 无

- [ ] 1.4 **`PersonalAssistantConfig.memory` 扩展字段**
  - **文件**: `extensions/personal-assistant/memory.ts` (Modify)
  - **内容**: 在 `PersonalAssistantConfig.memory`(memory.ts:67-103)里 `autoExtract?: boolean` 之后追加三个可选字段:
    ```ts
    tagAliases?: Record<string, string>;
    tagOverlapWeight?: number;     // 默认 0.10
    freshnessWeight?: number;      // 默认 0.05
    ```
  - **验证**: `npm run check` 通过(类型层);既有测试不破坏。
  - **依赖**: 无

- [ ] 1.5 **`extraction.executeItem` 重构调用 `supersedeIfSimilar`**
  - **文件**: `extensions/personal-assistant/extraction.ts` (Modify, lines 122-162)
  - **内容**: 删除 `executeItem` 里 fingerprint + cosine dedup 的内联代码,改为调用 `dedup.ts` 的 `supersedeIfSimilar`。`executeItem` 保留 fingerprint check(extract 流程专属,cheap first),把 `embedding ?? new Array(1024).fill(0)` 之后的部分挪到新 helper。既有 `extraction.test.ts` / `run-extraction.test.ts` / `lefse-regression.test.ts` 全部必须继续通过。
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/extraction.test.ts test/run-extraction.test.ts test/lefse-regression.test.ts` 全绿
  - **依赖**: 1.3

## 2. PATCH route 改造(server 层)

- [ ] 2.1 **PATCH route 加 `If-Match` 校验**
  - **文件**: `packages/webui/server/routes/memory.ts` (Modify, lines 216-288)
  - **内容**: 在 `app.patch("/api/memory/:id", ...)` handler 开头读 `req.headers['if-match']`(可能 undefined)。规则:
    - undefined → `400 {error:"missing_if_match"}`
    - `"*"` → 跳过校验(预留语义,允许 any-version 写入)
    - 不等于 `existing.version` → `409 {error:"version_conflict", current:existing}`
    - 否则继续原流程
  - **验证**: `cd packages/webui/server && node ../../../node_modules/vitest/dist/cli.js --run test/memory-routes.test.ts -t "If-Match"` 全绿(测试文件由 5.1 任务添加)
  - **依赖**: 无(路由本身改动)

- [ ] 2.2 **PATCH route 接入 supersede + tag 归一化**
  - **文件**: `packages/webui/server/routes/memory.ts` (Modify, lines 216-288)
  - **内容**: 在 If-Match 校验通过后、写入 DB 前:
    1. 调 `normalizeTags(req.body.tags ?? existing.tags, deps.settings?.memory?.tagAliases)` 得到合并后的 tags,覆盖 `mergedTags` 那行(当前 memory.ts:234-236 是 Set union,要改为先归一化再 union)
    2. 计算 `embeddableText` 后调 `embedText`(已有),然后在 `updateAtom` 前调 `supersedeIfSimilar(index, atomsDir, mergedAtom, embedding)`,如果返回 status="supersede" 则用返回的 atom 响应 200 + body 加 `previousId` 字段
    3. 如果 status="create" 则继续原 `updateAtom` 流程
  - **验证**: `cd packages/webui/server && node ../../../node_modules/vitest/dist/cli.js --run test/memory-routes.test.ts -t "supersede"` 全绿
  - **依赖**: 1.1, 1.3, 1.4

- [ ] 2.3 **SSE 订阅表 + 心跳**
  - **文件**: `packages/webui/server/routes/memory.ts` (Modify, top of file)
  - **内容**: 文件顶部声明 `const subscribers = new Map<string, Set<express.Response>>();`。导出 `subscribeAtom(id, res)` 和 `broadcastAtomUpdate(atom)` 两个 helper。`subscribeAtom` 立即发 `: connected\n\n` + 每 25s 发 `: ping\n\n`(用 `setInterval` 注册到 `res` 上,`res.on('close')` 时 `clearInterval` 并从 Set 删除)。`broadcastAtomUpdate` 在订阅表里查 id,遍历发 `event: atom\ndata: <JSON>\n\n`。
  - **验证**: 单测验证订阅表的 add/del/广播;集成测试由 5.3 任务添加。
  - **依赖**: 无

- [ ] 2.4 **新增 SSE 路由 `GET /api/memory/:id/stream`**
  - **文件**: `packages/webui/server/routes/memory.ts` (Modify)
  - **内容**: 新增 `registerStreamMemoryById(app, deps)`,handler 内 `res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders?.()`,然后调 `subscribeAtom(req.params.id, res)`,handler 末尾不 `res.end()`(保持连接)。在 `mountMemoryRoutes` 里挂载。
  - **验证**: `curl -N http://127.0.0.1:<port>/api/memory/<id>/stream` 收到 `: connected\n\n`,后续 PATCH 触发 `event: atom\n\n`。
  - **依赖**: 2.3

- [ ] 2.5 **PATCH 触发 broadcast**
  - **文件**: `packages/webui/server/routes/memory.ts` (Modify, PATCH handler)
  - **内容**: 在 PATCH handler 末尾(`res.json(mergedAtom)` 之前),若 status=create 或 supersede 都调 `broadcastAtomUpdate(mergedAtom)`。如果 atom 被 superseded(返回 status="supersede"),`broadcastAtomUpdate` 用新 atom;旧 atom 的 version 不变所以不推送。
  - **验证**: SSE 集成测试(5.3 任务)。
  - **依赖**: 2.2, 2.3

## 3. Client 改造(webui 层)

- [ ] 3.1 **`api.memory.patch` 支持自定义 headers**
  - **文件**: `packages/webui/web/src/lib/api.ts` (Modify)
  - **内容**: `api.memory.patch` 当前签名推断为 `(id: string, patch: Partial<MemoryAtom>) => Promise<MemoryAtom>`。改为 `(id: string, patch: Partial<MemoryAtom>, opts?: {ifMatch?: string|number}) => Promise<MemoryAtom>`。当 `opts.ifMatch` 提供时,fetch 调用加 `headers: {"If-Match": typeof === 'number' ? String(opts.ifMatch) : opts.ifMatch}`。失败响应按 status 抛出 `Error`(已有)。
  - **验证**: 类型层 `tsgo --noEmit` 通过。
  - **依赖**: 无

- [ ] 3.2 **`MemoryDetail.tsx` 用 EventSource 替 setInterval**
  - **文件**: `packages/webui/web/src/components/memory/MemoryDetail.tsx` (Modify, lines 53-78)
  - **内容**: 删除 `useEffect` 里的 `setInterval(fetchAtom, 3000)`(line 73)。新增 `useEffect` 创建 `new EventSource(`/api/memory/${id}/stream`)`,`onmessage` 解析 `event.data` 为 atom,仅当 `incoming.version > localAtom.version` 时 `setAtom(incoming)`(避免乱序)。`onerror` 显示"连接中断"提示但保留 `EventSource` 自动重连。`useEffect` 清理函数 `eventSource.close()`。初始 `fetchAtom()` 调用保留(拿首屏数据)。
  - **验证**: `cd packages/webui/web && node ../../../node_modules/vitest/dist/cli.js --run test/MemoryDetail.test.ts` 全绿(组件测试需更新 mock)
  - **依赖**: 无(独立)

- [ ] 3.3 **`useAutoSave` 的 PATCH 调用带 `If-Match`**
  - **文件**: `packages/webui/web/src/components/memory/MemoryDetail.tsx` (Modify, lines 80-89)
  - **内容**: `useAutoSave` 的 `onSave` callback 里 `api.memory.patch(id, diff)` 改为 `api.memory.patch(id, diff, {ifMatch: latest.version})`。catch 块识别 `err.status === 409` 时显示"远端已更新,正在刷新"并触发一次手动 `fetchAtom()` 拉新版本。
  - **验证**: MemoryDetail 测试覆盖 409 分支。
  - **依赖**: 3.1

- [ ] 3.4 **`MemoryEditor.tsx` 仅显示原始输入,归一化在 server 端**
  - **文件**: `packages/webui/web/src/components/memory/MemoryEditor.tsx` (Modify, lines 62-68)
  - **内容**: **MVP 决定: tag 归一化只在 server 端 PATCH 时执行**(`memory.ts:patch-handler` 调用 `normalizeTags`)。`MemoryEditor.tsx` 不修改,保持 `tagsText` 显示用户原始输入,server 返回的 atom.tags(已归一)在响应中回来后通过 `setLocalAtom` 覆盖 `localAtom.tags`。`MemoryEditor.tsx` 不引入 client-side `normalizeTags`,避免 server/extension/webui 三方代码重复(extension 的 tag-alias.ts 不能被 webui 引用,跨包)。
  - **验证**: 现有 MemoryEditor 测试保持全绿;不需要新测试。
  - **依赖**: 2.2(等 server 端归一化生效)

## 4. SSE 路由集成

(已经在 2.4 / 2.5 完成,这里汇总验证)

- [ ] 4.1 **SSE 路由挂载到 `mountMemoryRoutes`**
  - **文件**: `packages/webui/server/routes/memory.ts` (Modify, mountMemoryRoutes)
  - **内容**: 在 `mountMemoryRoutes` 函数里 `registerStreamMemoryById(app, deps);` 调用,确保 SSE 路由被挂载。
  - **验证**: `curl -N http://127.0.0.1:<port>/api/memory/<id>/stream` 返回 `text/event-stream` 响应。
  - **依赖**: 2.4

## 5. 测试与验证

- [ ] 5.1 **新增 CAS 测试到 `memory-routes.test.ts`**
  - **文件**: `packages/webui/server/test/memory-routes.test.ts` (Modify)
  - **内容**: 在文件末尾新增 `describe("PATCH /api/memory/:id CAS", ...)` 块,覆盖:
    - 缺 `If-Match` 头 → 400 `{error:"missing_if_match"}`
    - `If-Match` 等于 existing.version → 200 + 新 atom
    - `If-Match` 不等于 existing.version → 409 `{error:"version_conflict", current:...}`
    - `If-Match: "*"` → 200(预留 any-version)
  - **验证**: 任务命令运行该 describe 全绿。
  - **依赖**: 2.1

- [ ] 5.2 **新增 supersede + tag 归一化测试到 `memory-routes.test.ts`**
  - **文件**: `packages/webui/server/test/memory-routes.test.ts` (Modify)
  - **内容**: 新增 `describe("PATCH /api/memory/:id dedup", ...)` 块:
    - 先 PATCH 创建 atom A(cosine baseline)
    - 再 PATCH 创建 atom B 与 A cosine > 0.92(用 charBag mock 已知字符串 cosine=1.0)
    - 验证 atom A `is_latest=0`,B `is_latest=1`,B 继承 A 的 strength/access_count
    - 单独 describe 测 tag 归一化:settings.tagAliases={"代码规范":"code-style"} 时 PATCH 带 tags=["代码规范"],DB 存的 tags=["code-style"]
  - **验证**: 任务命令运行该 describe 全绿。
  - **依赖**: 2.2

- [ ] 5.3 **新增 SSE 集成测试**
  - **文件**: `packages/webui/server/test/memory-routes.test.ts` (Modify)
  - **内容**: 新增 `describe("GET /api/memory/:id/stream", ...)` 块:
    - 客户端 A 用 fetch + readable stream 解析 SSE
    - 客户端 B PATCH 同一 atom
    - 验证 A 收到 `event: atom\ndata: {...}\n\n`
    - 用 `vi.useFakeTimers` 测心跳(把订阅表内部 `setInterval(..., 25_000)` 临时调小到 100ms,或暴露为可注入常量)
  - **验证**: 任务命令运行该 describe 全绿。
  - **依赖**: 2.5

- [ ] 5.4 **既有 `hybrid-recall.test.ts` score 断言调整**
  - **文件**: `extensions/personal-assistant/test/hybrid-recall.test.ts` (Modify)
  - **内容**: 既有断言形如 `expect(r.score).toBeCloseTo(0.85, 2)` 需要在 `tagOverlap=0, freshness ≈ 0.0001`(刚更新的 atom)时仍然近似。`freshness` 默认半衰期 30 天,刚更新的 atom `freshness ≈ exp(-0/30) = 1.0` → `0.05 * 1.0 = 0.05` 的额外贡献。**调整策略**: 测试 fixture 用 `updated_at = Date.now()`(默认新),所以 score 会增加 ~0.05。需把所有 score 断言的 `toBeCloseTo` 值上调 0.05(或者把 fixture 的 `updated_at` 设为 1 年前使 freshness ≈ 0 保留原值)。决定:加 fixture helper `makeAtomWithFreshness(updatedAt)` 控制测试场景。
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/hybrid-recall.test.ts` 全绿。
  - **依赖**: 1.2

- [ ] 5.5 **新单元测试 `tag-alias.test.ts`**
  - **文件**: `extensions/personal-assistant/test/tag-alias.test.ts` (Create)
  - **内容**: 覆盖:输入 `[" 代码规范 ", "", "code-style"]` → `["代码规范","code-style"]`;alias map `{"代码规范":"code-style","coding-rule":"code-style"}` 输入 `["代码规范","coding-rule","code-style"]` → `["code-style"]`;aliases=undefined / null / 非对象时跳过折叠。
  - **验证**: 见 1.1 任务命令。
  - **依赖**: 1.1

- [ ] 5.6 **新单元测试 `scoring.test.ts`**
  - **文件**: `extensions/personal-assistant/test/scoring.test.ts` (Create)
  - **内容**: `computeTagOverlap`:query="code-style eslint",tags=["code-style","test"] → 0.5;tags=[] → 0;query="",tags=["x"] → 0;alias 折叠覆盖。`computeFreshness(updatedAt, now=Date.now())`:updatedAt=now → exp(0) = 1.0;updatedAt=30 天前 → exp(-1) ≈ 0.368;updatedAt=90 天前 → exp(-3) ≈ 0.050。
  - **验证**: 见 1.2 任务命令。
  - **依赖**: 1.2

- [ ] 5.7 **新单元测试 `dedup.test.ts`**
  - **文件**: `extensions/personal-assistant/test/dedup.test.ts` (Create)
  - **内容**: 用 charBag mock embedder,两个 atom 内容 cosine=1.0 时 supersede;cosine=0.5 时 create;embedding=null 时 create(graceful degradation);threshold 参数覆盖。
  - **验证**: 见 1.3 任务命令。
  - **依赖**: 1.3

## 6. 最终验证

- [ ] 6.1 **全量 type check + lint**
  - **验证**: `npm run check`(全输出,无 tail)
  - **依赖**: 5.1, 5.2, 5.3, 5.4

- [ ] 6.2 **server 集成测试**
  - **验证**: `cd packages/webui/server && node ../../../node_modules/vitest/dist/cli.js --run test/memory-routes.test.ts`(全绿)
  - **依赖**: 5.1, 5.2, 5.3

- [ ] 6.3 **extension 单元测试**
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/`(全绿,含既有 extraction/search/decay/storage 测试)
  - **依赖**: 1.5, 5.4, 5.5, 5.6, 5.7

## Verification
- [ ] 全量测试: `./test.sh` + `cd packages/webui/server && node ../../../node_modules/vitest/dist/cli.js --run test/` + `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/`
- [ ] Lint + typecheck: `npm run check`
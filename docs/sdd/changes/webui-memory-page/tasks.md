# Tasks: webui-memory-page

> **Design:** design.md | **Base:** 378d3f13

**Goal**: WebUI 加 `/memory` 页面,让用户浏览/编辑/归档 Agent 持久化记忆,跑真实 pipeline 的召回测试。

**Architecture**: 在 `extensions/personal-assistant` 把 `MemoryIndex` / `searchAtoms` / `writeAtomToFile` 等升级为 public API,新增 `getAllAtoms` / `rewriteQueryWithCallLlm` / `searchAtomsWithScores` / `invalidateEmbedding` 四个 server-friendly helper;`packages/webui/server` 新增 REST 路由读写 `memory.db`;React 端组装 list / detail / editor / search tester 组件,3s debounce + 路由 unmount 强制 flush 的 `useAutoSave` hook。

**Tech Stack**: Node 20 + `node:sqlite`(Bun 自动降级到 `bun:sqlite`),Express 4.21,React 18 + Vite 5,vitest 2.1,TypeScript 5.9。

## Notes

- **`依赖`** = execution order (consumed by `sdd-develop` DAG for parallel dispatch)
  - `无` — no dependency
  - `1.1, 2.3` — comma-separated task IDs that must complete first
  - **Task ID format:** `<section>.<task>[letter]` where letter is single lowercase char
- **Section 2 顺序约束**: 2.2-2.7 都改同一文件 `routes/memory.ts`,**为避免合并冲突(并行改同一文件)刻意串行**;并非逻辑依赖。如果实现者愿意,可以拆成每个任务一个独立 file patch,允许 2.6/2.7 并行,但 v1 简单起见串行
- **Section 4 部分可并行**: 4.1/4.3/4.4 互不依赖(分别改 3 个不同的 tsx 文件),可与 4.2 并行;但本任务表保守按线性顺序列,实际跑 sdd-develop 时 sub-agent 调度决定
- **TDD inside each task**: 写失败测试 → 跑确认 RED → 实现 → 跑确认 GREEN → commit
- **测试运行**: 个人助理测试 `node ../../node_modules/vitest/dist/cli.js --run test/<file>.test.ts`(从 extension 包根);webui server 测试同命令从 `packages/webui`(已配 vitest.config)
- **范围外**(明确不做):create/delete atom、编辑后立即重算 embedding、TUI↔webui WebSocket 实时同步、版本历史、bulk 操作、`$EDITOR` 集成、slug 冲突修复(已有 bug,v2)

## 1. 基础:personal-assistant 公共 API

- [x] 1.1 **导出 `MemoryIndex` / `MemoryAtom` / `MemoryAtomType` 类型与已有函数**
  - **文件**: `extensions/personal-assistant/memory.ts` (Modify)
  - **内容**: 把 `interface MemoryAtom`(line 35)、`type MemoryAtomType`(line 26)、`class MemoryIndex`(line 416)、`function writeAtomToFile`(line 728)、`function readAtomFromFile`(line 657)、`function searchAtoms`(line 970)、`function rewriteQuery`(line 786)、`const ATOMS_DIR`(line 135)、`const MEMORY_DB_PATH`(line 134) 全部加 `export` 关键字。**不改任何函数体/逻辑,只加 export 前缀**。改完跑 `tsgo --noEmit` 确认编译通过
  - **验证**: `cd /home/qjh/workspace/personal/pi && npx tsgo --noEmit -p packages/webui/tsconfig.json 2>&1 | head -20` 应无 TS 错误(此任务只加 export,不应有 type error)
  - **依赖**: 无

- [x] 1.2 **新增 `getAllAtoms(index)` standalone helper**
  - **文件**: `extensions/personal-assistant/memory.ts` (Modify)
  - **内容**: 在 module scope(不是 class 内)新增 `function getAllAtoms(index: MemoryIndex): MemoryAtom[]`,等价于 `index.getAllRows()`(line 647)后通过 `(rowToAtom as any).call(index, row)` 转换(或新写一个 public `getAllAtoms` class 方法 + 一个 module-level wrapper `getAllAtoms(index) => index.getAllAtoms()`)。**关键:这是 module-level 函数(可独立 export 和 import),不是仅 class 方法**——因为 server 端 route 会写 `import { getAllAtoms } from "..."; getAllAtoms(idx)`,需要 free function。位置:紧跟 `searchAtoms` 之后(模块层,非类内)
  - **验证**: `cd /home/qjh/workspace/personal/pi/extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/memory-exports.test.ts` 跑 RED → 实现 → 跑 GREEN
  - **依赖**: 1.1

- [x] 1.3 **新增 `MemoryIndex.invalidateEmbedding(id)` 方法**
  - **文件**: `extensions/personal-assistant/memory.ts` (Modify)
  - **内容**: 在 `class MemoryIndex` 上新增 public 方法 `invalidateEmbedding(id: string): void`,执行 `db.prepare("DELETE FROM memory_embeddings WHERE id = ?").run(id)`,内部用 `this.ensureDb()` 拿 db 句柄。位置:紧跟 `upsertEmbedding`(line 516)之后。**不 export `db` 字段**——保持封装
  - **验证**: 同 1.2,新增 `invalidateEmbedding` 测试条目
  - **依赖**: 1.1

- [x] 1.4 **新增 `rewriteQueryWithCallLlm(callLlm, query, config)` helper**
  - **文件**: `extensions/personal-assistant/memory.ts` (Modify)
  - **内容**: 复制 `rewriteQuery`(line 786-840)的 LLM 路径,**把 `ctx.modelRegistry` 调 LLM 替换成 `callLlm(prompt)` 回调**;配置读取(`getMemoryConfig`)、prompt 构造(`buildRewritePrompt`)、JSON 解析(`parseRewriteJson`)、降级(`simpleKeywordExtraction`)全部复用。返回 `Promise<QueryRewriteResult>`。LLM 抛错时降级到 `simpleKeywordExtraction(query)`(line 771)。位置:紧跟 `rewriteQuery` 之后
  - **验证**: 同 1.2,新增 `rewriteQueryWithCallLlm` 测试条目(正常 LLM 返回 + 抛错降级两条)
  - **依赖**: 1.1

- [x] 1.5 **新增 `searchAtomsWithScores(index, query, topK)` helper**
  - **文件**: `extensions/personal-assistant/memory.ts` (Modify)
  - **内容**: 复制 `searchAtoms`(line 970-1042)的候选打分逻辑,函数签名改为
    ```typescript
    async function searchAtomsWithScores(
      index: MemoryIndex,
      query: QueryRewriteResult,
      topK: number,
    ): Promise<{
      results: Array<{ atom: MemoryAtom; fts_score: number; cosine_score: number; hybrid_score: number }>;
      embedding_available: boolean;
    }>
    ```
    每条结果带三个分项分数;`embedding_available` = `embeddingResults.size > 0`。FTS-only 分支时 `cosine_score = 0`、hybrid 公式用纯 FTS 路径(line 1001)。文件读正文(line 1026-1041)照搬
  - **验证**: 同 1.2,新增 `searchAtomsWithScores` 测试条目(有 embedding + 无 embedding 两条)
  - **依赖**: 1.1

- [x] 1.5b **plumb config 到 `searchEmbeddings` + `searchAtomsWithScores` (review fix)**
  - **文件**: `extensions/personal-assistant/memory.ts` (Modify), `extensions/personal-assistant/test/memory-exports.test.ts` (Modify)
  - **内容**: 把 `searchEmbeddings` 改为 `async function searchEmbeddings(index: MemoryIndex, queryText: string, candidateIds: string[], config?: PersonalAssistantConfig)`,把 `const config = loadConfig()`(line 977)替换为 `const config = passedConfig ?? loadConfig()`。把 `searchAtomsWithScores` 改为 `async function searchAtomsWithScores(index: MemoryIndex, query: QueryRewriteResult, topK: number, config?: PersonalAssistantConfig)`,把传入的 config 转发给 `searchEmbeddings`。`searchAtoms` 调用 `searchEmbeddings` 处也补一个 undefined 即可(向后兼容)。这样:
    - 测试 1 hermetic: 测试显式传 `config: { memory: { embedding: { provider: "local", model: "nomic-embed-text" } } }`,不再依赖 `~/.pi/agent/settings.json`
    - Server 端 level 2 task 2.6: 调用 `searchAtomsWithScores(idx, rewritten, topK, deps.settings)`,server 决定走哪条 embedding 配置
  - **验证**: `cd /home/qjh/workspace/personal/pi/extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/memory-exports.test.ts` 8 个测试都过;`HOME=/tmp/empty-home` 跑同一个命令也全过
  - **依赖**: 1.5

- [x] 1.6 **`extensions/personal-assistant/index.ts` re-export 新增 symbols**
  - **文件**: `extensions/personal-assistant/index.ts` (Modify)
  - **内容**: 在 `export { runMemoryExtraction };` 那一行(line 14)下方加:
    ```typescript
    export {
      MemoryIndex,
      writeAtomToFile,
      readAtomFromFile,
      searchAtoms,
      rewriteQuery,
      getAllAtoms,
      rewriteQueryWithCallLlm,
      searchAtomsWithScores,
    } from "./memory.ts";
    export type { MemoryAtom, MemoryAtomType } from "./memory.ts";
    export { ATOMS_DIR, MEMORY_DB_PATH } from "./memory.ts";
    ```
    类型 export 和 value export 严格分开(TS 规则)
  - **验证**: `cd /home/qjh/workspace/personal/pi/packages/webui && npx tsgo --noEmit 2>&1 | head -20` 应无 TS 错误;`grep -E "^export" extensions/personal-assistant/index.ts` 至少 8 行
  - **依赖**: 1.1, 1.2, 1.3, 1.4, 1.5

- [x] 1.7 **个人助理新 helper 单测文件**
  - **文件**: `extensions/personal-assistant/test/memory-exports.test.ts` (Create)
  - **内容**: 覆盖以下 8 条单测(先 RED 后 GREEN,每个测试独立 `mkdtempSync` + `MemoryIndex(dbPath)` + `init()` + 收尾 `close()` + `rmSync`):
    1. `getAllAtoms` 返回含 archived 的全量
    2. `MemoryIndex.invalidateEmbedding` 删除对应行
    3. `writeAtomToFile(atom, customBaseDir)` 写到指定位置
    4. `writeAtomToFile` 已存在文件时 tmp+rename 覆盖不报错
    5. `rewriteQueryWithCallLlm` 正常 LLM 返回 → parse `{"keywords":[...]}` → keywords 数组
    6. `rewriteQueryWithCallLlm` `callLlm` 抛错 → 降级 `simpleKeywordExtraction`
    7. `searchAtomsWithScores` 有 embedding 候选时 `embedding_available: true`、每条带 fts/cosine/hybrid
    8. `searchAtomsWithScores` 无 embedding(`embConfig.provider !== "local"` 或 `searchEmbeddings` 返回空 Map)时 `embedding_available: false`、纯 FTS 分支
    `callLlm` mock 用 `vi.fn().mockResolvedValue('{"keywords":["x"],"target_types":["preference"]}')` 和 `vi.fn().mockRejectedValue(new Error("LLM down"))`。ts-imports check 要求相对 import,所以 `import { ... } from "../memory.ts"`
  - **验证**: `cd /home/qjh/workspace/personal/pi/extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/memory-exports.test.ts` 8 个测试全绿
  - **依赖**: 1.2, 1.3, 1.4, 1.5

- [x] 1.8 **个人助理 + 根目录 `npm run check`**
  - **文件**: 无(纯命令)
  - **内容**: 跑 `cd /home/qjh/workspace/personal/pi && npm run check` 全过,无 biome / tsgo / shrinkwrap / browser-smoke / pinned-deps / ts-imports 报错
  - **验证**: 命令退出码 0
  - **依赖**: 1.7

## 2. Server:memory REST 路由

- [x] 2.1 **`packages/webui/server/routes/memory.ts` 路由骨架**
  - **文件**: `packages/webui/server/routes/memory.ts` (Create)
  - **内容**: 写 `mountMemoryRoutes(app, deps: { dbPath: string; atomsDir: string; settings: PersonalAssistantConfig; callLlm: (prompt: string) => Promise<string> })` 函数,先在函数体里 6 个 `app.get`/`app.patch`/`app.post` 占位返回 501(便于先建好路由表,后续子任务填实)。导入从 `@earendil-works/pi-personal-assistant` 拿 `MemoryIndex, MemoryAtom, writeAtomToFile, readAtomFromFile, getAllAtoms, rewriteQueryWithCallLlm, searchAtomsWithScores, ATOMS_DIR, MEMORY_DB_PATH`;从 `node:fs` 拿 `unlinkSync`;从 `node:os` 拿 `homedir`(不用,因 deps 传路径)。**TDD**:先写 `packages/webui/server/test/memory-routes.test.ts` 第一个测试"6 路由都返回 501 + route 路径正确",再实现
  - **验证**: `cd /home/qjh/workspace/personal/pi/packages/webui && node ../../node_modules/vitest/dist/cli.js --run test/memory-routes.test.ts` 单测绿
  - **依赖**: 1.6

- [x] 2.2 **实现 `GET /api/memory`(list + filter)**
  - **文件**: `packages/webui/server/routes/memory.ts` (Modify)
  - **内容**: 替换 2.1 里的 list 路由占位。逻辑:
    ```typescript
    const idx = new MemoryIndex(deps.dbPath);
    await idx.init();
    try {
      const all = getAllAtoms(idx);
      const archivedMode = String(req.query.archived ?? "active");
      let filtered: MemoryAtom[] = archivedMode === "all"
        ? all
        : all.filter((a) => archivedMode === "archived" ? a.archived : !a.archived);
      // type 多选: ?type=preference,workflow
      // tag 单选: ?tag=foo
      // q 搜 title/摘要: ?q=foo
      // limit/offset: ?limit=200&offset=0
      // list 不读 .md 正文
      res.json(filtered);
    } finally { idx.close(); }
    ```
    顺序:archived filter → type filter → tag filter → q filter → sort(默认 `updated_at` desc)→ limit/offset
  - **验证**: 单测加 3 条:active 默认(archived=0 出现,archived=1 不出现)、`?archived=all` 全显示、`?type=preference&archived=active` 双重过滤
  - **依赖**: 2.1

- [x] 2.3 **实现 `GET /api/memory/:id`(读 .md 正文)**
  - **文件**: `packages/webui/server/routes/memory.ts` (Modify)
  - **内容**: 替换 detail 路由占位。`getAtom(id)` → 不存在 404;`file_path` 存在时 `try { readAtomFromFile(file_path, content_hash) } catch { /* memory-error: file 丢失 / hash 错位 */ atom.content = "" }`;读出后 `atom.content = fromFile.content`;`res.json(atom)`
  - **验证**: 单测加 4 条:存在返回完整 atom、不存在 404、file 丢失返回 `content: ""`、file hash 错位返回 `content: ""`
  - **依赖**: 2.2

- [x] 2.4 **实现 `PATCH /api/memory/:id`(复用 writeAtomToFile + 清 embedding)**
  - **文件**: `packages/webui/server/routes/memory.ts` (Modify)
  - **内容**: 替换 PATCH 路由占位。逻辑:
    1. `getAtom(id)` 不存在 404
    2. 从磁盘读 `currentBody`(file 丢失 / hash 错位 → `currentBody = ""`)
    3. `merged = { ...existing, ...req.body, content: req.body.content ?? currentBody, version: existing.version + 1, updated_at: new Date().toISOString() }`
    4. `const { filePath: newPath, contentHash: newHash } = writeAtomToFile(merged, deps.atomsDir)`
    5. 旧路径不同则 `unlinkSync(existing.file_path)`
    6. `merged.file_path = newPath; merged.content_hash = newHash`
    7. `idx.upsertAtom(merged)` → `idx.invalidateEmbedding(merged.id)` → `res.json(merged)`
  - **验证**: 单测加 6 条:改 title、只改 metadata(不传 content,body 字节级保持)、改 content 触发 .md 重写 + hash 变 + 旧文件 unlink、importance 边界 0/1、type 改 → file_path 跟着变、不存在 id 404
  - **依赖**: 2.3

- [x] 2.5 **实现 `POST /api/memory/:id/archive`(toggle)**
  - **文件**: `packages/webui/server/routes/memory.ts` (Modify)
  - **内容**: 替换 archive 路由占位。`getAtom(id)` 不存在 404;`req.body.archived` true → `markArchived(id)`;false → `upsertAtom({ ...atom, archived: false, version: atom.version + 1, updated_at: nowISO() })`;`res.json({ ok: true, atom: idx.getAtom(id) })`
  - **验证**: 单测加 2 条:archive 已 active atom(archived=1)、restore archived atom(archived=0,version+1)
  - **依赖**: 2.4

- [x] 2.6 **实现 `POST /api/memory/search`(真实 pipeline)**
  - **文件**: `packages/webui/server/routes/memory.ts` (Modify)
  - **内容**: 替换 search 路由占位。`const rewritten = await rewriteQueryWithCallLlm(deps.callLlm, query, deps.settings); const { results, embedding_available } = await searchAtomsWithScores(idx, rewritten, topK ?? 10); res.json({ rewritten, embedding_available, results })`。注意:虽然 `callLlm` 已经传入,但 PATCH 一样在 `try/finally` 里 close
  - **验证**: 单测加 3 条:正常召回(callLlm 返回有效 JSON)、callLlm 抛错降级 `simpleKeyword` 仍 200、0 atom 返回 `{results: [], embedding_available: false}`
  - **依赖**: 2.5

- [x] 2.7 **实现 `GET /api/memory/stats`**
  - **文件**: `packages/webui/server/routes/memory.ts` (Modify)
  - **内容**: 替换 stats 路由占位。`getAllAtoms(idx)` → 累计 `byType` 计数 + `archivedCount`;`res.json({ total: all.length, archived: archivedCount, byType })`
  - **验证**: 单测加 2 条:空 DB 返回 `{total:0, archived:0, byType:{}}`、3 个不同 type 正确分类
  - **依赖**: 2.6

- [x] 2.8 **`createApp` mount 路由**
  - **文件**: `packages/webui/server/index.ts` (Modify)
  - **内容**: 在 `mountSessionsRoutes(app, sessionPool, { callLlm, settings });`(line 240)下方加:
    ```typescript
    import { mountMemoryRoutes } from "./routes/memory.ts";
    import { ATOMS_DIR, MEMORY_DB_PATH } from "@earendil-works/pi-personal-assistant";
    // ...
    mountMemoryRoutes(app, {
      dbPath: MEMORY_DB_PATH,
      atomsDir: ATOMS_DIR,
      settings,
      callLlm,
    });
    ```
    import 放文件顶部。顺序:`mountMemoryRoutes` 必须放在 `mountSessionsRoutes` 之后、`mountStatic`(catch-all)之前(参考 design.md Decision 1 的 mount 顺序约束)
  - **验证**: `cd /home/qjh/workspace/personal/pi && npm run check` 全过;单测 `node ../../node_modules/vitest/dist/cli.js --run test/index.test.ts` 仍绿(确认 createApp mount 顺序没破坏)
  - **依赖**: 2.7

- [x] 2.9 **回归:`runMemoryExtraction` 流程不变**
  - **文件**: 无(纯命令)
  - **内容**: 跑 `node ../../node_modules/vitest/dist/cli.js --run test/sessions-routes.test.ts` 全绿,特别是 `(g1)`/`(f1)` 这些 spy `runMemoryExtraction` 的测试,确认 export 列表扩充没破坏签名
  - **验证**: sessions-routes 单测全绿
  - **依赖**: 2.8

## 3. 客户端基础

- [x] 3.1 **`api.ts` memory namespace**
  - **文件**: `packages/webui/web/src/lib/api.ts` (Modify)
  - **内容**: 在文件末尾追加:
    ```typescript
    export interface MemoryAtom { id: string; type: MemoryAtomType; ... /* 同后端 */ }
    export type MemoryAtomType = "constraint" | "preference" | ...;
    export interface MemoryAtomWithScores { atom: MemoryAtom; fts_score: number; cosine_score: number; hybrid_score: number; }
    export interface MemorySearchResult { rewritten: { keywords: string[]; target_types: string[]; raw_query: string }; embedding_available: boolean; results: MemoryAtomWithScores[]; }
    // 在 api 对象上加:
    memory: {
      list(params?: { type?: string; archived?: "active"|"archived"|"all"; tag?: string; q?: string; limit?: number; offset?: number }): Promise<MemoryAtom[]>;
      get(id: string): Promise<MemoryAtom>;
      patch(id: string, partial: Partial<MemoryAtom>): Promise<MemoryAtom>;
      archive(id: string, archived: boolean): Promise<{ ok: true; atom: MemoryAtom }>;
      search(query: string, topK?: number): Promise<MemorySearchResult>;
      stats(): Promise<{ total: number; archived: number; byType: Record<string, number> }>;
    }
    ```
    实现:用 `fetch(\`/api/memory?...\`)` 等标准 fetch 模式,与 `api.sessions` / `api.cron` 风格一致
  - **验证**: `cd /home/qjh/workspace/personal/pi && npm run check` 全过(TS 编译过)
  - **依赖**: 2.9

- [x] 3.2 **`useAutoSave` hook**
  - **文件**: `packages/webui/web/src/lib/useAutoSave.ts` (Create)
  - **内容**: 实现 design.md 架构章节伪代码里的 hook。3s debounce,unmount cleanup 取消 timer + await in-flight 200ms 兜底超时;`state` 状态机 idle/dirty/saving/saved/error。导出 `{state, lastSaved, flushNow}`。`flushNow` 在 unmount 期间被外部用 `useRef` 持有以便显式 await。用 `useRef<boolean>` 持有 `mounted` 标志位避免 setState on unmounted(React 18+ 警告)
  - **验证**: 写 `packages/webui/web/src/lib/useAutoSave.test.ts`(用 vitest + React Testing Library 或者直接测试纯函数 `computeNextState`)覆盖 4 个状态:debounce 触发、flush 触发、error 状态、cleanup 200ms 兜底
  - **依赖**: 3.1

## 4. 客户端组件

- [x] 4.1 **`MemoryTypeBadge` 组件**
  - **文件**: `packages/webui/web/src/components/memory/MemoryTypeBadge.tsx` (Create)
  - **内容**: 7 种 type 各自颜色 chip:constraint=red,preference=blue,workflow=purple,knowledge=green,event=amber,solution=indigo,insight=pink。Props: `{type: MemoryAtomType}`。复用 webui 现有 `Badge`-ish 风格(`bg-{color}-100 text-{color}-800 rounded px-2 py-0.5 text-xs`)
  - **验证**: vitest 渲染 7 个 type 各 1 次,断言 className 含正确颜色
  - **依赖**: 3.1

- [x] 4.2 **`MemoryList` 组件**
  - **文件**: `packages/webui/web/src/components/memory/MemoryList.tsx` (Create)
  - **内容**: Props: `{atoms: MemoryAtom[]; selectedId?: string; onSelect: (id) => void; onArchive: (id) => void; filters: {type, archived, tag, q}; onFilterChange: (f) => void}`。渲染顶部过滤栏(type 多选 chips、archived radio[active/archived/all]、tag input、q input、Refresh 按钮),下方卡片列表(每行 `MemoryTypeBadge` + title + `str=X.XX imp=X.XX last=Nh ago` + 选中高亮 + 右键或 hover 显示 Archive 按钮)
  - **验证**: vitest + RTL 渲染 5 atom 列表,断言 type filter 切换后过滤正确
  - **依赖**: 4.1

- [x] 4.3 **`MemorySearchTester` 组件**
  - **文件**: `packages/webui/web/src/components/memory/MemorySearchTester.tsx` (Create)
  - **内容**: 折叠面板(`<details>` 即可,无需动画)。展开后:query input + Search 按钮、结果区显示 `keywords` chips + `target_types` chips + `embedding_available` 标签(不可用时显示"embedding unavailable"灰底)+ 结果列表,每行 `MemoryTypeBadge` + title + hover 显示 `{fts: 0.8, cos: 0.6, hybrid: 0.71, str: 0.9, imp: 0.7}`,点击跳到 detail
  - **验证**: vitest + RTL 模拟 `api.memory.search` 返回 mock,断言结果渲染 + 分数 tooltip 出现
  - **依赖**: 3.1, 4.1

- [x] 4.4 **`MemoryEditor` 组件(metadata + body)**
  - **文件**: `packages/webui/web/src/components/memory/MemoryEditor.tsx` (Create)
  - **内容**: Props: `{atom: MemoryAtom; onSave: (patch: Partial<MemoryAtom>) => Promise<void>; onArchive: () => void}`。上半 metadata form:title input、type select、importance slider(0-1,step 0.05)、tags chip input、summary textarea。下半 body editor:Edit/Preview tab(Edit 是 textarea 60vh + 内部滚动,Preview 用 webui 现有 `Markdown` 组件渲染)。所有字段改动汇聚成 `patch: Partial<MemoryAtom>`,传给父组件传入的 `onSave`。**注意:本任务不调 `useAutoSave`**,由父组件 `MemoryDetail` 决定 debounce 时机
  - **验证**: vitest + RTL 模拟 onSave,改 title 后断言 onSave 拿到 `{title: "new"}`、content 不在 patch 里
  - **依赖**: 3.1, 4.1

- [x] 4.5 **`MemoryDetail` 组件**
  - **文件**: `packages/webui/web/src/components/memory/MemoryDetail.tsx` (Create)
  - **内容**: Props: `{id: string; onArchive: (id) => void; onListRefresh: () => void}`。内部 state: `atom` (DB 拿的)、`localAtom` (in-flight edit)、`error`。`useEffect` 拉 `api.memory.get(id)` + 3s 轮询。把 `localAtom` 传给 `useAutoSave(localAtom, (v) => api.memory.patch(id, v), 3000)`,header 显示状态条(Saving…/Saved Ns ago/error)+ Archive 按钮(直接调 `onArchive(id)`,不走 debounce)。header 旁边显示 Read-only metadata 行(strength/importance/access_count/created_at/updated_at/last_access/file_path),让用户看清 DB 状态
  - **验证**: vitest + RTL 模拟 api.memory.get/patch,改 title 后 3s 触发 patch;mock 失败时显示红色 error
  - **依赖**: 3.1, 3.2, 4.4

- [x] 4.6 **`MemoryPage` 装配**
  - **文件**: `packages/webui/web/src/pages/MemoryPage.tsx` (Create)
  - **内容**: 3-pane:`MemoryList` 左侧 30% 宽 + `MemoryDetail` 右侧 70% 宽 + `MemorySearchTester` 底部折叠。state: `selectedId`、`atoms`(list 数据)、`filters`。`useEffect` 拉 `api.memory.list({...filters})` + 3s 轮询;`useEffect` 拉 `api.memory.stats()` 显示顶部 stats badge。Archive handler 调 `api.memory.archive(id, true)` 然后 `setAtoms(prev => prev.filter(a => a.id !== id))` 立即更新
  - **验证**: vitest + RTL 渲染,断言 list 渲染 atom 数 = mock 数据数、点击列表项 detail 装入
  - **依赖**: 4.5

- [x] 4.7 **`AppShell` 加 Memory icon**
  - **文件**: `packages/webui/web/src/components/AppShell.tsx` (Modify)
  - **内容**: 找到现有 `IconRow` 的位置(当前只有 cron icon 之类),加一个 Memory icon(`Brain` 来自 lucide-react,或 `BookOpen` 备选)。点击调 `onNavigate('memory')` 或类似(参考现有 IconRow 的回调风格)。在 `AppShellProps` 加 `currentView` + `onNavigateView` props,`IconRow` 接受 `currentView` 高亮 active icon
  - **验证**: `npm run check` 过 TS;浏览器(开发模式)打开看到 icon 在 sidebar
  - **依赖**: 4.6

- [x] 4.8 **路由 `/memory`**
  - **文件**: `packages/webui/web/src/App.tsx` + `main.tsx` (Modify)
  - **内容**: 在路由表加 `<Route path="memory" element={<MemoryPage />} />`(参考现有 `/cron` 路由加法)。`AppShell` 用 `currentView` 决定渲染 `MemoryPage` / `ChatPage` / `CronPage`
  - **验证**: 浏览器访问 `/memory` 看到 MemoryPage 渲染
  - **依赖**: 4.7

## 5. 端到端验证

- [x] 5.1 **跑全量 check + 个人助理 + webui server 测试**
  - **文件**: 无(纯命令)
  - **内容**: 跑以下 4 个命令,全部退出码 0:
    ```bash
    cd /home/qjh/workspace/personal/pi && npm run check
    cd /home/qjh/workspace/personal/pi/extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/memory-exports.test.ts
    cd /home/qjh/workspace/personal/pi/packages/webui && node ../../node_modules/vitest/dist/cli.js --run test/memory-routes.test.ts
    cd /home/qjh/workspace/personal/pi/packages/webui && node ../../node_modules/vitest/dist/cli.js --run test/sessions-routes.test.ts
    ```
  - **验证**: 4 个命令全绿
  - **依赖**: 4.8

- [x] 5.2 **手动 smoke:tmux 启 webui,Chrome DevTools 走完整流程**
  - **文件**: 无(纯操作)
  - **内容**: 按 `AGENTS.md` 的"Testing pi Interactive Mode with tmux"段落启 webui(`./pi-test.sh` 或 `npm run dev:webui`),Chrome DevTools 打开:
    1. 访问 `/memory` → 空态显示 "No memories yet"
    2. 启动一个 TUI session 跑几次对话触发抽取(可选,或手动注入几条 atom 到 DB 用 `sqlite3 ~/.pi/agent/data/memory.db` 写几行测试数据)
    3. 列表显示 atom、点开 detail 看到 metadata + body
    4. 改 title → 3s 后 status 显示 "Saved"
    5. 改 body → 3s 后 status 显示 "Saved";在另一终端 `cat ~/.pi/agent/data/memory/atoms/<type>/<slug>.md` 看到 frontmatter `version+1` `updated_at` 变了
    6. 点 Archive → 列表立即移除
    7. 切到 SearchTester 面板输 query → 看到 keywords / target_types / fts·cosine·hybrid 分数
    8. (如果本地有 Ollama)Ollama 启动/关闭时 `embedding_available` 标志切换
  - **验证**: 8 个步骤全部通过
  - **依赖**: 5.1

## Verification

- [x] 全量 check: `cd /home/qjh/workspace/personal/pi && npm run check` 退出码 0
- [x] 个人助理新 helper 单测: `cd /home/qjh/workspace/personal/pi/extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/memory-exports.test.ts` 8/8 绿
- [x] webui server memory 路由单测: `cd /home/qjh/workspace/personal/pi/packages/webui && node ../../node_modules/vitest/dist/cli.js --run test/memory-routes.test.ts` 全绿
- [x] webui server sessions 回归: `cd /home/qjh/workspace/personal/pi/packages/webui && node ../../node_modules/vitest/dist/cli.js --run test/sessions-routes.test.ts` 全绿(含 `runMemoryExtraction` spy 测试)
- [x] useAutoSave 单元测试: `cd /home/qjh/workspace/personal/pi/packages/webui/web && node ../../node_modules/vitest/dist/cli.js --run src/lib/useAutoSave.test.ts` 全绿
- [x] 组件渲染测试: 4 个 `Memory*.test.tsx` 全绿
- [x] 端到端 smoke: 8 个步骤全部通过

## 6. Review fixes (review-fail → develop loop)

### CRITICAL

- [x] 6.1 **fix webui vitest config: inline `node:sqlite`/`bun:sqlite`/`@earendil-works/pi-personal-assistant`**
  - **文件**: `packages/webui/vitest.config.ts` (Modify)
  - **内容**: 当前 `packages/webui` 的 vitest config 没 inline `node:sqlite` 和 `bun:sqlite`/`@earendil-works/pi-personal-assistant`,导致 server-side vitest 加载失败 (21 tests 全 fail "Failed to load url sqlite")。补:
    ```ts
    server: { deps: { inline: [/@earendil-works\/pi-personal-assistant/, "node:sqlite", "bun:sqlite"] } }
    ```
  - **验证**: `cd packages/webui && npm test -- --run test/memory-routes.test.ts` 全过 (用项目的 `npm test` 不是绕过 tsx 直调)
  - **依赖**: 无

- [x] 6.2 **`<memory-error>` placeholder in MemoryEditor (slug collision 显式提示)**
  - **文件**: `packages/webui/web/src/components/memory/MemoryEditor.tsx` (Modify)
  - **内容**: 当 `atom.content === ""` AND `atom.file_path !== ""` 时,显示红底提示 banner:"file hash mismatch — another atom with the same title overwrote this file"。给用户的歧义 feedback, 不再让用户以为数据丢失。
  - **验证**: vitest + RTL 渲染 atom with `content=""` + `file_path="/tmp/x.md"`,断言 placeholder 出现;atom with `content="..."` 时不出现 placeholder
  - **依赖**: 无

- [x] 6.3 **Search response `fallback` flag + MemorySearchTester notice**
  - **文件**: `extensions/personal-assistant/memory.ts` (Modify) + `packages/webui/web/src/lib/api.ts` (Modify) + `packages/webui/web/src/components/memory/MemorySearchTester.tsx` (Modify)
  - **内容**: 
    1. `QueryRewriteResult` 加 `fallback?: boolean` 字段
    2. `simpleKeywordExtraction` 返回 `{ fallback: true, ... }`
    3. `rewriteQueryWithCallLlm` 把 LLM 成功 parse 的结果强制 `fallback: false`;失败降级时 `fallback: true`
    4. `MemoryQueryRewriteResult` (api.ts) 同步加字段
    5. `MemorySearchTester` 渲染时,当 `fallback === true` 显示 "using keyword fallback (no LLM rewrite)" 灰底小字
  - **验证**: 
    - `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/memory-exports.test.ts` 全过
    - webui `MemorySearchTester.test.tsx` 加 1 个 fallback notice 渲染测试
  - **依赖**: 6.1

### HIGH

- [x] 6.4 **"Save now" 按钮要么删要么真 save now**
  - **文件**: `packages/webui/web/src/components/memory/MemoryEditor.tsx` (Modify) + `packages/webui/web/src/components/memory/MemoryDetail.tsx` (Modify)
  - **内容**: 当前 "Save now" 调用 onSave(patch) → setLocalAtom → useAutoSave debounce 重置 3s,**实际上 3s 后才 PATCH**,按钮 misleading。两种修法:
    - (A) 删除按钮 (auto-save 已 every keystroke 触发)
    - (B) 把 useAutoSave 的 `flush` 透传下来,Save now 调 `flush()` 立即 PATCH
  - 推荐 (B),更符合 UX 预期。实现:MemoryEditor 接 `onFlush?: () => Promise<void>` prop,按钮直接调 onFlush。MemoryDetail 传 `flush` 给 MemoryEditor。
  - **验证**: vitest + RTL mock `onFlush`,点击 Save now 立即调一次 flush();断言 mock 被调
  - **依赖**: 无

- [x] 6.5 **`parseRewriteJson` 默认 `raw_query: query` (不是 "")**
  - **文件**: `extensions/personal-assistant/memory.ts` (Modify)
  - **内容**: `parseRewriteJson` 当前 `raw_query: parsed.raw_query ?? ""`,应改为 `raw_query: parsed.raw_query ?? query`。这样无论 LLM 成功 parse 还是降级,`raw_query` 都至少是用户原始输入。
  - **验证**: 跑 `node ../../node_modules/vitest/dist/cli.js --run test/memory-exports.test.ts` 全过; 额外手测 `rewriteQueryWithCallLlm(callLlm, "amplicon", {})` 返回 `raw_query: "amplicon"`
  - **依赖**: 6.3

### MEDIUM (lower priority — 可以下个 cycle)

- [x] 6.6 **Preview tab 用 `<Markdown>` 组件 (spec S24)**
- [x] 6.7 **`<details>` 折叠细节; "bug" type 处理; memoryList archive button 文字化**
- [x] 6.8 **debounce filter input 300ms (避免每个 keystroke 重 fetch)**


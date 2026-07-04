# Tasks: gate-multiquery

> **Design:** design.md | **Base:** 9a4055eeb0ce5df1953bf5561a27ae27903aa385

**Goal:** 把 gate 的 query rewrite 任务拆出独立 rewrite 阶段,支持复合 query 多路 recall,修复 cross-encoder 对 multi-hop query 0-hit 的死区。

**Architecture:** gate.ts 收紧为 `{need_memory}` 纯二分. 新建 rewrite.ts (ollama qwen2.5:3b,输出 1-3 subqueries) + merge.ts (pure function 按 atom.id 取 rrf 最高). context hook 和 webui search route 共用 rewrite+merge. rerank query = `subqueries.join(" ")`. 所有失败降级到 [rawQuery] 或 topK fallback,与今天行为等价 non-blocking.

**Tech Stack:** ollama (qwen2.5:3b-instruct-q4_0),vitest,express,dynamic import. 无新依赖.

---

## 1. gate.ts schema 收紧 (binary only)

- [x] 1.1 **修改 GateDecision type,删除 search_query 字段**
  - **文件**: `extensions/personal-assistant/gate.ts` (Modify)
  - **内容**: `GateDecision` 从 `{need_memory: boolean; search_query: string}` 改为 `{need_memory: boolean}`. `GATE_SYSTEM_PROMPT` 删 "search_query (string) keyword-only 提取" 相关句,只保留 need_memory 二分 + S1/S2 防误判规则 (指代/零信息量/历史回溯). `parseGateResponse` 去掉 search_query 字段校验,只查 need_memory boolean.
  - **验证**: `node ../../node_modules/vitest/dist/cli.js --run extensions/personal-assistant/test/gate-skeleton.test.ts` (Type 测通过)
  - **依赖**: 无

- [x] 1.2 **更新 gate-fetch.test.ts 删除 search_query 断言**
  - **文件**: `extensions/personal-assistant/test/gate-fetch.test.ts` (Modify)
  - **内容**: 删除 line 48, 58, 104, 116 的 `search_query` 字段断言,改为 `expect(result).toEqual({ need_memory: true } satisfies GateDecision)` 形态. 删除 line 131-139 整个 test case `wrong types for search_query (not string)` (字段已不存在). line 124 / 189 / 208 的 mock body 仍可保留多余的 search_query 字段 (mock 仿真允许 LLM 多输出字段), parseGateResponse 必须忽略多余字段 — 加一个新测试 case "ignores extra fields like freed_search_query",假定 mock LLM 返 `{"need_memory":true,"search_query":"垃圾测试"}`,断言 callGate 返 `{need_memory:true}` (验证 schema 忽略 unknown field).
  - **验证**: `node ../../node_modules/vitest/dist/cli.js --run extensions/personal-assistant/test/gate-fetch.test.ts` (15 测试 - 1 删 + 1 新增 = 15 全过)
  - **依赖**: 1.1

- [x] 1.3 **更新 gate-prompt.test.ts 删除 search_query 字段断言**
  - **文件**: `extensions/personal-assistant/test/gate-prompt.test.ts` (Modify)
  - **内容**: buildGatePrompt 返回的 messages 不变结构,system content 中已不含 search_query 提示词. 删除断言 system content 含 "search_query" 字符串的测试. 增加断言 system content 不含 "search_query" (验证清理).
  - **验证**: `node ../../node_modules/vitest/dist/cli.js --run extensions/personal-assistant/test/gate-prompt.test.ts`
  - **依赖**: 1.1

- [x] 1.4 **更新 memory.ts context hook,删除 gate search_query 使用**
  - **文件**: `extensions/personal-assistant/memory.ts:779` (Modify)
  - **内容**: 删除 line 779 `if (gateDecision.search_query) searchQuery = gateDecision.search_query;`. `searchQuery` 变量初始化为 `current` 保留,后续管线将在 task 4 改为 rewrite 输出.
  - **验证**: `node ../../node_modules/vitest/dist/cli.js --run extensions/personal-assistant/test/pipeline.test.ts` (会暂时失败,因 search_query 被删但 pipeline test 仍 mock GateDecision 带 search_query — 这是已知的,待 task 4 调整). 试运行预期失败,确认搜索路径未走到 search_query 即可.
  - **依赖**: 1.1

## 2. merge.ts 纯函数模块 (可与 1 并行)

- [x] 2.1 **创建 mergeByAtomId pure function**
  - **文件**: `extensions/personal-assistant/merge.ts` (Create)
  - **内容**: 导出 `function mergeByAtomId(resultGroups: RecallResult[][]): RecallResult[]`. 逻辑: `Map<string, RecallResult>` key by atom.id,遍历所有 group 遇见 rrf 比当前高或没有的就 set. 返回 `[...map.values()]`. 无 I/O.
  - **验证**: `npx tsx -e "import {mergeByAtomId} from './extensions/personal-assistant/merge.ts'; const a=[{atom:{id:'x'},rrf:0.05,cosine:0.8,sparseScore:0.2}]; const b=[{atom:{id:'x'},rrf:0.03,cosine:0.7,sparseScore:0.1}]; const r=mergeByAtomId([a,b]); console.log(JSON.stringify(r[0].rrf));"` 应输出 0.05 (取 rrf 高的)
  - **依赖**: 无

- [x] 2.2 **写 merge.ts 单元测试**
  - **文件**: `extensions/personal-assistant/test/merge.test.ts` (Create)
  - **内容**: 5 个 case: (1) 单组 input 不动; (2) B4 多组重叠 atomId 取 rrf 高; (3) B9 全空组 → []; (4) 单组空 + 一组有内容 → 保留有内容; (5) 三组 mixed id 出现 2 次取 rrf 高. 每个 case 都用 RecallResult 形态 fixture.
  - **验证**: `node ../../node_modules/vitest/dist/cli.js --run extensions/personal-assistant/test/merge.test.ts` (5 个测试全过)
  - **依赖**: 2.1

## 3. rewrite.ts 模块

- [x] 3.1 **创建 rewrite.ts skeleton + types**
  - **文件**: `extensions/personal-assistant/rewrite.ts` (Create)
  - **内容**: 导出 `RewriteOptions`, `RewriteError = "timeout"|"parse"|"unreachable"`, `RewriteFallback { reason, subqueries: string[] }`. 顶层导出 `rewriteQueries(query, recent?, options?): Promise<string[] | RewriteFallback>`. body 一开始 return `[]` (skeleton). 默认值: DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434", DEFAULT_MODEL = "qwen2.5:3b-instruct-q4_0", DEFAULT_TIMEOUT_MS = 1500, DEFAULT_MAX_SUBQUERIES = 3.
  - **验证**: `npx tsx --no-warnings -e "import {rewriteQueries} from './extensions/personal-assistant/rewrite.ts'; await rewriteQueries('x'); console.log('ok')"` 输出 ok (skeleton 不爆)
  - **依赖**: 无

- [x] 3.2 **写 buildRewritePrompt + REWRITE_SYSTEM_PROMPT**
  - **文件**: `extensions/personal-assistant/rewrite.ts` (Modify)
  - **内容**: 添加 `REWRITE_SYSTEM_PROMPT` (5 段规则: 1.输出格式 / 2.指代消解 / 3.复合拆分 / 4.单概念保留 / 5.去重不生造 每段 ≤30 字符). 导出 `buildRewritePrompt(query: string, recent: string[] | null): {role, content}[]` (system+user 形态,空 recent 显示 "Recent user messages: None"). User content 末尾 `Respond JSON only:`.
  - **验证**: `npx tsx -e "import {buildRewritePrompt} from './extensions/personal-assistant/rewrite.ts'; const m=buildRewritePrompt('x', null); console.assert(m[0].role==='system'); console.assert(m[1].content.includes('Respond JSON only')); console.log('ok')"` 输出 ok
  - **依赖**: 3.1

- [x] 3.3 **写 parseRewriteResponse 内部函数**
  - **文件**: `extensions/personal-assistant/rewrite.ts` (Modify)
  - **内容**: 私有函数 `parseRewriteResponse(raw: string): string[] | "parse"`. JSON.parse 失败后 regex `/(\{[\s\S]*\})/` 提取再 parse. 成功后校验 `Array.isArray(parsed.subqueries)`, 元素全为 string, length≥1. 失败返 "parse". 输入返 `[]` 视为 parse 失败. 输入 5 条 `slice(0,3)` 截断 + console.debug `rewrite truncated 5→3`. 输入有重复 → Set 去重保序.
  - **验证**: `npx tsx -e "import './extensions/personal-assistant/rewrite.ts'; console.log('ok')"` - 不直接 export,所以验证靠单元测试 3.4
  - **依赖**: 3.2

- [x] 3.4 **写 rewrite.ts 单元测试 (mock fetch)**
  - **文件**: `extensions/personal-assistant/test/rewrite.test.ts` (Create)
  - **内容**: 9 个 case: (1) success `{"subqueries":["a","b"]}` → string[]; (2) success `{"subqueries":["q"]}` 单元素 → string[]; (3) 空数组 → fallback parse + subqueries=[rawQuery]; (4) 5 条 → slice(0,3) 截断; (5) `["a","a","b"]` → `["a","b"]` 去重; (6) timeout → fallback timeout + subqueries=[rawQuery]; (7) ECONNREFUSED → fallback unreachable + subqueries=[rawQuery]; (8) 非合法 JSON → fallback parse; (9) success 但 subqueries 字段非数组 → fallback parse. 所有 mock 用 `mockJsonResponse` 同 gate-fetch.test.ts 模式.
  - **验证**: `node ../../node_modules/vitest/dist/cli.js --run extensions/personal-assistant/test/rewrite.test.ts` (9 个测试通过)
  - **依赖**: 3.2, 3.3

- [x] 3.5 **rewriteQueries body 实现 (fetch + AbortController + 整合 parseRewriteResponse)**
  - **文件**: `extensions/personal-assistant/rewrite.ts:rewriteQueries body` (Modify)
  - **内容**: 集成 buildRewritePrompt → fetch `/api/chat` (model/messages/stream:false/options:temperature:0) → parseRewriteResponse. AbortController setTimeout(timeoutMs) clearTimeout. catch: AbortError → Fallback{reason:"timeout", subqueries:[query]}; TypeError → Fallback{reason:"unreachable", subqueries:[query]}; 其他 → Fallback{reason:"unreachable", subqueries:[query]}. 成功 parse:返 string[] | fallback{reason:"parse", subqueries:[query]}.
  - **验证**: `node ../../node_modules/vitest/dist/cli.js --run extensions/personal-assistant/test/rewrite.test.ts` (9 个测试全过,用 mock fetch 实际触发 path)
  - **依赖**: 3.2, 3.3, 3.4

## 4. memory.ts context hook pipeline 整合

- [x] 4.1 **PersonalAssistantConfig 加 rewrite.enabled 字段**
  - **文件**: `extensions/personal-assistant/memory.ts:74-114` (Modify)
  - **内容**: 在 memory?.gate / memory?.rerank 之间插入 `rewrite?: { enabled?: boolean };`. Default true(同 gate/rerank).
  - **验证**: `npx tsx -e "import {loadConfig} from './extensions/personal-assistant/memory.ts'; const c=loadConfig(); console.log(typeof c.memory?.rewrite?.enabled);"` 输出 undefined (因为 settings.json 无此字段,但语法不爆)
  - **依赖**: 1.1, 3.1

- [x] 4.2 **context hook 加 rewrite 阶段**
  - **文件**: `extensions/personal-assistant/memory.ts:695-886` (Modify)
  - **内容**: gate pass 分支后插入 rewrite. 新变量: `subqueries: string[]` 初始化为 `[current]` (覆盖原 `searchQuery` 变量,**删除原 searchQuery 变量全部 declaration**), `rewriteStatus: string`, `rewriteMs: number`, `rewriteEnabled`. rewrite enabled && gate pass 时调 `await import("./rewrite.ts")` 拿 `rewriteQueries`,传入 (current, recent, {timeoutMs:1500}). 判别 Array.isArray 后赋 subqueries. 失败时 `subqueries = outcome.subqueries`. 后续代码全部用 `subqueries` 不再出现单 `searchQuery` 变量 (4.3 / 4.4 联动改).
  - **验证**: `node ../../node_modules/vitest/dist/cli.js --run extensions/personal-assistant/test/pipeline.test.ts` (会失败直到 4.6 重写 pipeline test)
  - **依赖**: 1.4, 3.5, 4.1

- [x] 4.3 **multi-recall + merge 整合进 context hook**
  - **文件**: `extensions/personal-assistant/memory.ts:784-795` (Modify) — recall 段
  - **内容**: 删原 `recallAtoms(index, searchQuery, {topK:20})` 单调用. 改为 `const allResults = await Promise.all(subqueries.map(q => recallAtoms(index, q, {topK:20}))); const { mergeByAtomId } = await import("./merge.ts"); const results = mergeByAtomId(allResults);`. 注意 4.2 已删 searchQuery, 不再出现 searchQuery 单变量. hybridCount 计数改为 merged 数组长度.
  - **验证**: 1 个单 subquery 时仍单调一次 recallAtoms (path 后退兼容). 注: 当 subqueries=[current] 时,join 后是 current 本身,等价原 searchQuery 行为.
  - **依赖**: 2.1, 4.2

- [x] 4.4 **rerank 用 joined subqueries**
  - **文件**: `extensions/personal-assistant/memory.ts:798-801` (Modify)
  - **内容**: `rerankAndFilter(...)` 调用首参数改为 `subqueries.join(" ")` (单 subqueries 时等价原 searchQuery 字符串,多 subqueries 时空格连接). 其他 retry/fallback/status 逻辑全保留. 注: 此时 searchQuery 变量已不存在 (4.2 删除),不再引用.
  - **验证**: `node ../../node_modules/vitest/dist/cli.js --run extensions/personal-assistant/test/rerank.test.ts` (rerank 模块测试不动)
  - **依赖**: 4.3

- [x] 4.5 **debug log 加 rewrite 行 + 短路点同步更新**
  - **文件**: `extensions/personal-assistant/memory.ts` (Modify) — 4 处 console.debug
  - **内容**: 单行 console.debug 模板从 `[recall] gate=X rerank=Y ... latency {gate:Nms recall:Nms rerank:Nms}` 改为 `[recall] gate=X rewrite=Y(N) rerank=Y(r) ... latency {gate:Nms rewrite:Nms recall:Nms rerank:Nms}`. rewrite=Y(N) 输出 `ok(2)` / `timeout` / `parse` / `unreachable` / `disabled` / `skip(pre-gate-skip)`.
  注: **短路点 log 必须同步修改**:memory.ts 现有 3 个早返 console.debug (Line 748 gate unknown / Line 764 GateError / Line 773 need_memory=false),全部在模板末段加 `rewrite=skip(pre-gate-skip)` 字段,覆盖"短路不调 rewrite"显式信号. happy path 进度 line 842-851 段也需要长模板加 rewrite 字段.
  - **验证**: `node ../../node_modules/vitest/dist/cli.js --run extensions/personal-assistant/test/pipeline.test.ts` (4.6 完成后才过)
  - **依赖**: 4.4

- [x] 4.6 **更新 pipeline.test.ts 覆盖 rewrite 集成**
  - **文件**: `extensions/personal-assistant/test/pipeline.test.ts` (Modify)
  - **内容**: 加 `vi.mock("../rewrite.ts", () => ({ rewriteQueries: mockRewriteQueries }))` + mock 实现. 加 5 个 case: (a) gate pass + rewrite ok(2) → 2 路 recall + merge + rerank; (b) rewrite timeout → subqueries=[rawQuery] 单路 + rerank 用 rawQuery; (c) rewrite parse 失败 → fallback; (d) rewrite disabled → 单路 recall + rerank; (e) gate disabled + rewrite enabled → rewrite 仍执行 (B7). 现有 5 个 status assertion 改为支持新字段 rewrite=.
  - **验证**: `node ../../node_modules/vitest/dist/cli.js --run extensions/personal-assistant/test/pipeline.test.ts` (5 现有 + 5 新 = 10 测试全过)
  - **依赖**: 4.5

## 5. webui server routes/memory.ts 整合

- [x] 5.1 **registerPostSearch 加 rewrite+multivrecall+merge 路径**
  - **文件**: `packages/webui/server/routes/memory.ts:799-841` (Modify)
  - **内容**: filtered=true 分支扩展: `const { rewriteQueries } = await import("../../...rewrite.ts")` 拿 rewriteQueries,传入 (query, null, {timeoutMs:1500}) 拿 subqueries. `Promise.all(subqueries.map(q => recallAtoms(index, q, {topK, filter:type?{type}:undefined})))` 多路 recall. `mergeByAtomId` 合并. `rerankAndFilter(subqueries.join(" "), merged)` 替换原 rerank query. response 加 `rewriteTimeMs` 字段. filtered=false 完全不动. (dynamic import 路径从 `routes/memory.ts` 起: `../../../../extensions/personal-assistant/rewrite.ts` 4 个 ../)
  - **验证**: `node ../../node_modules/vitest/dist/cli.js --run packages/webui/server/test/memory-routes.test.ts` (5.2 新加 case 之外,先确认不爆既有 8 个测试)
  - **依赖**: 2.1, 3.5, 4.1

- [x] 5.2 **更新 webui search 路由测试 (扩展现有 memory-routes.test.ts)**
  - **文件**: `packages/webui/server/test/memory-routes.test.ts` (Modify) — 现有 `POST /api/memory/search` describe 块在 line 1081
  - **内容**: 在现有 describe 块内追加 3 个 case: (1) filtered=false → response 不含 rewriteTimeMs/rerankTimeMs,单路 recall; (2) filtered=true + rewrite mock (vi.mock rewrite.ts module alias) → response 含 subqueries multi-recall + rerankScore 字段; (3) filtered=true + rewrite timeout → fallback subqueries=[query] 仍返 hits. mock fetch 到 ollama 用 vi.spyOn 全局 fetch. 复用 mountMemoryRoutes + fetchAt 助手 (已存在).
  - **验证**: `node ../../node_modules/vitest/dist/cli.js --run packages/webui/server/test/memory-routes.test.ts` (现有 + 新增 3 个 = 全过)
  - **依赖**: 5.1

- [x] 5.3 **调整 5.1 验证命令**
  - **文件**: 无 (验证 clarification)
  - **内容**: 5.1 验证命令实际跑 `/api/memory/search` 测试在 memory-routes.test.ts,有别于 5.2 新加 case. 5.1 验证应只确认 registerPostSearch 签名 + filtered 分支调用链不爆; 5.2 是端到端 case 验证.
  - **验证**: `node ../../node_modules/vitest/dist/cli.js --run packages/webui/server/test/memory-routes.test.ts` (单次运行包含 5.1 + 5.2 全部 case)
  - **依赖**: 5.1, 5.2

## 6. 文档与回归

- [x] 6.1 **更新 AGENTS.md 标注 gate 改动**
  - **文件**: `AGENTS.md` (Modify) — Core Principles 中现有 gate 段 (recall-precision 第 2 条 "gate 是 binary 决策不需要置信度")
  - **内容**: 原条目 `{need_memory, search_query}` 改为 `{need_memory}`,不输出 query 字段说明. 新增一行指向 rewrite 模块.
  - **验证**: 人工 read AGENTS.md Core Principles 区段确认
  - **依赖**: 4.5

- [x] 6.2 **跑全套测试 + npm run check**
  - **文件**: 无 (验证 task)
  - **内容**: 在 roots repo 下 `npm run check` (biome + tsgo + shrinkwrap + ts-imports + browser-smoke). 修复任何新 errors/warnings. 不 commit 直到 clean.
  - **验证**: `npm run check` 退出码 0
  - **依赖**: 6.1, 5.2

- [x] 6.3 **写复合 query 端到端 smoke script**
  - **文件**: `/tmp/gate-multiquery-smoke.sh` (Create,临时不 commit)
  - **内容**: 5 个 curl POST `http://127.0.0.1:8741/api/memory/search` body=`{"query":"Q","filtered":true,"topK":20}` 测 5 复合 query: (1) "MGM项目的工时如何计算" 期望≥1 hit; (2) "bwa 并发问题怎么修" 期望 1 hit (单概念不拆); (3) "之前那个脚本有什么问题" 期望 webui 无上文,0 hits 或 1 weak hit; (4) "MGM 项目"; (5) "工时估算" 单概念. 检查 rerankScore 与 rerankTimeMs 字段存在.
  - **验证**: `bash /tmp/gate-multiquery-smoke.sh` 输出每条 query 的 hits 数,<5 行/条
  - **依赖**: 6.2

- [x] 6.4 **删除 smoke script,清理**
  - **文件**: `/tmp/gate-multiquery-smoke.sh` (Delete)
  - **内容**: Smoke 跑完 review 结果 OK 后删除临时脚本 (per AGENTS.md ad-hoc script 规则)
  - **验证**: `ls /tmp/gate-multiquery-smoke.sh` 输出 No such file
  - **依赖**: 6.3

## Verification

- [x] 全量测试: `./test.sh` (per AGENTS.md, 而非 `npm test`)
- [x] Lint: `npm run check` (全 clean,无 error/warning/info)
- [x] 端到端 smoke: `bash /tmp/gate-multiquery-smoke.sh` 命中复合 query ≥1 hit
- [x] 复合 query "MGM项目的工时如何计算" filtered=true 至少返回 1 个 rerankScore ≥ 0.5 的 hit
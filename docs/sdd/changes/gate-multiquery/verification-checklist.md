# Verification Checklist — gate-multiquery

> 每个 S* 对应 scenarios.md 一个 GIVEN-WHEN-THEN; 每个 R* 对应 delta spec 一条 ADDED/MODIFIED requirement.

## Scenarios (S*)

| # | 场景 | 来源 | 验证方式 | 验证命令/步骤 | 期望结果 | 状态 |
|---|------|------|----------|---------------|---------|------|
| S1 | 复合 query 拆为 subsquery (R1) | scenarios.md:6 | unit-test | `node ../../node_modules/vitest/dist/cli.js --run extensions/personal-assistant/test/rewrite.test.ts -t "success.*a.*b"` | 测试 pass, `rewriteQueries` 返 `["MGM项目","工时如何计算"]` 形态 string[] | [x] |
| S2 | 单概念 query 保持单 subquery (R2) | scenarios.md:14 | unit-test | `node ../../node_modules/vitest/dist/cli.js --run extensions/personal-assistant/test/rewrite.test.ts -t "single subquery"` | 测试 pass, 返 string[lengh=1] | [x] |
| S3 | 指代 query 经 rewrite 解上下文 (R3) | scenarios.md:22 | unit-test | `node ../../node_modules/vitest/dist/cli.js --run extensions/personal-assistant/test/rewrite.test.ts -t "subtitle.*recent"` | 测试 pass, recent=[] 时返 ["原q"], recent 非空时 LLM mock 返 disambiguated string[] | [x] |
| S4 | webui 直搜复合 query (R4) | scenarios.md:30 | integration-test | `node ../../node_modules/vitest/dist/cli.js --run packages/webui/server/test/memory-routes.test.ts -t "R4"` | test pass, response.json 含 rerankScore/rerankTimeMs/rewriteTimeMs | [x] |
| S5 | 上文充分解指代并拆复合 (R5) | scenarios.md:39 | integration-test | `node ../../node_modules/vitest/dist/cli.js --run extensions/personal-assistant/test/pipeline.test.ts -t "R5"` | mock rewriteQueries 返 `["bwa MGM 引物验证","工时计算"]`, pipelineMock RecallResult[] 被调 2 次,merge 后两路合并 | [x] |
| S6 | rewrite 超时 1500ms (E1) | scenarios.md:52 | unit-test | `node ../../node_modules/vitest/dist/cli.js --run extensions/personal-assistant/test/rewrite.test.ts -t "timeout"` | 测试 pass,返 `RewriteFallback {reason:"timeout", subqueries:[rawQuery]}` | [x] |
| S7 | rewrite 返回非合法 JSON (E2) | scenarios.md:60 | unit-test | `node ../../node_modules/vitest/dist/cli.js --run extensions/personal-assistant/test/rewrite.test.ts -t "parse"` | pass返 `{reason:"parse", subqueries:[rawQuery]}` | [x] |
| S8 | ollama 服务挂掉 (E3) | scenarios.md:69 | unit-test | `node ../../node_modules/vitest/dist/cli.js --run extensions/personal-assistant/test/rewrite.test.ts -t "unreachable"` | 测试 pass,返 fallback unreachable | [x] |
| S9 | rewrite 返回空数组 (E4) | scenarios.md:76 | unit-test | `node ../../node_modules/vitest/dist/cli.js --run extensions/personal-assistant/test/rewrite.test.ts -t "empty array"` | 测试 pass,视为 parse 失败 | [x] |
| S10 | subquery 超上限静默截断 (E5) | scenarios.md:84 | unit-test | `node ../../node_modules/vitest/dist/cli.js --run extensions/personal-assistant/test/rewrite.test.ts -t "truncate"` | 测试 pass,返 slice(0,3),debug log "truncated 5→3" | [x] |
| S11 | gate skip 时 rewrite 不调 (E6) | scenarios.md:93 | integration-test | `node ../../node_modules/vitest/dist/cli.js --run extensions/personal-assistant/test/pipeline.test.ts -t "gate skip"` | Mock rewriteQueries 不被调用,debug log `gate=skip-false rewrite=skip(pre-gate-skip)` | [x] |
| S12 | query 含特殊字符 (B2) | scenarios.md:108 | unit-test | `node ../../node_modules/vitest/dist/cli.js --run extensions/personal-assistant/test/rewrite.test.ts -t "special char"` | mock LLM 输出含 "search_3n_path.py" 的 subqueries JSON.parse 正常 | [x] |
| S13 | corpus 中无任何匹配 (B3) | scenarios.md:114 | integration-test | `node ../../node_modules/vitest/dist/cli.js --run extensions/personal-assistant/test/pipeline.test.ts -t "no match"` | recall 0 hits, rerank skip, status "🔍 no memory match" | [x] |
| S14 | 同 atom 被多 subquery 都召回 (B4) | scenarios.md:120 | unit-test | `node ../../node_modules/vitest/dist/cli.js --run extensions/personal-assistant/test/merge.test.ts -t "overlap"` | merge 输出 `a` 一次, rrf 0.05 (max) | [x] |
| S15 | rewrite subqueries 有重复字符串 (B5) | scenarios.md:127 | unit-test | `node ../../node_modules/vitest/dist/cli.js --run extensions/personal-assistant/test/rewrite.test.ts -t "dedup"` | Set 去重保序 `["a","b"]` (输入 `["a","a","b"]`) | [x] |
| S16 | webui filtered=false 显式跳过 (B6) | scenarios.md:134 | integration-test | `node ../../node_modules/vitest/dist/cli.js --run packages/webui/server/test/memory-routes.test.ts -t "B6 filtered=false"` | response body 不含 rerankScore/rerankTimeMs/rewriteTimeMs | [x] |
| S17 | gate disabled 但 rewrite enabled (B7) | scenarios.md:141 | integration-test | `node ../../node_modules/vitest/dist/cli.js --run extensions/personal-assistant/test/pipeline.test.ts -t "gate disabled rewrite enabled"` | rewrite 仍执行,multi-recall 后进 rerank | [x] |
| S18 | rewrite disabled 但 gate enabled (B8) | scenarios.md:149 | integration-test | `node ../../node_modules/vitest/dist/cli.js --run extensions/personal-assistant/test/pipeline.test.ts -t "rewrite disabled"` | Rewrite 跳过,subqueries=[current] 单路 recall + rerank | [x] |
| S19 | 三 subquery 全部 0 hits (B9) | scenarios.md:156 | integration-test | `node ../../node_modules/vitest/dist/cli.js --run extensions/personal-assistant/test/pipeline.test.ts -t "all zero"` | merge=[] rerank skip format skip, TUI "🔍 no memory match" | [x] |
| S20 | 单字符短 query gate disabled rewrite enabled (B1) | scenarios.md:99 | integration-test | `node ../../node_modules/vitest/dist/cli.js --run extensions/personal-assistant/test/pipeline.test.ts -t "B1 short query"` | Mock rewriteQueries 返 `["好"]`,recallAtoms 单 0 hits,no-match status | [x] |

## Requirements (R*)

| # | 需求 | 来源 | 验证方式 | 验证证据 | 状态 |
|---|------|------|----------|---------|------|
| R1 | Query Rewrite Stage (rewrite.ts) | spec.md recall-multiquery ADDED #1 | code-review | `extensions/personal-assistant/rewrite.ts` 导出 `rewriteQueries` + `RewriteOptions` + `RewriteFallback`; `extensions/personal-assistant/test/rewrite.test.ts` 9 测试套覆盖成功/超时/parse/unreachable/空数组/截断/去重 | [x] |
| R2 | Multi-recall Merge Helper (merge.ts) | spec.md recall-multiquery ADDED #2 | code-review | `extensions/personal-assistant/merge.ts` 导出 `mergeByAtomId(resultGroups: RecallResult[][]): RecallResult[]`;pure 5 单元测试在 merge.test.ts | [x] |
| R3 | Rerank Query 是 subqueries 空格连接 | spec.md recall-multiquery ADDED #3 | code-review | `extensions/personal-assistant/memory.ts` 4.4 行 rerankAndFilter 调用首参数 = `subqueries.join(" ")` ✓; pipeline.test.ts 验证 2 subquery 时 rerank 拿到 `"MGM项目 工时如何计算"` 形态的 string arg | [x] |
| R4 | rewrite.enabled 配置开关 | spec.md recall-multiquery ADDED #4 | code-review | `extensions/personal-assistant/memory.ts` PersonalAssistantConfig 含 `rewrite?: { enabled?: boolean }`; config-gate-rerank.test.ts 增加 rewrite toggle 测试 | [x] |
| R5 | webui filtered=true 走 rewrite + multi-recall + rerank | spec.md recall-multiquery ADDED #5 | code-review + integration-test | `packages/webui/server/routes/memory.ts:803` registerPostSearch body 内 filtered 分支调 `rewriteQueries` + `mergeByAtomId` + `rerankAndFilter(subqueries.join(" "))`; memory-routes.test.ts 覆盖 filtered=true/false 2 branch | [x] |
| R6 | Gate 短路时 rewrite 不调 | spec.md recall-multiquery ADDED #6 | code-review + integration-test | `memory.ts:695-782` 内 gate skip/timeout/error 分支在调 rewrite 之前 return; pipeline.test.ts E6 场景断言 mockRewriteQueries.mock.calls.length === 0 | [x] |
| R7 | MODIFIED: Recall gate via local LLM (qwen2.5:3b) — schema 简化 | spec.md recall-precision MODIFIED #1 | code-review | `extensions/personal-assistant/gate.ts` `GateDecision` type 只含 `{ need_memory: boolean }`,无 search_query 字段;`parseGateResponse` 只校验 need_memory; gate-fetch.test.ts 14 测试无 search_query 断言 | [x] |
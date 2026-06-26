# Verification Checklist: memory-pipeline-hardening

> 生成时间: 2026-06-26 | 审查者必须逐项验证并附可追溯证据
> 状态: [ ] 待验证 | [x] 通过 | [!] 失败(必须修复或记录偏差)

## 场景验证 (Scenarios)

| # | 场景 | 来源 | 验证方式 | 验证命令/步骤 | 期望结果 | 状态 |
|---|------|------|----------|--------------|---------|------|
| S1 | 客户端 PATCH 时 version 匹配,写入成功 | scenarios.md:L9 | unit-test | `cd packages/webui/server && node ../../../node_modules/vitest/dist/cli.js --run test/memory-routes.test.ts -t "If-Match 匹配"` | 响应 200,body.version = existing.version + 1 | [ ] |
| S2 | SSE 推送使客户端实时更新 | scenarios.md:L14 | unit-test | `cd packages/webui/server && node ../../../node_modules/vitest/dist/cli.js --run test/memory-routes.test.ts -t "SSE 推送"` | 第二个 client PATCH 后第一个 client 收到 `event: atom` 帧 | [ ] |
| S3 | webui 写入触发 supersede | scenarios.md:L19 | unit-test | `cd packages/webui/server && node ../../../node_modules/vitest/dist/cli.js --run test/memory-routes.test.ts -t "supersede"` | 旧 atom `is_latest=0`,新 atom 继承 strength | [ ] |
| S4 | tag 输入"代码规范, code-style"被归一化 | scenarios.md:L23 | unit-test | `cd packages/webui/server && node ../../../node_modules/vitest/dist/cli.js --run test/memory-routes.test.ts -t "tag 归一化"` | DB 中 atom.tags = ["code-style"] | [ ] |
| S5 | 检索 query 命中 tag 提升排序 | scenarios.md:L28 | unit-test | `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/scoring.test.ts -t "tagOverlap"` | tag 命中 atom.score ≥ cosine-only atom.score | [ ] |
| S6 | 客户端用旧 version 发 PATCH,返回 409 | scenarios.md:L37 | unit-test | `cd packages/webui/server && node ../../../node_modules/vitest/dist/cli.js --run test/memory-routes.test.ts -t "If-Match 不匹配"` | 响应 409,body.error="version_conflict",body.current.version | [ ] |
| S7 | SSE 连接断开 | scenarios.md:L42 | unit-test | `cd packages/webui/server && node ../../../node_modules/vitest/dist/cli.js --run test/memory-routes.test.ts -t "SSE 断连清理"` | `subscribers.get(id).size` 在 res.close 后减少 1 | [ ] |
| S8 | ollama 不可达,supersede 跳过 | scenarios.md:L47 | unit-test | `cd packages/webui/server && node ../../../node_modules/vitest/dist/cli.js --run test/memory-routes.test.ts -t "ollama 不可达"` | PATCH 仍然 200,body 无 previousId | [ ] |
| S9 | tag_aliases 缺失或格式错 | scenarios.md:L52 | unit-test | `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/tag-alias.test.ts -t "aliases 缺失"` | normalizeTags 返回 Set 去重结果 | [ ] |
| S10 | 同时收到两次 SSE 推送,version 顺序错乱 | scenarios.md:L57 | unit-test | `cd packages/webui/web && node ../../../node_modules/vitest/dist/cli.js --run test/MemoryDetail.test.ts -t "SSE 乱序"` | 旧 version 事件被丢弃 | [ ] |
| S11 | cosine 正好等于阈值 0.92 | scenarios.md:L66 | unit-test | `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/dedup.test.ts -t "边界 0.92"` | 命中 supersede | [ ] |
| S12 | 极冷 atom 的 freshness_decay 接近 0 | scenarios.md:L71 | unit-test | `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/scoring.test.ts -t "freshness 365 天"` | computeFreshness 返回 ≈ 0 | [ ] |
| S13 | SSE 心跳保活 | scenarios.md:L76 | unit-test | `cd packages/webui/server && node ../../../node_modules/vitest/dist/cli.js --run test/memory-routes.test.ts -t "心跳"` | 25s 周期收到 `: ping\n\n` | [ ] |
| S14 | 同时 PATCH 同一 atom 的并发竞争 | scenarios.md:L81 | unit-test | `cd packages/webui/server && node ../../../node_modules/vitest/dist/cli.js --run test/memory-routes.test.ts -t "并发 PATCH"` | 后到的 client 收到 409 | [ ] |
| S15 | 客户端缺 If-Match,返回 400 | spec.md ADDED #1 派生 | unit-test | `cd packages/webui/server && node ../../../node_modules/vitest/dist/cli.js --run test/memory-routes.test.ts -t "缺 If-Match"` | 响应 400,body.error="missing_if_match" | [ ] |
| S16 | If-Match 为 `*` 表示 any-version | spec.md ADDED #1 派生 | unit-test | `cd packages/webui/server && node ../../../node_modules/vitest/dist/cli.js --run test/memory-routes.test.ts -t "If-Match 通配"` | 响应 200,正常 updateAtom | [ ] |
| S17 | 自然语言 query 不受 tag_overlap 影响 | spec.md ADDED #4 派生 | unit-test | `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/scoring.test.ts -t "自然语言 query"` | 所有 atom 的 tagOverlap=0,排序由 cosine × (1+0.3s+0.2i) + 0.05×freshness 主导 | [ ] |
| S18 | 客户端首次加载拉一次完整 atom | spec.md MODIFIED #1 派生 | unit-test | `cd packages/webui/web && node ../../../node_modules/vitest/dist/cli.js --run test/MemoryDetail.test.ts -t "首次加载"` | mount 后调 1 次 `GET /api/memory/:id`,不轮询 | [ ] |
| S19 | 完整 PATCH 流程(7 步顺序) | spec.md MODIFIED #2 派生 | unit-test | `cd packages/webui/server && node ../../../node_modules/vitest/dist/cli.js --run test/memory-routes.test.ts -t "完整流程"` | v5 → v6,tags 归一合并,supersede 跳过,atom 文件写入,SSE 广播 | [ ] |

## 需求验证 (Requirements)

| # | 需求 | 来源 | 验证方式 | 期望证据 | 状态 |
|---|------|------|----------|---------|------|
| R1 | 写入冲突通过 If-Match 头终止 | spec.md ADDED #1 | code-review | `memory.ts:patch-handler` 读取 `req.headers['if-match']` 并校验 `existing.version` | [ ] |
| R2 | webui 写入路径自动 cosine 去重 | spec.md ADDED #2 | code-review | `memory.ts:patch-handler` 调用 `supersedeIfSimilar(index, atomsDir, mergedAtom, embedding)`;threshold 默认 0.92 | [ ] |
| R3 | tag 写入归一化 | spec.md ADDED #3 | code-review | `memory.ts:patch-handler` 调用 `normalizeTags(input, deps.settings?.memory?.tagAliases)` | [ ] |
| R4 | 检索 score 公式含 tag_overlap 和 freshness | spec.md ADDED #4 | code-review | `search.ts:scoring` 公式 `cosine × (1 + 0.3s + 0.2i) + wTag × tagOverlap + wFreshness × freshness`;RecallResult 新增 tagOverlap/freshness 字段 | [ ] |
| R5 | 单 atom 状态通过 SSE 推送 | spec.md ADDED #5 | code-review | `memory.ts:registerStreamMemoryById` + 订阅表 Map;心跳 25s;乱序防护 `incoming.version > localAtom.version` | [ ] |
| R6 | webui 客户端用 SSE 替代 3 秒轮询 | spec.md MODIFIED #1 | code-review | `MemoryDetail.tsx` 删除 `setInterval(fetchAtom, 3000)`,新增 `new EventSource` | [ ] |
| R7 | write 流程包含 tag 归一化与 cosine dedup | spec.md MODIFIED #2 | code-review | `memory.ts:patch-handler` 顺序: If-Match → tag 归一 → embed → supersedeIfSimilar → updateAtom | [ ] |
| R8 | PersonalAssistantConfig.memory 新增 tagAliases/weights | spec.md(隐含 by R3/R4) | code-review | `extensions/personal-assistant/memory.ts:PersonalAssistantConfig` 新增 `tagAliases?`, `tagOverlapWeight?`, `freshnessWeight?` | [ ] |
| R9 | supersedeIfSimilar 抽出为独立函数 | spec.md(隐含 by R2) | code-review | `extensions/personal-assistant/dedup.ts` 导出 `supersedeIfSimilar`;`extraction.ts:executeItem` 重构调用 | [ ] |
| R10 | `extraction.executeItem` 既有行为不变 | spec.md(隐含) | unit-test | `extraction.test.ts`, `run-extraction.test.ts`, `lefse-regression.test.ts` 全绿 | [ ] |
| R11 | tag-alias.ts / scoring.ts / dedup.ts 各自有完整单测 | spec.md(隐含) | unit-test | `tag-alias.test.ts`, `scoring.test.ts`, `dedup.test.ts` 存在且全绿 | [ ] |
| R12 | hybrid-recall.test.ts back-compat | spec.md(隐含 by R4) | unit-test | `hybrid-recall.test.ts` 调整后全绿;fixture 控制 freshness 接近 0 时 score 与原值一致 | [ ] |

## 通过标准

- [ ] 所有场景 (S1-S19) 状态为 [x],每项有可追溯证据
- [ ] 所有需求 (R1-R12) 状态为 [x],每项有源码行号
- [ ] 证据格式: R 类 → 源码文件:行号,S 类 → curl 输出/screenshot/测试结果
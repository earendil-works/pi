# Verification Checklist: atom-remigrate

> 生成时间: 2026-07-02 | 审查者必须逐项验证并附可追溯证据
> 状态: [ ] 待验证 | [x] 通过 | [!] 失败（必须修复或记录偏差）

## 场景验证 (Scenarios)

<!--
每个 scenario → 1 个 S 条目。
验证方式推断规则:
  - 含 /api/ HTTP/curl/请求 → curl
  - 含 点击/页面/UI/表单/按钮 → chrome-devtools
  - 含 hash/加密/存储 → 代码审查
  - 含 npm test/pytest/cargo test → 单元测试
  - 无法自动验证 → 手动标记
-->

| # | 场景 | 来源 | 验证方式 | 验证命令/步骤 | 期望结果 | 状态 |
|---|------|------|----------|--------------|---------|------|
| S1 | 一次性程序驱动 0.65 dedup 迁移: 备份 + 排序 + 0.65 dedup + report | scenarios.md:L5-14 | unit-test | `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/migration.test.ts` | 跑完 0 SQLITE_BUSY, archivedCount ≥ 15, backup 文件存在 | [ ] |
| S2 | 同 cluster 0.65+ cosine 自动 merge: A 赢 B archived | scenarios.md:L16-25 | unit-test | `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/migration.test.ts` (test case "A wins over B with cosine 0.756") | B `is_latest=0, parent_id=A.id, superseded_at=now`; A 不变 | [ ] |
| S3 | 不扩张 atom 长度: 合并是 markSupersededNoInsert 标 archived, content 长度不变 | scenarios.md:L27-32 | code-review | `grep -n "markSupersededNoInsert" extensions/personal-assistant/storage.ts` + 读实现确认不 UPDATE content 列 | 仅 UPDATE `is_latest=0, parent_id, superseded_at` 3 列, content 列 0 改动 | [ ] |
| S4 | Idempotent: 第二次跑 0 改动 | scenarios.md:L34-40 | unit-test | migration.test.ts: it("second run produces 0 changes") | 第二次跑 0 个 markSupersededNoInsert 调用, archivedCount 增量 = 0 | [ ] |
| S5 | Extract prompt 注入现有 tag 字典 (top 50 + 规范) | scenarios.md:L42-57 | unit-test | `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/extraction-prompt.test.ts` (新 case: opts.tagVocabulary) | prompt 输出含 "## 现有 tag 字典" 段 + 字典内容 + Tag 规范 | [ ] |
| S6 | LLM 二次确认 action=update: 旧 atom 字段更新 (version+1) | scenarios.md:L59-68 | unit-test | `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/extraction-dedup-confirm.test.ts` (case a) | mock `index.updateAtom` 验证被调, version+1 | [ ] |
| S7 | LLM 二次确认 action=supersede: 旧 archived, 新独立 | scenarios.md:L70-74 | unit-test | extraction-dedup-confirm.test.ts (case b) | mock `index.markSupersededTx` 验证被调 | [ ] |
| S8 | LLM 二次确认 action=create: 旧不动, 新独立 insert | scenarios.md:L76-81 | unit-test | extraction-dedup-confirm.test.ts (case c) | mock `index.insertAtom` 验证被调, hit 不动 | [ ] |
| S9 | LLM 二次确认 action=skip: 完全重复, 啥也不做 | scenarios.md:L83-86 | unit-test | extraction-dedup-confirm.test.ts (case d) | 0 个 insert/update/markSuperseded 调用, 返回 status="skip" | [ ] |
| S10 | LLM 二次确认失败 (timeout/JSON parse): fallback supersede + warn | scenarios.md:L88-92 | unit-test | extraction-dedup-confirm.test.ts (case e) | mock callLlm throw AbortError, markSupersededTx 被调, console.warn 含 "fell back to supersede" | [ ] |
| S11 | cosine < 0.65 不命中, 无二次 LLM, 直接 insert (省时间) | scenarios.md:L94-97 | unit-test | extraction-dedup-confirm.test.ts (case f) | mock callLlm, 断言 0 次调用 | [ ] |
| S12 | 启动时 tag 字典加载: 扫 tags 列, 统计频次, top 50 缓存 | scenarios.md:L99-104 | unit-test | `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/tag-vocab.test.ts` (loadTagVocabulary cases) | top 50 频次正确, in-memory 缓存 (不重复扫) | [ ] |
| S13 | 备份创建失败 (磁盘满): 脚本 abort, 0 atom 改动 | scenarios.md:L108-112 | unit-test | migration.test.ts: it("backup failure aborts safely") | backup 失败时抛 Error, 0 markSupersededNoInsert 调用 | [ ] |
| S14 | 迁移期间 pi 在跑 (读写 memory.db): SQLITE_BUSY 5s 后 abort | scenarios.md:L114-121 | unit-test | migration.test.ts: it("DB locked aborts after 5s timeout") | 模拟另一进程持锁, 5s 后抛 SQLITE_BUSY, 部分迁移可 idempotent 重跑 | [ ] |
| S15 | 已迁移过 (二次执行) 标题带 "v2" 后缀: skip (但本期用 0.65 dedup 天然 idempotent, 不需要 v2 检测) | scenarios.md:L125-129 | manual | n/a (本期用天然 idempotency 替代 v2 标记, design Decision 3) | 验证天然 idempotency (S4) 即足够, v2 标记不在本期范围 | [ ] |
| S16 | 70 个 active (用户预先 archive 20): 只处理 70, backup 对应全 DB | scenarios.md:L131-135 | unit-test | migration.test.ts: it("handles smaller active corpus") | 报告 archivedCount + unchangedCount 反映 70 active atom, backup file size 对应全 DB (90 rows) | [ ] |
| S17 | 用户回滚: cp .bak 回去 + 重启 bge-m3 | scenarios.md:L137-141 | manual | `cp /tmp/memory-pre-migration.db /home/qjh/.pi/agent/memory/memory.db` + restart bge-m3 | 召回回到迁移前, id 全在, is_latest 全 1 | [ ] |
| S18 | 30 天后再合一次 (--threshold=0.60) | scenarios.md:L143-148 | manual | `cd extensions/personal-assistant && npx tsx scripts/migrate-legacy-atoms.mts --threshold=0.60` | 第二次跑抓到 36 个新 pair, 0 误合并, idempotent | [ ] |
| S19 | 边界: corpus 完全空, tag 字典为空 | scenarios.md:L150-154 | unit-test | tag-vocab.test.ts: it("loadTagVocabulary on empty corpus returns []") + extraction-prompt.test.ts (空字典不注入 "## 现有 tag 字典" 段) | loadTagVocabulary 返回 [], prompt 段为空, 不报错 | [ ] |
| S20 | 边界: corpus 1000 atom, tag 字典扫描快 (单次 ~50ms) | scenarios.md:L156-160 | manual | 1000 atom fixture, 跑 loadTagVocabulary, 用 console.time 测耗时 | 单次 ≤ 100ms (考虑 1000 atom), 缓存 in-memory 整 session | [ ] |
| S21 | 边界: LLM 不遵守 tag 规范 (大写 + 全专名): 程序归一 + warn | scenarios.md:L162-167 | unit-test | extraction-dedup-confirm.test.ts (case g/h/i) + tag-vocab.test.ts (normalizeTag cases) | 字典不含时 lowercase, 字典含时用字典标准形; conceptTagCount=0 时 warn 但仍写入 | [ ] |

## 需求验证 (Requirements)

<!--
每个 ADDED/MODIFIED requirement → 1 个 R 条目。
REMOVED/RENAMED 不需要验证。
-->

| # | 需求 | 来源 | 验证方式 | 期望证据 | 状态 |
|---|------|------|----------|---------|------|
| R1 | Legacy Atom Migration Script 存在 + 0.65 dedup | spec.md ADDED #1 | code-review | `extensions/personal-assistant/scripts/migrate-legacy-atoms.mts:1-100` 主函数 + `markSupersededNoInsert` 调用 | [ ] |
| R2 | Cosine Dedup Threshold Alignment (0.65 跨所有写入路径) | spec.md ADDED #2 | code-review | `extensions/personal-assistant/dedup.ts:29` 默认值 0.65; `supersedeIfSimilar` 不传 threshold 时用 0.65 | [ ] |
| R3 | Extract Pipeline LLM 二次确认 Dedup (4 个 action) | spec.md ADDED #3 | unit-test | extraction-dedup-confirm.test.ts (case a/b/c/d/e/f/g 全 pass) | [ ] |
| R4 | Tag Vocabulary Injection (top 50 + 缓存) | spec.md ADDED #4 | unit-test | tag-vocab.test.ts + extraction-prompt.test.ts (新 case "tagVocabulary 注入 prompt") | [ ] |
| R5 | Program-Side Tag Normalization (lowercase + 字典 + concept 检查) | spec.md ADDED #5 | unit-test | tag-vocab.test.ts (10+ cases) + extraction-dedup-confirm.test.ts (case g/h/i) | [ ] |
| R6 | EXTRACT_PROMPT_V2 Active Update Rule 注入 | spec.md ADDED #6 | code-review | `grep -n "主动更新,非扩张" extensions/personal-assistant/extraction.ts` 找到 + 段内容核对 | [ ] |
| R7 | supersedeIfSimilar Default Threshold 改为 0.65 (MODIFIED) | spec.md MODIFIED #1 | code-review | `extensions/personal-assistant/dedup.ts:29` + 顶部注释 "0.65-cosine" + test/dedup-threshold.test.ts 全 pass | [ ] |
| R8 | markSupersededNoInsert 公开方法 (MODIFIED 行为) | spec.md MODIFIED #2 | code-review | `extensions/personal-assistant/storage.ts` 加 `markSupersededNoInsert` 方法 + migration.test.ts 全 pass | [ ] |
| R9 | executePlan Signature 扩展 callLlm (MODIFIED) | spec.md MODIFIED #3 | unit-test | extraction.test.ts (callLlm 可选, 老 case 不传也 pass) + 新 test "executePlan with callLlm" | [ ] |
| R10 | executeItem 行为 (cosine 命中 + LLM 二次确认 + tag 归一 + concept warn) | spec.md MODIFIED #4 | unit-test | extraction-dedup-confirm.test.ts (case a-i 9 个 case 全 pass) | [ ] |
| R11 | recall-quality precision@5 ≥ 40% (proposal 验收 #5) | proposal.md 验收 #5 | manual | webui 跑 "修复的脚本和修复逻辑给我" → top-5 至少 2 真相关 | [ ] |
| R12 | migration 后 corpus atom 减少 ≥ 17% (proposal 验收 #1) | proposal.md 验收 #1 | manual | `cat extensions/personal-assistant/scripts/migrate-report.json` 看 archivedCount ≥ 15 | [ ] |
| R13 | 0.65 阈值 0 误合并 (proposal 验收 #8a) | proposal.md 验收 #8a | manual | migration 后 spot-check 5 个 archived 的"赢"是否合理 | [ ] |
| R14 | CHANGELOG 更新 (proposal 验收 "Added" + "Changed" 段) | proposal.md 验收 #9-15 | code-review | `extensions/personal-assistant/CHANGELOG.md` [Unreleased] 下含 migration script + extract 优化 + threshold 改动 3 段 | [ ] |

## 通过标准

- [ ] 所有场景 (S1-S21) 状态为 [x]，每项有可追溯证据
- [ ] 所有需求 (R1-R14) 状态为 [x]，每项有源码行号
- [ ] 证据格式: R 类 → 源码文件:行号，S 类 → curl 输出/screenshot/测试结果

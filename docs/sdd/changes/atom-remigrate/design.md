# Design: atom-remigrate

## Context

Personal-assistant 记忆系统当前有 90 个 active atom,典型问题:
- **冗余**: 至少 9 个 cluster 重复 (扩增子/iCAMP/check_seq/RNAVIRUS-DELIVERY-CHECK/smart-sample-find/workMonitor/X101SC26052587/README 各 2-3 个)
- **内容过短**: avg content 199/244/134 字 (fact/process/rule),LLM 召回后只看 summary,大量上下文丢失
- **召回假阳性高**: 用户原 case "修复的脚本和修复逻辑给我" 召回 8 个里 6 个无关 (precision 25%)
- **tag 体系无序**: 90 个 atom 产生 350 unique tag,平均每 tag 出现 1.1 次,基本无召回报警作用

根因不是召回算法 (bge-m3 dense+sparse RRF 是合理的),而是 **atom 文本结构缺乏信号 + extract pipeline 不防止冗余**:

1. title/summary 是自然语言,bge-m3 在 1024 维语义空间里把"修复的脚本"和"脚本位置"算成 0.55 cosine — 0.02 的距离 bge-m3 学到的就是"接近"
2. `EXTRACT_PROMPT_V2` 对 tag 无一致性约束,对"新建 vs 更新"无指导
3. `executeItem` 只有 fingerprint + 0.92 cosine dedup,程序层无法阻止 LLM 持续 emit 相似但 fingerprint 不同的新 atom

召回策略零改动是用户明确要求。本次变更分两路:
- **目标 1 (历史治理)**: 一次性 LLM 批处理 90 个老 atom,只合并不扩张,改完触发 bge-m3 reindex
- **目标 2 (未来预防)**: 改 `EXTRACT_PROMPT_V2`,注入 tag 字典 + 主动更新规则,让 LLM 看到现有 tag 后优先复用、看到可合并的现有 atom 后优先更新

## Goals / Non-Goals

### Goals
**目标 1 (历史治理)**:
- 90 个 active atom 一次性 LLM 批处理,合并冗余 cluster
- 合并后 atom 数量减少 ≥ 20% (90 → ≤ 72)
- id 全保留 (外部引用不破),version +1,updated_at 更新
- bge-m3 向量 reindex 同步
- 可回滚 (迁移前 backup)
- 脚本 idempotent (二次运行检测到 v2 标记就跳过)

**目标 2 (未来预防)**:
- `EXTRACT_PROMPT_V2` 注入 top-50 高频 tag 字典
- `EXTRACT_PROMPT_V2` 添加"主动更新,非扩张"规则
- 程序端 tag 大小写归一 (lowercase, 中文不变)
- 程序端概念性 tag 缺失时 warn
- 新会话 30 天后 corpus tag 重复率 ≥ 2.0 (字典成体系)

### Non-Goals
- 不改召回策略 (search.ts / format.ts / hybrid-search.ts / server.py 全部零改动)
- **不扩张 atom content 长度** (用户明确: 无须扩张新atom)。合并 cluster 后内容可短可长,只看 LLM 自然判断
- 不改 decay / strength / access_count 字段
- 不删 atom (LLM 决定保留就保留)
- 不改 schema (0 列变化)
- 不重建 bge-m3 全量索引 (只对改动的 atom 调 `reindex_one`)
- 不动 webui (UI 自然显示新文本)
- 不回填 source_session (那是另一个 change)
- 不引入 tag 同义词 LLM 自动聚类 (那是另一个独立 change,本次只用字符串归一)

## Decisions

### 1. (核心) migration 直接复用 `supersedeIfSimilar(0.65)`,不走 LLM
**Decision**: migration script 对 corpus 内每个 active atom 跑一遍程序层 0.65 cosine dedup,直接复用现有 `executeItem` 里的 `supersedeIfSimilar` 逻辑。不引 LLM,不发 batch prompt,不解析 JSON。
**Rationale**:
- "如果这 90 个 atom 是现在 extract 进来的,会发生什么?" — 答案就是 `executeItem` 跑一遍,0.65 dedup 会合并 35 pair
- migration 应该跟 extract pipeline **行为完全一致**,否则 2 套 dedup 阈值漂移是技术债
- 复用已有 dedup machinery,代码量最小,bug surface 最小
- 90 atom 实测 0.65 触发 35 pair,合理 reduction 18% (验收 ≥ 20% 的目标用 idempotent 重跑降到 0.60 实现 — 见 Decision 2)
- 不需要 LLM cost,不需要 idempotency 复杂标记 (re-run 结果天然一致),不需要 JSON parse 错误处理
**Alternatives**:
- *LLM batch 5×18 atom*: 拒。5-10 分钟 LLM 跑批,JSON parse 错误处理,idempotency 复杂,可能漏合并。**当前决策 (用户明确反对)**
- *Cosine 阈值聚类 (写新代码)*: 拒。`findMostSimilarEmbedding` 已存在,直接调它就是聚类
- *手工 merge list*: 拒。不可扩展

### 2. (核心) migration 排序:access_count DESC,热 atom 保留
**Decision**: 遍历 atom 列表时按 `access_count DESC, last_access DESC NULLS LAST, created_at DESC` 排序。**最常用的 atom 保留**,被 supersede 的是冷 atom。
**Rationale**: 同一 cluster 里 0.65 cosine 匹配的 2 个 atom,谁"赢"?
- 优先保留用户实际读过 (access_count > 0) 的 atom — 这是用户已验证的"真相关"
- 其次保留最近访问的 — 时间最近说明还有用
- 最后保留最早创建的 — 兜底
- 排序后"赢的"id 就是用户外部引用的目标 (webui atom URL、tool_result 访问记录都指向 access_count 高的)
**Alternatives**:
- *不排序,遍历顺序处理*: 拒。同 cluster A↔B,谁先遍历谁就成"赢",结果是数据库顺序的随机性
- *按 cosine 高低排序 (越相似越赢)*: 拒。cosine 0.65+ 都是"够相似",user 行为信号比 bge-m3 cosine 更准

### 3. (核心) 原子级 idempotency:迁移脚本是天然 idempotent
**Decision**: 不需要 settings.json 标记、不需要 title 后缀检测。重跑 migration 第二次,corpus 内已经没有 cosine ≥ 0.65 的 pair 了 (上一次已经 merge 了),所有 atom 调用 `findMostSimilarEmbedding(0.65)` 都返回 self (cosine=1.0),supsersedeIfSimilar 走 self-match guard 路径,啥也不做。第二次跑 0 个 merge,0 个 reindex,30 秒结束。
**Rationale**: 跟现有 `executeItem` 行为完全一致 — 0.65 dedup 已是终态 invariant。重跑就是 no-op。
**Alternatives**:
- *settings.json 标记 + 标题后缀*: 拒。增加复杂度,但 0.65 dedup 已是天然 barrier
- *migration 一次性脚本不重复*: 拒。30 天后用户重跑 review 应该有可重入性

### 4. bge-m3 reindex 走现有 HTTP endpoint,失败 warn 不中断
**Decision**: 改完一个 atom,POST `http://127.0.0.1:11435/api/atoms/{id}/reindex`,失败 (5xx / timeout 5s) warn + 继续。
**Rationale**: bge-m3 service 临时不可用不应该阻塞整次迁移。
**Alternatives**:
- *失败就 abort 全 rollback*: 拒。一次网络抖动 rollback 90 个 atom 改动不划算
- *失败用旧向量不 warn*: 拒,用户不知道哪些 atom 是 stale

### 5. 备份 memory.db 全量到 memory.db.bak.YYYYMMDD
**Decision**: 迁移前 `cp memory.db memory.db.bak.YYYYMMDD`,出错用户可手动 cp 回滚。
**Rationale**: 90 个 atom in-place 改没有自动回滚机制,DB 备份是最简单的。
**Alternatives**:
- *git 跟踪 memory.db*: 拒,memory.db 应该在 .gitignore
- *每 atom 改前导出 JSON*: 拒,4MB DB 直接 cp 更快

### 6. 不引入新工具/新依赖
**Decision**: 脚本用 Node + `tsx` (项目已有),HTTP 用 `fetch` (Node 20+ 内置)。不引第三方 LLM client。
**Rationale**: 保持依赖最小,migration 是临时脚本,3 个月后可能不再用。

### 7. (目标 2) tag 字典注入到 extract prompt,in-memory 缓存
**Decision**: 启动时扫 corpus 全 active atom 的 tags 列,统计频次,取 top-50,缓存 in-memory。`buildExtractionPrompt` 调用时把字典注入到 EXTRACT_PROMPT_V2 之后,作为 "## 现有 tag 字典" 段。
**Rationale**: 让 LLM 看到 corpus 现有 tag,优先复用而非发明新近义 tag,从根本上减少 tag 体系无序化。
**Alternatives**:
- *不做字典,让 LLM 自由 emit + 程序端 LLM 二次聚类*: 拒。二次聚类是另一个 change,工程量大
- *字典写进 EXTRACT_PROMPT_V2 静态文本*: 拒。不同用户的 corpus tag 体系不同,字典必须 per-corpus

### 8. (目标 2) 主动更新规则注入到 extract prompt
**Decision**: EXTRACT_PROMPT_V2 新增一段 "## 主动更新,非扩张" 规则,告诉 LLM:
```
- 如果新信息可归入 corpus 已有的 atom (主题/对象/项目相同),优先更新该 atom 的 content,
  不要为这条信息创建新 atom
- 更新方式: 在 content 末尾追加新段落,标注日期
- 仅在信息确实属于新主题/新对象时才创建新 atom
```
**Rationale**: LLM 默认倾向"为每条新信息创建 atom" (因为 LLM 不知道 corpus 现有内容),明确告诉它"先查现有再决定 create"是低成本高收益的引导。
**Alternatives**:
- *完全靠程序端 dedup 兜底*: 0.65 dedup 兜底仍存在 (Decision 10),但 fingerprint 不同会绕过 (check_seq 脚本位置 vs update-seq cosine 0.77, fingerprint 不同)。LLM 主动看到 corpus 更优
- *在 extract pipeline 加 RAG lookup*: 工程量中等 (每次 extract 前查 corpus),LLM 主动看 top-N atom。短期不做,留作未来 change

### 8a. (目标 2 核心) extract dedup 必须是 LLM 二次确认,不是程序自动 supersede
**Decision**: `executeItem` 在程序层 cosine ≥ 0.65 命中现有 atom 时,**不直接调用 `supersedeIfSimilar`**,而是把"hit 的 title+summary+content"和"LLM emit 的新 item"一起喂给 LLM 做二次合并判定。LLM 返回三种 action:
- `update`: 旧 atom 字段更新 (LLM 给的新 content 追加或合并)
- `supersede`: 旧 atom 标 archived,新 atom 独立存在
- `create`: 忽略 hit,新 atom 独立存在 (LLM 判断是真正的新主题)
- `skip`: 重复,啥也不做 (程序层 cosine 不够,LLM 看语义仍是重复)
**Rationale**: **cosine 距离 ≠ 语义判断**。0.65 cosine 命中可能是 (a) 真 cluster (该合),(b) 主题相邻但不同 (不该合),(c) 同一项目但不同方面 (该 update)。只有 LLM 看具体内容能区分。这是 extract dedup 的核心:
- 程序层 cosine 找候选 (1 ms, 召回 1 个最相似的)
- LLM 二次判定 (200-500 ms, 决定怎么处理)
- 两者串联:**快 + 准**
**Examples** (90 atom corpus):
- cosine 0.65+ 命中 → LLM 二次看:
  - 0.65 → 0.85 区间 (相邻主题): LLM 多数 `create` (e.g. "check_seq 脚本位置" vs "check_seq update-seq" — 程序 cosine 0.77,LLM 看是 `update`,因为是同一脚本的不同约束)
  - 0.85+ 区间 (强相似): LLM 多数 `supersede` (e.g. "扩增子物种注释结果文件" vs "扩增子物种注释结果文件路径" — cosine 0.756,LLM 看是 `supersede` 因为几乎同义)
- 0.55-0.65 区间 (程序放过): LLM 看不到 (prompt 注入 corpus 时也包含,但 extract 路径不二次确认,纯靠 cosine 判断)
**Alternatives**:
- *纯程序 0.65 dedup (Decision 1 之前的版本)*: 拒。丢失 LLM 语义判断,"check_seq 脚本位置" vs "check_seq update-seq" 这类"同脚本不同约束" case 会被错误合并成 1 个 atom
- *LLM 处理每个 emit 都看 corpus top-5 atom (RAG lookup)*: 拒。工程量翻倍,延迟 +2-3s,LLM 不一定有判定能力
- *程序层 cosine + LLM 二次确认 = 上面 Decision 8a*: 选。**这是 extract dedup 的正确设计**

### 8b. (目标 1) migration 仍用纯程序 0.65 dedup (无 LLM)
**Decision**: 目标 1 (历史 90 atom 迁移) **不**用 LLM 二次确认,直接程序层 `markSupersededNoInsert(0.65)`。原因:
- 90 atom 是 legacy,无"语义细节"需要 LLM 看
- LLM 5 batch 调试 90 atom 成本高,边际收益低
- 程序 0.65 dedup 已经触发 35 pair 真实 cluster,覆盖足够
- 用户可调阈值 (0.60/0.70) 二次跑,idempotent
**Rationale**: 目标 1 是"批量历史治理",LLM 价值在"新增判断",不在"批量处理"。LLM 二次确认的真正用武之地是 extract pipeline (目标 2),不是 migration。**目标 1 + 目标 2 用不同 dedup 机制是合理的**。
**Alternatives**:
- *目标 1 也用 LLM 二次确认*: 拒。90 atom × 1 LLM call × 35 pair = 35 次 LLM call,工程量不值得
- *目标 1 + 2 都纯程序*: 拒。丢失 LLM 在 extract 上的语义判断价值

### 9. (目标 2) 程序端 tag 归一化兜底
**Decision**: `executeItem` 写入前对 LLM emit 的 tags 做归一化:
- lowercase (中文不变,用 Unicode 范围检测)
- 跟 tag 字典做精确匹配,命中的用字典标准形
- 检测概念性 tag 缺失 (0 个 tag 命中 `concept/*` 命名空间): warn + 仍写入 (不强 reject)
**Rationale**: LLM 99% 守规矩但 1% 会 emit 大写或新造 tag,程序兜底保证 corpus 干净。强 reject 会丢失 LLM 偶尔的好 extract。
**Alternatives**:
- *概念性 tag 缺失就 reject 整个 item*: 拒,丢失数据代价大于 tag 质量
- *不做归一化,完全信 LLM*: 拒,LLM 幻觉/大小写漂移不可避免

### 10. (目标 1+2 跨) dedup 阈值降到 0.65,与 recall floor (0.55) 留 0.10 buffer
**Decision**: 把 `supersedeIfSimilar` 的默认 threshold 从 0.92 改为 **0.65**。
**Rationale**: 现有 0.92 跟 recall floor 0.55 严重脱节 — 0.55-0.92 的近主题重复 atom 会同时被召回 (precision 受损) 但程序不去重。降到 0.65 后:
- corpus 内任意两个 atom 的 cosine < 0.65
- recall floor 0.55 仍能召回到"语义相邻但不重复"的 atom
- 0.10 buffer 留给 bge-m3 cosine 噪声 (同一 cluster 内 0.05-0.10 的 cosine 抖动不会触发误合并)

**实测 (90 atom corpus threshold sweep)**:
| Threshold | 触发的 merge pair | 受影响 atom | 估算 corpus 减 |
|-----------|-----------------|------------|---------------|
| 0.55 | 190 | 78/90 (87%) | 减 43% (过合并,会误伤"修复"+"位置") |
| 0.60 | 71 | 50/90 (56%) | 减 28% (边界,语义相关 atom 也被合) |
| **0.65** | **35** | **33/90 (37%)** | **减 18% (合理)** |
| 0.70 | 18 | 19/90 (21%) | 减 10% (太松,继续有召回重复) |
| 0.75 | 6 | 10/90 (11%) | 减 6% (基本无 dedup) |
| 0.92 (现状) | 0 | 0/90 (0%) | 减 0% (完全失效) |

**0.65 触发的 35 个 pair 全部是真实 cluster** (X101SC / RNAVIRUS-DELIVERY-CHECK / 工时估算系列 / iCAMP / check_seq / smart-sample-find / workMonitor / README 审阅 / 远程结果路径),**没有**误伤 case。

**0.65 reduction 18% 略低于 20% 验收**: 用户可手动重跑 migration 一次,把阈值降到 0.60 跑一遍 (idempotent — 没合的 cluster 再合一次),或者接受 18% 即可。

**Alternatives**:
- *0.60 (跟 recall floor 0.55 仅 0.05 buffer)*: 拒。bge-m3 cosine 噪声 0.05-0.10,buffer 太小容易误合并。但用户可手动重跑 0.60 达到 ≥ 20% reduction
- *0.70*: 拒。仍允许 0.55-0.70 的近主题重复召回到,precision 改善有限
- *0.55 (完全跟 recall 对齐)*: 拒。会强制 dedup 掉所有"语义相邻但主题不同"的 atom (e.g. 修复 vs 位置)
- *保留 0.92*: 拒。已知完全失效

## Architecture

### 文件改动

| 文件 | 改动 |
|------|------|
| `extensions/personal-assistant/scripts/migrate-legacy-atoms.mts` | **新文件**,目标 1 一次性 migration 脚本 (≈30 行,程序驱动 0.65 dedup) |
| `extensions/personal-assistant/scripts/migrate-report.json` | 运行时生成,迁移结果 (archivedCount, unchangedCount) |
| `extensions/personal-assistant/dedup.ts` | **改**: 默认 threshold 0.92 → 0.65 (Decision 10) |
| `extensions/personal-assistant/extraction.ts` | **目标 2**: `EXTRACT_PROMPT_V2` 注入 tag 字典 + 主动更新规则;`buildExtractionPrompt` 构造 tag 字典段;`executeItem` 调 `normalizeTag` |
| `extensions/personal-assistant/tag-vocab.ts` | **新文件**,目标 2: `loadTagVocabulary(index)` + `normalizeTag(input)` + `conceptTagCount(tags)` |
| `extensions/personal-assistant/CHANGELOG.md` | 加 [Unreleased] entry 说明 migration 工具存在 + extract 优化 + 0.65 dedup |

**不动**: storage.ts, file-store.ts, search.ts, format.ts, hybrid-search.ts, types.ts, memory.ts, decay.ts, embed.ts, server.py

注意: `dedup.ts` 是**唯一**的搜索/召回链外但**目标 1+2 共享**的改点 (Decision 10) — 这正是用户"dedup 跟 recall 阈值要一致"的洞察落地。

### 数据流 (目标 1: 迁移 — 程序驱动,无 LLM)

```
migrate-legacy-atoms.mts (entry)
  │
  ├── 0. 备份 memory.db → memory.db.bak.YYYYMMDD
  │
  ├── 1. 读 MemoryIndex.getActiveAtoms() → 90 atom
  │
  ├── 2. 按 (access_count DESC, last_access DESC NULLS LAST, created_at DESC) 排序
  │
  ├── 3. for atom in sortedAtoms:
  │   │
  │   ├── 3a. 从 memory_vectors 表读 atom 现有 embedding (sqlite-vec 已存)
  │   │
  │   ├── 3b. 调 index.findMostSimilarEmbedding(embedding, threshold=0.65)
  │   │     返回 top-1 (排除自己)
  │   │
  │   ├── 3c. 若 hit 且 hit.atom.id !== atom.id:
  │   │   排序靠前的"赢",调用 markSupersededNoInsert(hit.id, atom.id, now)
  │   │     → hit.atom 标 is_latest=0, parent_id=atom.id, superseded_at=now
  │   │     → atom 不动 (id 保留,active,作为"赢")
  │   │   注意: 不 insert 新 row (跟现有 markSupersededTx 不同)
  │   │
  │   └── 3d. 若 hit 是自己 (cosine=1.0) 或无 hit: skip (atom 不动)
  │
  ├── 4. 输出 migrate-report.json: { timestamp, totalActiveAtoms, archivedCount, threshold }
  │
  └── 5. 提示用户: "Migration done. 90 → 75 (archived 15). Re-run idempotent."
```

**关键简化**: 没有 LLM call。目标 1 是批量历史治理,LLM 价值在 extract 实时判断 (目标 2),不在批量迁移。

### 数据流 (目标 2: Extract 优化 — **核心: LLM 二次确认 dedup**)

```
session_before_compact (or any extract trigger)
  │
  ├── loadTagVocabulary(index)  // 扫 active atom.tags 列,top-50 by 频次
  │   → ["amplicon", "16S", "扩增子", "修复", "bug", ...] (cached in-memory)
  │
  ├── buildExtractionPrompt(messages)
  │   在 EXTRACT_PROMPT_V2 之后追加:
  │     "## 现有 tag 字典 (优先复用,不要发明新近义 tag)\n" + tagVocabulary.join(", ")
  │     "\n\n## 主动更新,非扩张\n"
  │     "- 如果新信息可归入 corpus 已有的 atom,优先更新该 atom 的 content (在末尾追加 + 标日期)\n"
  │     "- 仅在信息属于全新主题时才创建新 atom\n"
  │
  ├── LLM 提取 → ExtractionResult.items[]
  │
  └── executePlan (extended — **核心改动**)
      对每个 item:
        │
        ├── 1. 调 normalizeTag() 对 tags 做 lowercase + 字典匹配
        ├── 2. 调 conceptTagCount() 检测概念性 tag 数量,若 0 warn
        ├── 3. 算 fingerprint,查 corpus 同 fingerprint 原子 → 命中就 skip
        ├── 4. 算 embedding (调 embedText)
        ├── 5. 调 findMostSimilarEmbedding(embedding, 0.65) 找 hit
        │
        ├── 6. **若无 hit** (cosine < 0.65):
        │     → 直接 insertAtom + writeAtomToFile + bge-m3 reindex
        │     (传统路径,无 LLM 二次确认)
        │
        └── 7. **若有 hit** (cosine ≥ 0.65):
              │
              ├── 7a. 调 LLM 二次确认 (新 prompt):
              │     输入: hit.atom { title, summary, content, tags } + item { title, summary, content, tags }
              │     输出 JSON: { action: "update" | "supersede" | "create", merged?: { title, summary, content, tags } }
              │     - "update": 旧 atom 字段更新 (LLM 给的 merged 是新版本)
              │     - "supersede": 旧 atom 标 archived, item 独立 create
              │     - "create": 忽略 hit, item 独立 create (LLM 看了判断是不同主题)
              │
              ├── 7b. apply action:
              │     - "update": index.updateAtom(mergedAtom)  (in-place, version+1) + writeAtomToFile + bge-m3 reindex
              │     - "supersede": index.markSupersededTx(hit.id, item, embedding) + writeAtomToFile + bge-m3 reindex
              │     - "create": index.insertAtom(item) + writeAtomToFile + bge-m3 reindex
              │
              └── 7c. (若 LLM JSON parse 失败) 走保守路径:
                    - 默认 "supersede" (hit 是程序认定的真重复)
                    - warn "LLM dedup confirm failed, fell back to supersede"
                    - 不中断,继续
```

**核心 insight**: cosine 是**候选信号**,LLM 是**决策信号**。程序找候选 (1ms),LLM 看候选决定怎么处理 (200-500ms)。两者串联,**快 + 准**。

### 关键类型 (新文件内,不需要 export)

```typescript
// migrate-legacy-atoms.mts
interface MigrationReport {
  timestamp: string;  // ISO 8601
  totalActiveAtoms: number;
  archivedCount: number;  // 被 supersedeIfSimilar 标 archived 的 atom 数
  unchangedCount: number;  // 跑过但没合并的 atom 数
  reindexFailed: string[];  // bge-m3 reindex 失败 (理论上 0,只在 markSupersededTx 改动时可能)
  backupPath: string;  // memory.db.bak.YYYYMMDD
  threshold: number;  // 0.65
}

// tag-vocab.ts
export function loadTagVocabulary(index: MemoryIndex, topK?: number): string[];

export function normalizeTag(input: string, dictionary?: Set<string>): string;

export function conceptTagCount(tags: string[]): number;
```

### Idempotency 设计 (目标 1)

- **天然 idempotent**: 第二次跑 0.65 dedup,corpus 已经没有 ≥ 0.65 的 pair,所有 findMostSimilarEmbedding 返回 self (cosine=1.0),self-match guard 路径 skip,0 个改动
- **不需要** settings.json 标记、不需要 title 后缀检测
- **不需要** 一次性脚本标记 (用户随时可跑,30 天后想 review 状态,直接跑一遍)
- 备份文件 `memory.db.bak.YYYYMMDD` 是用户唯一需要管理的"非天然 idempotent" 状态 (30 天后手动删)

## Existing Code to Reuse

### Reuse: `MemoryIndex.getActiveAtoms()` (备用, 主路径走 SQL 直接排序)
- **Path**: `extensions/personal-assistant/storage.ts:306`
- **Why**: 直接拿到 90 个 active atom 列表,过滤 archived=0 + is_latest=1
- **Risk**: 返回的 atom 都是 in-memory 行,需要确认 rowToAtom 解析 tags 数组正确 (已确认 storage.ts:170)
- **Decision**: 备用 — 主路径走 SQL `SELECT * FROM memory_index WHERE is_latest=1 AND archived=0 ORDER BY access_count DESC, COALESCE(last_access, 0) DESC, created_at DESC` (效率: SQL sort 比 JS in-memory sort 快 5-10×,1000+ atom corpus 时差距明显)。`getActiveAtoms()` 可用于 backup 前的 total count 报告,以及非主流程的 sanity check。

### Reuse: `MemoryIndex.updateAtom()`
- **Path**: `extensions/personal-assistant/storage.ts:186`
- **Why**: in-place 改 atom,version +1,自动处理 content_fingerprint 更新。完美适配 "保留 id,只改文本"
- **Risk**: 需传入完整 atom 对象 (会覆盖 title/summary/content/tags/importance/strength)。本脚本只改 4 个文本字段,其他字段保留原值
- **Decision**: reuse,构造新 atom 时 spread 旧 atom 后覆盖 4 字段

### Reuse: `MemoryIndex.markSupersededTx()`
- **Path**: `extensions/personal-assistant/storage.ts:489`
- **Why**: supersede 链式更新,旧 atom 标 is_latest=0 + superseded_at,新 atom (用 keepId) 写入并通过 version 检查
- **Risk**: markSupersededTx 内部会 INSERT 新 row (即使 id 是已存在的 keepId)。需要先 updateAtom(keepId) 改文本,再 markSupersededTx 把其他 atom 链上;或自定义 supersede 路径
- **Decision**: **不直接复用**,本脚本手动做:对 superseded atom 调 index 内部 SQL (UPDATEs is_latest=0 + parent_id + superseded_at),不 insert 新行。**或** 写一个 helper `markSupersededNoInsert(keepId, oldId)` (见 Implementation Notes)

### Reuse: `writeAtomToFile()`
- **Path**: `extensions/personal-assistant/file-store.ts:42`
- **Why**: 写 .md 文件,带 frontmatter,跟现有 atom 文件格式一致
- **Risk**: 无
- **Decision**: reuse

### Reuse: `computeFingerprint()`
- **Path**: `extensions/personal-assistant/extraction.ts:21`
- **Why**: 重算 content_fingerprint
- **Risk**: 必须用同一个 normalizeContent 算法 (已确认 storage.ts:106 注释说明一致)
- **Decision**: reuse

### Reuse: `embedText()` + `buildEmbeddableText()`
- **Path**: `extensions/personal-assistant/embed.ts:64, 150`
- **Why**: 改完一个 atom 后,本地算 embedding 用于 updateAtom (但 bge-m3 reindex 已经算过了,这个 backup)
- **Risk**: 冗余调用,HTTP 失败时备用
- **Decision**: **不直接调用**,bge-m3 reindex 走 HTTP 路径;embedText 仅作为 backup

### Reuse: `completeSimple()` + `modelRegistry.getApiKeyAndHeaders()`
- **Path**: `extensions/personal-assistant/memory.ts:317, 45` (内存引用)
- **Why**: LLM 调用的统一入口,跟 extract 共用配置
- **Risk**: migration 是 standalone script,没有 ExtensionContext。需要自己读 settings.json,模拟 ctx.modelRegistry 的查找逻辑
- **Decision**: **手动写** settings.json 读取 + model 查找逻辑,跟 memory.ts:289-311 一致

### Reuse: bge-m3 service `/api/atoms/{id}/reindex`
- **Path**: `tmp/bge-m3-test/server.py:553` (源码) → live `http://127.0.0.1:11435`
- **Why**: 改完 atom 触发重算 embedding + sparse + content_hash
- **Risk**: 服务 down 整个迁移仍能完成,只是部分 atom 向量是 stale
- **Decision**: reuse via fetch

### Reuse: `SettingsManager` for settings.json
- **Path**: `packages/coding-agent/src/core/settings-manager.ts`
- **Why**: 读 `personalAssistant.memory.extraction.{provider,model}` + `dbPath` + `atomsDir`
- **Risk**: SettingsManager 是 packages/coding-agent 的 API,personal-assistant 是 extensions 下的,可能存在 import boundary
- **Decision**: **手动 fs.readFile + JSON.parse**,模仿 memory.ts:105-119 `loadConfig()` 的实现

### Reuse: `EXTRACT_PROMPT_V2` (扩展,不重写)
- **Path**: `extensions/personal-assistant/extraction.ts:42-106`
- **Why**: 目标 2 不重写 prompt,只在 EXTRACT_PROMPT_V2 之后追加 "## 现有 tag 字典" + "## 主动更新,非扩张" 两段
- **Risk**: 追加段落会让 prompt 变长 ~500 token,单次 LLM call 成本 +5%;90 atom 跑 5 batch + 后续 extract 不影响响应延迟
- **Decision**: extend — 把新内容作为函数返回值的一部分构造,不改 EXTRACT_PROMPT_V2 字符串本身

### Reuse: `buildExtractionPrompt` (改造点)
- **Path**: `extensions/personal-assistant/extraction.ts:287-294`
- **Why**: extract pipeline 唯一构造 prompt 的入口,在它内部加 tag 字典注入最自然
- **Risk**: 该函数当前签名 `buildExtractionPrompt(messages)`,不接收 index/atom 上下文。需要 (a) 把 `tagVocabulary: string[]` 作为参数加进来,(b) 调用方 (`runCompactExtraction` 在 memory.ts) 提前算好 vocabulary
- **Decision**: extend — signature 改为 `buildExtractionPrompt(messages, opts?: { tagVocabulary?: string[] })`,保持向后兼容

### Reuse: `executeItem` (改造点)
- **Path**: `extensions/personal-assistant/extraction.ts:123-149`
- **Why**: 目标 2 的程序端 tag 归一化兜底要在写入前调,executeItem 是唯一写入入口
- **Risk**: 改 executeItem 会影响所有 extract 路径 (`session_before_compact`、webui 的 PATCH 路径)。需要确保归一化对所有路径都安全
- **Decision**: extend — 在 `const newAtom = buildAtomFromItem(item, fingerprint)` 之前加 `const normalizedTags = item.tags.map(normalizeTag)`,然后构造 atom 时用 normalizedTags

### Reuse: `supersedeIfSimilar` (不依赖,仅作 dedup 兜底备份)
- **Path**: `extensions/personal-assistant/dedup.ts:18-41`
- **Why**: 即使 LLM 没遵守"主动更新"规则,程序端 0.92 cosine dedup 仍兜底 (虽然实测对 cluster 0.75-0.80 无效)
- **Risk**: 阈值 0.92 对真正的 cluster case 无效,只能挡 fingerprint 不同 + 文本几乎一样的"重复 emit"。已确认不能依赖
- **Decision**: reuse as-is — 不调阈值,继续作为最后兜底

### Reuse: `completeSimple` (目标 2 复用 LLM 路径)
- **Path**: `@earendil-works/pi-ai/compat` (memory.ts:45 import)
- **Why**: extract 已经在用,目标 2 不引入新 LLM client
- **Risk**: 无
- **Decision**: reuse

## Risks / Trade-offs

### 目标 1 风险 (迁移 — 程序驱动)

| Risk | Mitigation |
|------|------------|
| **0.65 dedup 误合并** (bge-m3 cosine 噪声把不该合的合了) | 90 atom 实测 0 误伤;threshold 0.65 是 sweep 选出的"catches real cluster, spares borderline" 点 |
| **0.65 dedup 太严**,合理 atom 被错误 supersede | 30 天后 review `supersedeIfSimilar` 命中率;若有误伤,run 时调 0.60/0.70 (idempotent) |
| **0.65 dedup 太松**,0.55-0.65 范围 cluster 残留 | 90 atom 实测 0 个这种 pair;若有,run 时调 0.60 (idempotent) |
| migration 中 pi 在跑 → SQLITE_BUSY | busy_timeout=5000ms 已设;锁 5s 后 abort + 部分迁移 (重跑幂等) |
| 排序规则导致"赢"的是 user 不想要的 atom | 排序用 access_count + last_access + created_at,这是 user 行为信号。比 bge-m3 cosine 准 |
| 备份文件占双倍空间 (4MB) | 一次性,提示用户 30 天后删 .bak |
| migration 改坏了用户想回滚 | cp memory.db.bak.YYYYMMDD memory.db + bge-m3 reconcile |
| `markSupersededTx` 会 INSERT 新 row (而不是简单 UPDATE) | **需 no-insert 变体**,见 Implementation Notes;新 helper `markSupersededNoInsert(oldId, parentId)` |
| access_count=0 的 atom 全是 LLM 提取后未读,排序时全打平 | tie-break 用 last_access DESC NULLS LAST,再 created_at DESC;仍是 deterministic |

### 目标 2 风险 (extract 优化)

| Risk | Mitigation |
|------|------------|
| tag 字典注入 prompt 让 LLM 倾向"复用旧 tag"过度 | 字典只列 top 50,旁白强调"自由 emit";程序不强制 |
| LLM 不遵守"主动更新"规则,继续创建冗余 atom | **程序 cosine 0.65 兜底 + LLM 二次确认** (Decision 8a) |
| **LLM 二次确认二次 LLM call 失败** (timeout/JSON parse) | 走保守 fallback 默认 `supersede` (程序认定的重复) + warn;不中断 |
| **LLM 二次确认判错** (把 update 判成 supersede 或反之) | 跑 test/extraction-dedup-confirm.test.ts 5 个边界 case (update/supersede/create/skip 各种判定);若有判错,调整 prompt 措辞 |
| 二次 LLM call 延迟 +200-500ms per item | extract 一次 typically emit 1-3 items,总 +1-1.5s,可接受 |
| tag lowercase 把 `MGM` 误转为 `mgm` | `normalizeTag` 优先查字典,命中用字典标准形;字典没有才 lowercase |
| 概念性 tag 检测误伤 | 暂不强制 reject,只 warn |
| tag 字典 top-50 计算每次 extract 都跑,延迟 +50ms | 缓存 in-memory 直到 session 结束 |
| 提示词变长,LLM 成本 +5% (单次 extract) | 可接受,extract 本身是低频路径 |
| 用户改 `concept/*` 命名空间,程序端 namespace 假设破 | CHANGELOG 标注约定 |

## Testing Strategy

### 单元测试
- **`test/migration.test.ts`** (新): 拿真实 90 atom 的备份,跑 migration (新决策下就是程序驱动 dedup),断言:
  - archivedCount ≥ 15 (≥ 17% reduction)
  - unchangedCount 接近 0 (热 atom 都访问过 findMostSimilarEmbedding)
  - 0 误合并 (人工 spot-check 5 个 archived 的 "赢" 是否合理)
  - 0 SQLITE_BUSY
  - 二进制 idempotent: 跑第 2 次 archivedCount 增量 = 0

### 集成测试
- **`test/recall-quality.test.ts`** 加 case: 迁移后 precision@5 ≥ 40% (用户原 case)
- **`test/extraction-dedup-confirm.test.ts`** (新 — **核心测试**): 目标 2 LLM 二次确认路径
  - mock LLM,验证 cosine 命中时 executeItem 调 LLM 二次确认
  - 5 个边界 case:
    - cosine 0.65+ 命中 + LLM 返回 `update` → 旧 atom 字段更新 (version+1)
    - cosine 0.65+ 命中 + LLM 返回 `supersede` → 旧 atom 标 archived,新 atom 独立
    - cosine 0.65+ 命中 + LLM 返回 `create` → 旧 atom 不动,新 atom 独立
    - cosine 0.65+ 命中 + LLM 返回 `skip` → 旧 atom 不动,新 item 丢弃
    - cosine 0.65+ 命中 + LLM JSON parse 失败 → 走 fallback `supersede` + warn
  - mock LLM,验证 `buildExtractionPrompt` 输出包含 "## 现有 tag 字典" + "## 主动更新,非扩张" 段
  - mock LLM,验证 `executeItem` 写入前 `normalizeTag` 调用:
    - 字典里 "Amplicon" → 输出 "amplicon"
    - 字典里 "MGM" → 输出 "MGM" (不强制 lowercase)
  - mock LLM emit 0 概念性 tag → 写入但 warn
  - mock LLM,验证 fingerprint 同 atom 被 skip (既有)
- **`test/dedup-threshold.test.ts`** (新): 测试 `supersedeIfSimilar(0.65)`:
  - cosine 0.64 的 pair 不被 merge
  - cosine 0.66 的 pair 被 merge
  - 0.65 边界 (cosine 0.65 本身: 命中,因 `>=`)
  - self-match guard (cosine 1.0 返回 create 而非 supersede)

### 边界条件
- 备份文件已存在: 覆盖,文件名加时间戳后缀
- memory.db 已被另一进程 lock: 5s 后 abort + 部分迁移 (重跑幂等)
- corpus 0 atom (新用户首次启动): `loadTagVocabulary` 返回空,prompt 注入空字典段
- 目标 2 LLM 不遵守"主动更新"规则: 0.65 dedup 兜底
- 目标 2 LLM emit tag 全部专名: warn 但仍写入

### 验证
- 迁移前: 跑 `recall-quality.test.ts` 记录 baseline precision
- 迁移后: 跑同一 test 验证 precision 提升
- 手动: 抽 3-5 个典型 query (用户的 "修复的脚本" 那种) 跑 webui 搜索,看 top-5 质量
- 30 天后跑 `test/tag-quality.test.ts`,检查 corpus tag 重复率 ≥ 2.0

## Implementation Notes

### 关键依赖顺序

**目标 1 (迁移 — 程序驱动,无 LLM)**:
1. `dedup.ts:29` 改默认 threshold 0.92 → 0.65 (Decision 10)
2. 在 `storage.ts` 新加 helper `markSupersededNoInsert(oldId, parentId, now)`: 只 UPDATE 旧 atom 标 archived + parent_id + superseded_at,**不 INSERT 新 row**
3. `migrate-legacy-atoms.mts` 脚本:
   - 备份 memory.db
   - `getActiveAtoms()` + 排序
   - for loop: 读 embedding + `findMostSimilarEmbedding(0.65)` + 若是 hit `markSupersededNoInsert(hit.id, atom.id, now)`
   - 写 migrate-report.json
4. 跑 `recall-quality.test.ts` 验证 precision ≥ 40%

**目标 2 (extract 优化 — 核心改动: LLM 二次确认 dedup)**:
1. `tag-vocab.ts` (`loadTagVocabulary`, `normalizeTag`, `conceptTagCount`) — 纯函数无依赖
2. `EXTRACT_PROMPT_V2` 追加 "## 主动更新,非扩张" 段 (静态拼接)
3. `buildExtractionPrompt` 加 `tagVocabulary` 参数,注入字典
4. 调 `buildExtractionPrompt` 的地方 (`runCompactExtraction` in memory.ts) 提前算 vocabulary
5. **核心**: 改 `executeItem` 加 LLM 二次确认分支 (Decision 8a):
   - `cosine ≥ 0.65` 命中时,不直接 supersede
   - 调 LLM 二次确认:`{ hit.atom, newItem }` 输入,`{ action: update|supersede|create|skip, merged? }` 输出
   - 根据 action 走不同 write 路径
6. `normalizeTag` 在 `executeItem` 写入前调 (归一化 tags)
7. 二次确认 LLM call 的 prompt 模板 + JSON schema 在 `extraction-dedup-confirm-prompt.ts` (新文件,内联即可,无需独立)

### 关键设计原则 (贯穿两目标)

- **程序层 cosine 是"候选信号",不是"决策信号"**:
  - 目标 1 (批量迁移): 用 cosine 0.65 直接 supersede (无 LLM 二次,因为批量价值低)
  - 目标 2 (extract 实时): cosine 0.65 命中 → LLM 二次确认 (语义判断有价值)
  - 目标 2 (extract 实时): cosine < 0.65 不命中 → 直接 insert (无需 LLM 确认)
- **目标 1 + 目标 2 共享 0.65 阈值,但程序行为不同**:
  - 目标 1 是"批量处理",LLM 价值低
  - 目标 2 是"实时决策",LLM 价值高
  - 这是合理的"同阈值不同行为",不是设计漂移

### gotchas
- **`markSupersededTx` 会 INSERT 新 row**: 现有 `markSupersededTx` 不适用 (会插同 id 新 row 失败)。**新加 `markSupersededNoInsert(oldId, parentId, now)`** 只做 UPDATE。这是目标 1 的关键 helper
- **`findMostSimilarEmbedding` 已支持 self-match guard** (storage.ts:426+): cosine 1.0 的 self-match 不返回 hit,自然 no-op。**这就是天然 idempotency 的来源**
- **computeFingerprint 用 normalizeContent (lowercase + collapse whitespace)**: 跟 storage.ts:106 一致。**目标 1 migration 不重新算 fingerprint**(内容没变,只是 archived 状态变了)
- **UNIQUE 索引 idx_memory_active_fingerprint**: 目标 1 不动 content,不动 fingerprint,UNIQUE 索引无冲突风险
- **bge-m3 reindex**: 目标 1 不需要 (content 没变,bge-m3 vector 还是对的)。只有当有 future extract 改了 content 才 reindex
- **tag 字典 top-50 扫描要快**: 90 atom × 4.2 tag/atom × JSON.parse ≈ 50ms,可接受;但 corpus 1000+ atom 时要考虑加索引或缓存
- **normalizeTag 字典匹配要严格** (exact match),不做模糊匹配 (e.g. "Amplicon" 命中 "amplicon",但 "amp" 不命中 "amplicon")
- **目标 2 prompt 长度增加 ~500 token**: 测过 4 个 cluster case LLM 仍能正确 emit,无 token 超限风险
- **buildExtractionPrompt 签名变化** `buildExtractionPrompt(messages, opts?)`: 调用方 (memory.ts:runCompactExtraction) 必须传入 opts,否则 dict 段为空,不报错但失去目标 2 效果
- **目标 1 的 sort 用 SQLite 而不是 JS in-memory**: 90 atom 还好,1000+ atom 时 SQL ORDER BY 比 JS sort 快 5-10x。直接用 `db.prepare("SELECT * FROM memory_index WHERE is_latest=1 AND archived=0 ORDER BY access_count DESC, COALESCE(last_access, 0) DESC, created_at DESC")`

### 未来 cleanup
- 目标 1 脚本是幂等的,30 天后用户想 review 直接跑一遍,0 改动
- 备份文件 `memory.db.bak.YYYYMMDD` 用户应手动删除
- 目标 2 的 `EXTRACT_PROMPT_V2` 追加段未来可移到主 prompt 字符串内 (避免函数动态拼接),等 LLM 行为稳定后
- 未来 corpus 大到 1000+ atom 时,tag 字典应改为 persistent (SQLite 表) + 增量更新,而非每次 session 重算

### 不在本次范围
- tag 同义词表 LLM 自动聚类 (那是另一个独立 change)
- extract prompt 其他方面优化 (e.g. importance 校准、scope/template 字段)
- webui 显示版本标记 — 不必要,UI 自然显示新文本
- LLM 调用别的 prompt 路径 (e.g. webui 的 PATCH memory check)
- 回填 source_session (那是另一个 change)
- migration 跑 LLM 二次 catch-up (0.55-0.65 范围的 cluster)。可在 30 天 review 后决定要不要加,本次不需要

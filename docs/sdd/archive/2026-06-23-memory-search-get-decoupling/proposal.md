# 变更提案: memory-search-get-decoupling

## 动机

memory-v2 当前的召回链路有 3 个结构性问题,导致 agent 端的 recall→act 闭环不清晰:

1. **search 和 get 没分离** — search 返回 `file_path`,agent 用 `read(file_path)` 拿全文,但 `read()` 不向记忆系统反馈"这个 atom 真的被用到了"。`access_count` 是在 search 阶段 bump 的(每次召回都 +1),所以 strength 反映的是"被看到过几次",不是"被实际用过几次"。
2. **importance 来源不可控** — extraction LLM 默认给 importance 0.5,有时候 0.85,体现不出用户消息里的语气强度("千万", "务必", "必须" 这些应该对应 high importance)。LLM 自己判断,但没有 hint,容易给保守打分。
3. **search 没类型多样性保证** — 单 KNN 全局排序,top-10 可能全是 rule,完全漏掉 process / fact。LLM 拿到 8 条相似的 rule 不知道怎么用,真正相关的 process atom 排在 11 位之外。

本变更把 search / get / importance 三个动作解耦:search 是纯向量召回(无 metadata scoring,无文件路径,无 access 反馈),get 是显式的"我去拿全文"动作(自动 bump strength),importance 由用户语气词驱动(作为 hint 传给 extraction LLM)。

## 影响范围

- **新增 Capability**:
  - `memory_get` tool — agent 可调,输入 atom id,返回 full atom + content,**自动 bump `access_count` 和 `last_access`**。
  - `scoreUserTone(messages)` — extension 内部函数,扫描最近 user 消息中的语气词,返回 `{level, score}`(strong/habit/neutral/weak),作为 importance 的 hint 注入 EXTRACT_PROMPT_V2。
  - 中英语气词词表 (STRONG / HABIT / WEAK / NEUTRAL 四档,每个档次 ~5-8 个词)。
- **修改 Capability**:
  - `memory.search` (POST /api/memory/search + `recallAtoms`) — 响应**不返 file_path**,**不 bump access_count**。改成 per-type top-3(分层 KNN,rule/fact/process 各取 score 最高的 3 条,共最多 9 条)。**组内加权公式** `score = cosine × (1 + 0.3 × strength + 0.2 × importance)`,按 score DESC 排序;**组间 round-robin 交错**。`RecallResult` 类型删 `file_path` 字段,**新增** `score: number` 字段(给 UI/debug 用,LLM 不通过 prompt 看到)。
  - `memory.get` (GET /api/memory/:id) — **不 bump access_count**(preview-only,供 webui MemoryEditor 用)。bump 走 agent 端的 `memory_get` tool,见下方新增 Capability。
  - `formatMemoryContext` / `formatMemoryBlock` — 块输出从 `[type] title\nsummary\nfile: <path>\nTags: ...` 改成 `[type] title\nsummary\nid: <uuid>\nTags: ...`。LLM 看到 id 就知道调 `memory_get(id)` 拿全文。注入 prompt 时**仍按 distance asc 全局排序**(只看 cosine 主键,score 仅影响 search response / debug 视图)。
  - `EXTRACT_PROMPT_V2` — 在 `<Importance>` 段前新增 `<User Tone>` 段,把 `scoreUserTone()` 的结果作为 hint 传给 LLM(`level=strong → importance >= 0.9`)。
- **删除 Capability**: 无

## 非目标

- **不改** agent 端 `read()` 工具 — agent 用 `memory_get(id)` 替代 `read(path)`,不再需要 `read()` 拦截 hook。
- **不改** webui MemoryEditor 自动 preview — 用户在 UI 看 atom 详情**不**算"get",不 bump strength(programmatic get only)。
- **不重新实现** extraction pipeline 其他部分(dedup / supersede / write 等不动)。
- **不** 把 tone scoring 也用于 search-time rerank — 只在 extraction 写入时用,不改 recall 公式。
- **不改** `runDecay` 现有行为 — baseDecay=0.05、archiveThreshold=0.1、rule 永不 archive 全部保留。新的 score 公式自动利用 strength 衰减信号,无需修改 decay 逻辑。
- **不** 让 `formatMemoryContext` 保留 round-robin 顺序 — 它会再按 distance asc 全局排序,交错顺序只在 search response 里存在。
- **不** 用多键 strict-equality 排序(cosine → strength → importance) — 在实际浮点 cosine 上 strict equality 几乎永远不触发二级键,等于纯 cosine。改用乘法 boost 公式(score = cosine × (1 + 0.3×strength + 0.2×importance)),让 strength/importance 持续参与每次排序。
- **不** 把 score 注入 LLM prompt — score 仅给 UI / debug / 测试 snapshot。`formatMemoryContext` 注入 prompt 时只看 cosine。

## 验收标准

1. **search 行为变更**:`POST /api/memory/search` 响应中**不包含** `file_path` 字段,也不包含 `tier` / `formattedText` / `tokenBudgetUsed` (这些之前已删)。响应形状: `{results: [{id, type, title, summary, tags, distance, cosine, score}], recallTimeMs}`(`score` 是新增字段)。
2. **search 不 bump**:`recallAtoms` 调用 1 次后,DB 中所有返回的 atom `access_count` 保持不变(0→0)。
3. **search 多样性**:6 个 atom(2 rule + 3 fact + 1 process),query "lima 拆分" 召回 → 结果必须包含 2 个 rule + 3 个 fact + 1 个 process(per-type top-3,稀疏 process 自动降到 1),**总数 = 6**。
4. **search 加权公式 score = cosine × (1 + 0.3 × strength + 0.2 × importance)**:5 个测试用例:
   - atom A(cosine=0.7, strength=1.0, importance=1.0)→ score = 0.7 × 1.5 = 1.05
   - atom B(cosine=0.7, strength=0.0, importance=0.0)→ score = 0.7 × 1.0 = 0.7
   - cosine=0 → score=0(无论 strength/importance 多高,cosine 主键保证)
   - cosine=1 → score=1.5(满分 atom 上限)
   - cosine=0.6/strength=1.0/importance=1.0(score=0.9) vs cosine=0.85/strength=0.1/importance=0.1(score=0.8925)— 后者嬴,验证 cosine 仍是主键
5. **search round-robin 顺序**:3 type × 3 cap 满员时,结果顺序为 `[rule[0], fact[0], process[0], rule[1], fact[1], process[1], rule[2], fact[2], process[2]]`(按 score DESC 排好后的 round-robin);稀疏 type 跳过对应槽位。
6. **strength feedback 循环验证**:`memory_get` atom → `access_count` +1 → 下次 `runDecay` 把 strength 微调 → 下次 search 时 atom score 上升 → 排名靠前(测试需要 mock decay 或直接对比 strength 前后的 score)。
7. **get 不 bump**:连续调 `GET /api/memory/:id` 2 次同一 atom(模拟 webui preview),该 atom `access_count` 保持不变(0 → 0)。preview-only endpoint 不向 strength 提供 feedback。
8. **get 404**:不存在的 atom id → 404,不 bump 任何东西。
9. **memory_get tool 注册**:agent 加载 personal-assistant extension 后,tool 列表中包含 `memory_get`,description 说明"输入 id,返回 full content"。
10. **memory_get tool 行为**:agent 调用 `memory_get({id: "..."})` → 返回 `{...atom, content}` 格式,且触发 `access_count + 1`。这是**唯一**会 bump 的程序入口。
11. **format 输出**:`formatMemoryBlock` 输出包含 `id: <uuid>` 行,**不**包含 `file: <path>` 行,**不**包含 `score:` 行(LLM 看不到 score)。
12. **tone scoring**:5 个测试消息样本(强语气 / 习惯语气 / 中性 / 弱语气 / 空),`scoreUserTone` 返回的 `{level, score}` 全部正确。
13. **tone 注入 extraction prompt**:`buildExtractionPrompt` 输出包含 `<user_tone level="strong" score="0.95">` 段(强语气场景),LLM 看到该段后,输出的 item.importance ≥ 0.85。
14. **runDecay 现有行为不变**:`baseDecay=0.05`、`archiveThreshold=0.1`、rule 永不 archive — 这些参数全部保留,不修改 `decay.ts`。
15. **测试**:personal-assistant 现有测试(348 单元测试)全通过;webui server 测试(216)全通过;`npm run check` 绿;新增 `scoreUserTone`、加权公式 score、和分层 search 各自的测试。
16. **CHANGELOG**:两个 CHANGELOG(extensions/personal-assistant + packages/webui)都更新到 Unreleased,Breaking Changes 段记录 search 响应删 `file_path`、新增 `score` 字段、新增 `memory_get` tool、search 排序算法改为加权公式 `cosine × (1 + 0.3×strength + 0.2×importance)`。
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
  - `memory.search` (POST /api/memory/search + `recallAtoms`) — 响应**不返 file_path**,**不 bump access_count**。改成 per-type top-3(分层 KNN,rule/fact/process 各取 cosine 最高的 3 条,共 9 条)。`RecallResult` 类型删 `file_path` 字段。
  - `memory.get` (GET /api/memory/:id) — **不 bump access_count**(preview-only,供 webui MemoryEditor 用)。bump 走 agent 端的 `memory_get` tool,见下方新增 Capability。
  - `formatMemoryContext` / `formatMemoryBlock` — 块输出从 `[type] title\nsummary\nfile: <path>\nTags: ...` 改成 `[type] title\nsummary\nid: <uuid>\nTags: ...`。LLM 看到 id 就知道调 `memory_get(id)` 拿全文。
  - `EXTRACT_PROMPT_V2` — 在 `<Importance>` 段前新增 `<User Tone>` 段,把 `scoreUserTone()` 的结果作为 hint 传给 LLM(`level=strong → importance >= 0.9`)。
- **删除 Capability**: 无

## 非目标

- **不改** `strength` / `importance` 参与 recall 排序 — recall 公式保持纯 cosine,`strength` / `importance` 不参与(用户已说"排序先放到一边",等 strength 在真实 usage 累积后再评估)。
- **不改** agent 端 `read()` 工具 — agent 用 `memory_get(id)` 替代 `read(path)`,不再需要 `read()` 拦截 hook。
- **不改** webui MemoryEditor 自动 preview — 用户在 UI 看 atom 详情**不**算"get",不 bump strength(programmatic get only)。
- **不重新实现** extraction pipeline 其他部分(dedup / supersede / write 等不动)。
- **不** 把 tone scoring 也用于 search-time rerank — 只在 extraction 写入时用,不改 recall 公式。
- **不** 给 atomic decay(`runDecay`) 引入新参数 — 现有 `last_access` 已经反映"最近被 get 过",自然进入 decay 流程,无需改动。
- **不** 让 `formatMemoryContext` 保留 round-robin 顺序 — 它会再按 distance asc 全局排序,交错顺序只在 search response 里存在。

## 验收标准

1. **search 行为变更**:`POST /api/memory/search` 响应中**不包含** `file_path` 字段,也不包含 `tier` / `formattedText` / `tokenBudgetUsed` (这些之前已删)。响应形状: `{results: [{id, type, title, summary, tags, distance, cosine}], recallTimeMs}`。
2. **search 不 bump**:`recallAtoms` 调用 1 次后,DB 中所有返回的 atom `access_count` 保持不变(0→0)。
3. **search 多样性**:6 个 atom(2 rule + 3 fact + 1 process),query "lima 拆分" 召回 → 结果必须包含 1 个 rule + 1 个 fact + 1 个 process(per-type top-3,稀疏 type 自动降到 1)。
4. **get 不 bump**:连续调 `GET /api/memory/:id` 2 次同一 atom(模拟 webui preview),该 atom `access_count` 保持不变(0 → 0)。preview-only endpoint 不向 strength 提供 feedback。
5. **get 404**:不存在的 atom id → 404,不 bump 任何东西。
6. **memory_get tool 注册**:agent 加载 personal-assistant extension 后,tool 列表中包含 `memory_get`,description 说明"输入 id,返回 full content"。
7. **memory_get tool 行为**:agent 调用 `memory_get({id: "..."})` → 返回 `{...atom, content}` 格式,且触发 `access_count + 1`。这是**唯一**会 bump 的程序入口。
8. **format 输出**:`formatMemoryBlock` 输出包含 `id: <uuid>` 行,**不**包含 `file: <path>` 行。
9. **tone scoring**:5 个测试消息样本(强语气 / 习惯语气 / 中性 / 弱语气 / 空),`scoreUserTone` 返回的 `{level, score}` 全部正确。
10. **tone 注入 extraction prompt**:`buildExtractionPrompt` 输出包含 `<user_tone level="strong" score="0.95">` 段(强语气场景),LLM 看到该段后,输出的 item.importance ≥ 0.85。
11. **测试**:personal-assistant 现有测试(348 单元测试)全通过;webui server 测试(216)全通过;`npm run check` 绿;新增 `scoreUserTone` 和分层 search 各自的测试。
12. **CHANGELOG**:两个 CHANGELOG(extensions/personal-assistant + packages/webui)都更新到 Unreleased,Breaking Changes 段记录 search 响应删 `file_path`、新增 `memory_get` tool。
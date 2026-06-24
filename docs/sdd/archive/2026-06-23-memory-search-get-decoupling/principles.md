## memory-search-get-decoupling 原则

- search 是纯向量检索,不 bump `access_count`,不返 `file_path`,只返 `{id, type, title, summary, tags, distance, cosine, score}` 让 LLM 看到 candidates
- LLM 想拿全文必须显式调 `memory_get(id)` tool,这是 strength feedback 的**唯一**程序入口
- webui 的 `GET /api/memory/:id` 仅用于内容预览,**不**触发 bump,与 agent 端的 memory_get 严格区分
- `recallAtoms` 按 type 分层 KNN:rule/fact/process 各取 top-3,稀疏 type 自动降到 1,保证类型多样性
- search 排序算法:**乘法 boost 公式** `score = cosine × (1 + 0.3 × strength + 0.2 × importance)`,组内按 score DESC 排序;**组间 round-robin 交错**(3 type × 3 cap → 最多 9 results);全局 threshold **0.65**(revised 2026-06-24 from 0.5,因 bge-m3 dense 在中文场景噪声底 ≈ 0.55,0.5 阈值会让不相关 query 误召回;0.65 是信号 vs 噪声的干净分界且留 0.1 余量给 sqlite-vec Float32 distance 计算精度),稀疏 type 跳过不凑数;`formatMemoryContext` 注入 prompt 时再做 distance asc 全局排序(只看 cosine 主键,score 仅影响 search response / debug 视图)
- 乘法结构保证 cosine 仍是主键 — cosine 趋近 0 时 score 必趋近 0,不相关 atom 不可能被 boost 反超;max boost 0.5 意味着 cosine 必须 ≥ 0.667x 才能仅靠 cosine 嬴
- pure-dense 召回有精度天花板:信号与噪声 gap 约 0.1,bi-encoder 区分"勉强相关"和"完全无关"能力有限。终极方案是 hybrid retrieval(FTS5 BM25 + dense,RRF 融合),单独 change 跟进
- strength 直接进入 feedback 循环: get → strength 高 → score 高 → 排名靠前 → 更容易被未来 recall → 更频繁被 get
- importance 反映作者/LLM 静态优先级,rule type 永远 ≥ fact/process,所以 rule 在 cosine + strength 相同时自然胜出
- `runDecay` 现有行为(baseDecay=0.05, archiveThreshold=0.1, rule 永不 archive)不变 — strength 衰减让 score 自然下降,排名下降后进一步 decay,最终触发 archive,形成完整"遗忘 → 清理"链条
- `formatMemoryBlock` 输出 `[type] title\nsummary\nid: <uuid>\nTags: ...`,LLM 通过 id 反查 `memory_get` 拿全文
- importance 由 extraction LLM 在收到 `<user_tone>` hint 后**自主**判断,词表扫描只决定 hint 强度(strong/habit/neutral/weak/rare),不直接覆写 LLM 输出;LLM 可在 ±0.15 范围内调整
- `scoreUserTone` 纯词表匹配(中英双语 ~20 词,5 档 strong/habit/neutral/weak/rare),不调 LLM,微秒级;**聚合所有 user 消息**取最强命中 tier,NEUTRAL 等级不向 prompt 注入任何 hint
- TUI footer 通过 `ctx.ui.setStatus("memory", …)` 显示召回摘要(hits: `📦 N atoms · rule=X fact=Y process=Z · top=0.XXX`;空: `🔍 no memory match`;失败: `⚠ memory recall failed`),让用户在不打开 webui 的情况下也能看到 memory pipeline 状态——LLM prompt 注入 + TUI 状态双轨

Verbatim from docs/sdd/changes/memory-search-get-decoupling/principles.md
## memory-search-get-decoupling 原则

- search 是纯向量检索,不 bump `access_count`,不返 `file_path`,只返 `{id, type, title, summary, tags, distance, cosine}` 让 LLM 看到 candidates
- LLM 想拿全文必须显式调 `memory_get(id)` tool,这是 strength feedback 的**唯一**程序入口
- webui 的 `GET /api/memory/:id` 仅用于内容预览,**不**触发 bump,与 agent 端的 memory_get 严格区分
- `recallAtoms` 按 type 分层 KNN:rule/fact/process 各取 cosine top-3,稀疏 type 自动降到 1,保证类型多样性
- search 排序算法:组内 cosine desc(每个 type 独立)+ 组间 round-robin 交错(3 type × 3 cap → 9 results),全局 threshold 0.5,稀疏 type 跳过不凑数;`formatMemoryContext` 注入 prompt 时再做 distance asc 全局排序
- `formatMemoryBlock` 输出 `[type] title\nsummary\nid: <uuid>\nTags: ...`,LLM 通过 id 反查 `memory_get` 拿全文
- importance 由 extraction LLM 在收到 `<user_tone>` hint 后**自主**判断,词表扫描只决定 hint 强度(strong/habit/neutral/weak),不直接覆写 LLM 输出
- `scoreUserTone` 纯词表匹配(中英双语 ~20 词),不调 LLM,微秒级;只看最近一条 user 消息,不聚合多轮
- search 公式保持纯 cosine,`strength` / `importance` 不参与 recall 排序;等 strength 在真实 usage 累积后再评估是否引入

Verbatim from docs/sdd/changes/memory-search-get-decoupling/principles.md
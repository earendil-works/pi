# 使用场景: memory-v2-refactor

> GIVEN-WHEN-THEN 格式,覆盖正常流程、异常流程、边界条件

## 正常流程

### Scenario: Session compaction 触发 extraction

- **GIVEN** session 累积到 25k tokens (超过 `keepRecentTokens=20000`)
- **AND** ollama 在 `localhost:11434` 运行,bge-m3 模型可用
- **AND** extraction model (MiniMax-M3) 可用
- **WHEN** `session_before_compact` hook 触发
- **THEN** `extractMemories(messagesToSummarize, index, ctx, config)` 被调用
- **AND** LLM 收到 prompt v2 (含 type standards + 2-4 段 content 指令)
- **AND** LLM 返 `{"plan": [{type, title, content, summary, tags, importance}, ...]}`
- **AND** 对每条 item:
  - `normalizeContent` + sha256 fingerprint 命中 DB → skip
  - `embedText(content)` 调 ollama → 1024-dim vector
  - `findMostSimilarEmbedding(vector, threshold=0.92)` → 若有 → supersede (BEGIN TX)
  - 若无 → create new (BEGIN TX)
- **AND** 写 `atoms/<type>/<id>.md` 文件 (tmp + rename)
- **AND** `memory_index` + `memory_vectors` 双写
- **AND** `memory_audit` 记录 action='create' 或 'supersede'

### Scenario: 主对话触发 recall (top-K retrieval)

- **GIVEN** 主对话 `before_agent_start` hook 触发,user prompt="我需要修 PDF 提取 bug"
- **AND** index 已初始化,DB 含若干 atom
- **AND** ollama 可用
- **WHEN** `recallAtoms(index, prompt, config)` 被调用
- **THEN** `embedText(prompt)` 调 ollama → 1024-dim query vector
- **AND** sqlite-vec KNN 查询 top 10 by distance
- **AND** 过滤 `archived=0 AND is_latest=1`
- **AND** Hydrate 5 个 atom
- **AND** `updateAccess(id)` for each
- **AND** Top-3 atom sync 读 .md (L1),其余用 DB 行 (L0)
- **AND** Return 5 atoms

### Scenario: Context 注入 (L0/L1 + token budget)

- **GIVEN** `recallAtoms` 返 5 atoms,top-3 已 load .md,L1;其余 L0
- **AND** `injection.tokenBudget=4000`
- **WHEN** `formatMemoryContext(results, tokenBudget)` 被调用
- **THEN** 按 distance 升序遍历 5 个 atom
- **AND** 每 atom 估算 token: title + summary + (L1: content + tags) 或 (L0: tags)
- **AND** 若加上下一个会超 4000 tokens → 停止
- **AND** 输出 `<memory-context>\n<L1>L0>...</memory-context>`
- **AND** 注入到最后一个 user message 的开头

### Scenario: Webui GET /api/memory 列表

- **GIVEN** DB 含 10 个 active atom,2 个 archived
- **WHEN** `GET /api/memory?archived=active` 被调用
- **THEN** 返 10 个 atom JSON 数组
- **AND** 按 `updated_at DESC` 排序
- **AND** 不含 `.md` body content (仅 DB 元数据)

### Scenario: Webui GET /api/memory/:id 详情

- **GIVEN** atom `X` 存在,`file_path` 指向有效 `.md` 文件
- **WHEN** `GET /api/memory/X` 被调用
- **THEN** 返 atom JSON 包含 `content` (从 .md 读)
- **AND** content_hash 验证通过

### Scenario: Webui PATCH /api/memory/:id 编辑

- **GIVEN** atom `X` 存在,tags=["foo"]
- **WHEN** `PATCH /api/memory/X` with `{tags: ["bar"]}` 被调用
- **THEN** merged atom.tags = ["foo", "bar"] (union,不覆盖)
- **AND** writeAtomToFile 写新 .md
- **AND** upsertAtom 更新 DB
- **AND** `embedText(merged.content)` async 算新 embedding
- **AND** upsertVector 更新 memory_vectors

### Scenario: Webui POST /api/memory/:id/archive 归档

- **GIVEN** atom `X` 存在,active
- **WHEN** `POST /api/memory/:id/archive` 被调用
- **AND** body 不含 `archived` 字段 (默认 toggle)
- **THEN** atom.archived = true
- **AND** upsertAtom 更新 DB
- **AND** deleteVector 从 memory_vectors 删除

### Scenario: Webui POST /api/memory/search 搜索

- **GIVEN** DB 含若干 atom,type 混合
- **WHEN** `POST /api/memory/search` with `{query: "PDF", topK: 10}` 被调用
- **THEN** recallAtoms 返 top 10 (按 cosine distance)
- **AND** 返 JSON `{results: [...], recallTimeMs: 95}`

### Scenario: Webui POST /api/memory/extract 手动触发提取

- **GIVEN** session 消息列表 ready
- **WHEN** `POST /api/memory/extract` with `{messages: [...]}` 被调用
- **THEN** `runMemoryExtraction(callLlm, messages, ...)` 跑 extraction
- **AND** 返 `{created: 3, superseded: 1, skipped: 2}` (例)

### Scenario: session_start 触发 decay

- **GIVEN** 现在距上次 decay 超过 1 小时
- **AND** 50 个 active atom
- **WHEN** session_start 触发
- **THEN** `runDecay(index, baseDecay=0.025, archiveThreshold=0.1)` 跑
- **AND** 对每 atom 计算 new_strength
- **AND** 若 new_strength < 0.1 且 type != 'rule' → markArchived
- **AND** updateStrength / markArchived / deleteVector 各自生效

## 异常流程

### Scenario: ollama 不可用,recall 失败

- **GIVEN** ollama 进程没跑
- **WHEN** recallAtoms 被调用
- **THEN** `embedText` 返回 null
- **AND** recallAtoms 立即返 `[]` (无 fallback)
- **AND** 主对话正常进行,无注入

### Scenario: ollama 不可用,extraction 写入 (无 dedup)

- **GIVEN** ollama 进程没跑
- **AND** extraction 触发
- **WHEN** executePlan 跑
- **THEN** 对每 item:
  - fingerprint 命中 → skip
  - fingerprint 不命中 → embedText 失败 → skip dedup → 直接 create new (不写 vector)
- **AND** atom 仍写入 DB,但 memory_vectors 无对应行
- **AND** 后续 recall 时,这 atom 没 vector → cosine=0 → 不会被检索到

### Scenario: .md 文件丢失,recall 降级

- **GIVEN** atom `X` 的 file_path 指向已删除的 .md
- **WHEN** recallAtoms 包含 X (top-3)
- **THEN** `readAtomFromFile` throw (file not found)
- **AND** catch → fallback to atom 行 (content="")
- **AND** L1 块无 `<content>` 标签
- **AND** 其他 atom 不受影响

### Scenario: hash mismatch,recall 降级

- **GIVEN** .md 文件被外部修改 (manual edit / sync)
- **WHEN** `readAtomFromFile(file, expected_hash)` 校验 hash 失败
- **THEN** throw "content hash mismatch"
- **AND** catch → fallback to atom 行 (content="")
- **AND** 同 Scenario .md 丢失

### Scenario: 8 秒超时,recall 静默失败

- **GIVEN** recallAtoms 慢 (例如 embedding 服务卡)
- **WHEN** `Promise.race([ps.promise, timeoutPromise(8000)])` 
- **THEN** 8 秒后 timeout reject
- **AND** `context` handler catch → silent skip
- **AND** 主对话照常 (无 memory 注入)

### Scenario: extraction 返回空 plan

- **GIVEN** LLM 返 `{"plan": []}` (没提取出任何 atom)
- **WHEN** executePlan 跑
- **THEN** 不写任何 atom
- **AND** 返 `{created: [], superseded: [], skipped: []}`

### Scenario: extraction LLM JSON parse 失败

- **GIVEN** LLM 返非 JSON 文本
- **WHEN** `parseRewriteJson(text)` 跑
- **THEN** 返回 null
- **AND** executePlan 不跑
- **AND** 不抛错,静默 skip

### Scenario: 用户输入不存在的 atom id (PATCH)

- **GIVEN** atom ID "nonexistent-uuid" 不在 DB
- **WHEN** `PATCH /api/memory/nonexistent-uuid` 被调用
- **THEN** 返 HTTP 404 `{error: "atom not found: nonexistent-uuid"}`

### Scenario: 用户 archive 已 archived 的 atom

- **GIVEN** atom `X` 已 archived
- **WHEN** `POST /api/memory/X/archive` with `{archived: false}` 被调用 (unarchive)
- **THEN** atom.archived = false (unarchive)
- **AND** upsertAtom 更新 DB
- **AND** vector 不会被自动 re-compute (需要后续 PATCH 触发)

### Scenario: token budget 完全不够 (1 个 atom 都装不下)

- **GIVEN** tokenBudget=100 (异常小)
- **AND** 5 个 atom,每个 L0 块 ~150 tokens
- **WHEN** formatMemoryContext 跑
- **THEN** 0 atom 装入
- **AND** 返 `<memory-context>\n</memory-context>` (空)
- **AND** 主对话无 memory 注入 (但照常进行)

## 边界条件

### Scenario: 完全空数据库

- **GIVEN** DB 0 atom
- **WHEN** recallAtoms 跑
- **THEN** KNN 返 []
- **AND** 返 `[]`
- **AND** 无错

### Scenario: 所有 atom archived

- **GIVEN** 所有 atom.archived=1
- **WHEN** recallAtoms 跑
- **THEN** KNN 过滤后 0 atom
- **AND** 返 `[]`

### Scenario: 所有 atom 被 supersede (无 is_latest=1)

- **GIVEN** 所有 atom.is_latest=0
- **WHEN** recallAtoms 跑
- **THEN** 0 active atom
- **AND** 返 `[]`

### Scenario: 极长 session 触发 50 个 atom 提取

- **GIVEN** session 200k tokens,messagesToSummarize 包含 ~30 条 message
- **WHEN** extraction 触发
- **THEN** LLM 接收 ~80k 字符 (full content,无截断)
- **AND** LLM 返 ~30 个 atom
- **AND** 实际写入 ≤ 30 个 (取决于 dedup)
- **AND** 单次 extraction 耗时 < 60s (含 30 次 embed 调用 ~50ms × 30 = 1.5s)

### Scenario: 中文 query,中文 atom

- **GIVEN** atom X title="PDF图片提取必须用pymupdf", content 含 "图片"
- **AND** recall config topK=5
- **WHEN** recallAtoms(index, query="图片", config)
- **THEN** query embedding ≈ atom X embedding (bge-m3 多语言)
- **AND** KNN 返 atom X 在 top 5
- **AND** 命中 (L1 / L0 取决于排名)

### Scenario: 英文 query,英文 atom

- **GIVEN** atom X title="amplicon pipeline workflow"
- **WHEN** recallAtoms(index, query="amplicon")
- **THEN** KNN 命中 atom X
- **AND** top 5 包含

### Scenario: 同 content emit 多次 (dedup by fingerprint)

- **GIVEN** LLM extraction 1: emit `{title: "A", content: "PDF图片提取必须用pymupdf"}`
- **AND** extraction 写 atom A1
- **WHEN** extraction 2 (同一 session 后段): emit 同样 content
- **THEN** normalizeContent + fingerprint 命中 A1
- **AND** skip (atom A2 不创建)
- **AND** extraction report: skipped: 1

### Scenario: 相似 content emit (dedup by cosine)

- **GIVEN** atom A 已存在,content="PDF图片提取必须用pymupdf"
- **AND** LLM 提取 emit `{title: "PDF提取方式", content: "PDF图片提取需要用pymupdf"}`
- **AND** 两 content cosine similarity > 0.92
- **WHEN** executePlan
- **THEN** fingerprint 不命中 (normalizeContent 不同)
- **AND** embedText 算新 vector
- **AND** findMostSimilarEmbedding(vector, 0.92) → atom A
- **AND** supersede: A.is_latest=0, 新 atom B.parent_id=A.id
- **AND** A.strength transfer 到 B
- **AND** A.access_count transfer 到 B
- **AND** A.created_at 保留 (B.created_at = A.created_at)

### Scenario: rule 类型永不 archive

- **GIVEN** atom type='rule',strength=0.05 (已很低)
- **WHEN** runDecay 跑
- **THEN** new_strength = 0.04 (< archiveThreshold=0.1)
- **AND** **不** 调用 markArchived (因为 type='rule')
- **AND** atom 仍 active

### Scenario: fact 类型 strength 衰减到 archive 阈值

- **GIVEN** atom type='fact', strength=0.5,last_access=30 天前
- **WHEN** runDecay 跑
- **THEN** new_strength ≈ 0.5 * exp(-0.025 * 30) ≈ 0.5 * 0.47 ≈ 0.24
- **AND** 不 archive (still > 0.1)
- **AND** 若 last_access=120 天前 → new_strength ≈ 0.05 → archive

### Scenario: 用户 PATCH 但 tags 为空数组 (清空 tags)

- **GIVEN** atom tags=["foo", "bar"]
- **WHEN** PATCH /api/memory/X with `{tags: []}` 被调用
- **THEN** merged tags = ["foo", "bar"] (因为 body.tags.length=0,代码逻辑: union tags)
  - **代码逻辑**: `tags: body.tags ? [...new Set([...existing.tags, ...body.tags])] : existing.tags`
  - `body.tags = []` 是 truthy (空数组是 truthy in JS),所以走 union
  - 结果: `[] ? union([], ["foo","bar"]) : ...` → union([], [...]) = []
  - **注意**: 这导致 tags 被清空 (行为: body.tags=[] 视为"显式清空")

### Scenario: 并发 2 个 extraction 同时跑

- **GIVEN** 两个 session 并发 compaction,都触发 extractMemories
- **WHEN** 两个 extraction 同时写 DB
- **THEN** 每个 extraction 用独立 MemoryIndex 实例 (每 instance 独立 SQLite handle)
- **AND** BEGIN IMMEDIATE 事务保证原子性
- **AND** fingerprint UNIQUE INDEX 防止同 content 重复写入
- **AND** 若两 extraction 同时 emit 同 content → 第 2 个的 INSERT 失败 → rollback

### Scenario: extractMemories 在 compact 期间超时

- **GIVEN** session_before_compact 触发 extractMemories
- **AND** LLM 调用慢 (60s+)
- **WHEN** extraction 未完成
- **THEN** try/catch 静默 catch (memory.ts:1924 `// Don't let extraction errors block compaction`)
- **AND** compaction 正常进行,无 atom 写入
- **AND** 用户无感知

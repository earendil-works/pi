# 使用场景

## 正常流程

### 场景: 列出全部活跃 atom
- **GIVEN** `~/.pi/agent/data/memory.db` 中有 12 条 `archived = 0` 的 atom（混合 7 种 type）
- **WHEN** 用户访问 `/memory`
- **THEN** `GET /api/memory?archived=false` 返回 12 条；左侧 list 渲染
  `type badge / title / strength·importance / last_access relative time`

### 场景: 打开 atom 详情
- **GIVEN** 用户点击 list 中一个 `preference` atom
- **WHEN** 详情面板装入
- **THEN** 调 `GET /api/memory/:id`，返回完整 atom（DB 元数据 + `content` 从
  `.md` 文件读出），detail 渲染：metadata form + body editor

### 场景: 编辑 metadata 字段
- **GIVEN** detail 装入完毕，user focus 在 `title` input
- **WHEN** user 把 title 改成新值并停手 3s
- **THEN** 调 `PATCH /api/memory/:id` `{title: "new"}`；header 显示 `Saving…`
  → `Saved 1s ago`；list 中对应行同步刷新

### 场景: metadata 改动不破坏 body
- **GIVEN** atom 磁盘上 body 是 5KB markdown
- **WHEN** PATCH 只传 `{title: "new title"}`，不传 `content`
- **THEN** server 读 `currentBody`（从磁盘 readAtomFromFile 拿）→ 写新
  frontmatter + 同一 body → 文件 hash 变（frontmatter `updated_at` 变了）、
  file_path 变（slug 变了）；磁盘上 .md 文件的 body 部分字节级保持，
  仅 frontmatter 行变了

### 场景: 编辑 body（content）触发 .md 重写
- **GIVEN** body textarea 当前内容 hash 为 `H1`，文件路径 `P1`
- **WHEN** user 改了 body 内容，3s 后触发保存
- **THEN** server: 重算 frontmatter + body → 算 sha256 = `H2` ≠ `H1`；写
  `P2 = atomsDir/<type>/<slug>.md`；`unlink(P1)`；`upsertAtom` 更新
  `file_path=P2`, `content_hash=H2`, `version++`, `updated_at=now`；重建
  `memory_fts` 行（title/tags 变才需要重 tokenize，否则 FTS 命中不变）；
  `DELETE FROM memory_embeddings WHERE id = ?`

### 场景: body 编辑后 hash 不变（无操作）
- **GIVEN** user 改了 body 又改回原值，hash 算出来还是 `H1`
- **WHEN** PATCH 触发
- **THEN** server: 不写新文件、不删旧文件、只更新 `updated_at` 和 `version`（`H1` 既然和
  旧一致，DB 行就刷个时间戳）

### 场景: 归档 atom
- **GIVEN** user 点 `Archive` 按钮
- **WHEN** 点击
- **THEN** 立即（不 debounce）`POST /api/memory/:id/archive {archived: true}`；
  list 中该行消失（如果当前过滤含 archived 则置灰 + 标 "Archived"）

### 场景: 召回测试（真实 pipeline）
- **GIVEN** user 展开 "Test recall" 面板，输入 "用户偏好什么字体"
- **WHEN** 点 `Search`
- **THEN** server: `rewriteQuery("用户偏好什么字体", ctx, config)` → 走
  `query_rewrite.model`（或 fallback session model）拿到 `{keywords: ["字体",
  "偏好"], target_types: ["preference"]}`；然后 `searchAtoms(index, rewritten,
  10)` → 走 FTS5 BM25 + 本地 Ollama embedding cosine（不可用降级纯 FTS）；UI
  展示 `keywords` chip + `target_types` chip + 结果列表，每条 hover 显示
  `{fts: 0.8, cos: 0.6, hybrid: 0.71, strength: 0.9, importance: 0.7}`

### 场景: 路由切换强制 flush
- **GIVEN** detail 中 user 改了 title 还没到 3s（pending timer 存在），这时点
  sidebar 切换到 `/sessions/<id>`
- **WHEN** React Router 触发 unmount
- **THEN** `useEffect` cleanup 取消 pending timer，await 当前 in-flight
  PATCH 完成（或在 await 期间 setState pending）→ 离开页面；下次回到
  `/memory` 看到的是已保存版本

## 异常流程

### 场景: DB 文件不存在
- **GIVEN** `~/.pi/agent/data/memory.db` 不存在（全新机器）
- **WHEN** user 访问 `/memory`
- **THEN** `GET /api/memory` server 端 `new MemoryIndex(path)` + `init()` 成功
  （init 会 ensureDir + CREATE TABLE IF NOT EXISTS），返回空数组；UI 显示
  "No memories yet"

### 场景: .md 文件丢失但 DB 行存在
- **GIVEN** DB 行有 `file_path=P1`、`content_hash=H1`，但 `P1` 文件被外部删除
- **WHEN** `GET /api/memory/:id`
- **THEN** server: 调 `readAtomFromFile(P1)` 返回 null；atom 行存在但
  `content: ""` + UI 标 `<memory-error>` 提示

### 场景: hash mismatch 防御
- **GIVEN** DB 行 `content_hash=H1`，外部手动编辑了 `.md` 文件导致内容
  hash 实际是 `H2`
- **WHEN** server `readAtomFromFile(P1, H1)` 用 `expectedHash` 校验
- **THEN** 抛 `Error("content hash mismatch")`；UI 标 `<memory-error>`，不展示脏内容

### 场景: PATCH 写失败
- **GIVEN** user 改了 title 触发 PATCH，但 server 此时 OOM / 磁盘满 / 进程被 kill
- **WHEN** fetch promise reject
- **THEN** client: 恢复 in-memory title 到改之前值，header 显示红色 `Save
  failed`，toast 提示 "Retry" 按钮；debounce 重新起一个 timer 3s 后重试一次
  （不无限重试，第二次失败就停）

### 场景: rewriteQuery LLM 失败
- **GIVEN** user 点 `Search` 触发 `rewriteQuery`
- **WHEN** LLM 调用 5xx / 超时
- **THEN** server: `rewriteQuery` catch → `simpleKeywordExtraction(query)` 降级；
  继续走 `searchAtoms`；UI 在 results 上方显示一条 `using keyword fallback (no
  LLM rewrite)` 提示

### 场景: 本地 embedding 不可用
- **GIVEN** `config.memory.embedding.provider === "local"` 但 Ollama 没启动
- **WHEN** `searchEmbeddings` 调 `getEmbedding`
- **THEN** 10s timeout 失败 → 返回空 Map；`searchAtoms` 检测到 `embeddingResults.size === 0`，
  走纯 FTS 分支；UI 仍展示 fts_score 单独项 + 显示 "embedding unavailable"

### 场景: 编辑期间后台抽取（concurrent write）
- **GIVEN** compaction 正在跑 `extractMemories`，写入了一条新 atom A；同时
  user 在 UI 上编辑另一条 atom B
- **WHEN** PATCH B 完成
- **THEN** DB 写入 `upsertAtom(B)` 不阻塞 A 的写；SQLite 单文件 lock，串行化；
  最终 list 刷新时同时看到 A 和 B

### 场景: FTS 重建失败
- **GIVEN** PATCH 改 title 时 `memory_fts` 重建 SQL 抛错
- **WHEN** server catch
- **THEN** atom 主行已写入，标 partial-success；下次 `searchByFts` 暂时不命中这个
  title 变了的 atom（DB 还在），user 看到 warning toast，下一次 edit 自动重试 FTS

## 边界条件

### 场景: 0 atom 空态
- **GIVEN** DB 存在但 `memory_index` 表 0 行
- **WHEN** 访问 `/memory`
- **THEN** list 显示 "No memories yet" + 一个 "Run a session to start" 占位

### 场景: 1 atom 极简态
- **GIVEN** DB 1 条 atom
- **WHEN** 访问
- **THEN** list 单卡显示，detail 直接可选中；filters / search 仍可用但只过滤这一条

### 场景: content 是空字符串
- **GIVEN** user 把 body 改成空字符串后保存
- **WHEN** PATCH 触发
- **THEN** frontmatter 仍然有所有字段，`---\n` 后是空字符串；hash 算出来
  不一样（frontmatter 的 `updated_at` 变了），文件正常重写

### 场景: tags 是空数组
- **GIVEN** atom `tags: []`
- **WHEN** 详情装入
- **THEN** chip input 显示空 placeholder "Add tag…"；保存时 `tags: []` 正常序列化

### 场景: importance 改到边界值
- **GIVEN** user 把 importance 拖到 0 或 1
- **WHEN** PATCH
- **THEN** server 接受，DB 写入；后续 `runDecay` 用 `λ = baseDecay * (1 - importance)`：
  importance=1 时 λ=0（永不衰减），importance=0 时 λ=baseDecay（最快衰减），与现有逻辑一致

### 场景: type 改成 constraint
- **GIVEN** user 把一条 `preference` 的 type 改成 `constraint`
- **WHEN** PATCH
- **THEN** server 接受，DB 更新；后续 `runDecay` 跳过 `markArchived`（`atom.type !== "constraint"` 短路），
  即便 strength 跌破 archive_threshold 也不归档——这是用户主动选择的"永不过期"

### 场景: 极长 body（50KB+）
- **GIVEN** body 是 50KB markdown
- **WHEN** 详情装入
- **THEN** body editor 渲染时 lazy mount：preview tab 渲染完整 markdown（已有
  `Markdown` 组件），edit tab 渲染 textarea 默认 60vh 高 + 内部滚动条；保存照常走

### 场景: 多个 client 同时编辑同一 atom
- **GIVEN** 两个 webui tab 同时打开同一 atom，都在改 title
- **WHEN** 两个 PATCH 几乎同时发出
- **THEN** SQLite 串行化；后写者覆盖前写者；两个 tab 都在 refetch 后看到同一
  最终值（前端 3s 轮询会拉新）。不实现 OT / CRDT。

### 场景: 路由快速切换闪入闪出
- **GIVEN** user 进 `/memory` 0.1s 后立刻点回 chat
- **WHEN** unmount
- **THEN** cleanup 检测无 pending save，无 in-flight fetch，直接放行；如果有
  pending PATCH，await 但加 200ms 兜底超时（防止后端挂死时页面卡住）

### 场景: 两个 atom 同 title 触发 slug 冲突
- **GIVEN** DB 已有 atom A 和 atom B，两者 title 都是 "用 Rust 重写"，
  `writeAtomToFile` 都写到 `atomsDir/knowledge/yong-rust-zhong-xie.md`（slug
  相同），后写者覆盖前写者
- **WHEN** user 在 UI 看到 B 的内容（最后写入的），点开 A 想编辑
- **THEN** `GET /api/memory/A` 返回的 `content` 实际是 B 的 body（hash 错位
  → `readAtomFromFile` 抛错 → server 标 `content: ""` + UI 显示
  `<memory-error>`）
- **NOTE** v1 不修这个已有 bug，记入"已知问题"，v2 加 id 兜底后缀

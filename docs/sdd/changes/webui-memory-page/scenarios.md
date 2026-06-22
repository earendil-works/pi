# 使用场景 (v2)

> v2 移除: FTS5、hybrid score、rewriteQuery、slug 路径、"embedding unavailable" badge。
> 对应 9 个 v1 场景 (`FTS 重建失败` / `rewriteQuery LLM 失败` / `本地 embedding 不可用` /
> `两个 atom 同 title 触发 slug 冲突` 等) 在 v2 不再适用,已删除。

## 正常流程

### 场景: 列出全部活跃 atom
- **GIVEN** `~/.pi/agent/memory.db` 中有 12 条 `archived = 0` 的 atom (混合 rule/fact/process)
- **WHEN** 用户访问 `/memory`
- **THEN** `GET /api/memory?archived=active` 返回 12 条;左侧 list 渲染
  `type badge / title / strength·importance / last_access relative time`

### 场景: 打开 atom 详情
- **GIVEN** 用户点击 list 中一个 `fact` atom
- **WHEN** 详情面板装入
- **THEN** 调 `GET /api/memory/:id`,返回完整 atom (DB 元数据 + `content` 从
  `.md` 文件读出),detail 渲染:metadata form + body editor

### 场景: 编辑 metadata 字段
- **GIVEN** detail 装入完毕,user focus 在 `title` input
- **WHEN** user 把 title 改成新值并停手 3s
- **THEN** 调 `PATCH /api/memory/:id` `{title: "new"}`;header 显示
  `Saving…` → `Saved 1s ago`;list 中对应行同步刷新

### 场景: metadata 改动不破坏 body
- **GIVEN** atom 磁盘上 body 是 5KB markdown,文件路径 `atoms/rule/<atom.id>.md`
- **WHEN** PATCH 只传 `{title: "new title"}`,不传 `content`
- **THEN** server: 读 `currentBody` (从磁盘 file-store 拿) → 写新
  frontmatter + 同一 body → 文件 `content_hash` 变 (frontmatter `updated_at`
  变了) ;**`file_path` 不变** (v2 用 atom.id 命名,不基于 title slug) ;
  `memory_vectors` 表该 atom 的 vector 行被 DELETE (server PATCH 已实现)
- **AND** 磁盘上 .md 文件的 body 部分字节级保持,仅 frontmatter 行变了

### 场景: 编辑 body (content) 触发 .md 重写
- **GIVEN** body textarea 当前内容 hash 为 `H1`,文件路径 `P1` (固定 atom.id)
- **WHEN** user 改了 body 内容,3s 后触发保存
- **THEN** server: 重算 frontmatter + body → 算 sha256 = `H2` ≠ `H1`;
  写 `P1` (路径不变) ;`updateAtom` 更新 `content_hash=H2`, `version++`,
  `updated_at=now`;`DELETE FROM memory_vectors WHERE id = ?`

### 场景: body 编辑后 hash 不变 (无操作)
- **GIVEN** user 改了 body 又改回原值,hash 算出来还是 `H1`
- **WHEN** PATCH 触发
- **THEN** server: 文件重写但 `content_hash` 不变;DB 行只更新 `updated_at` 和
  `version`,`content_hash` 仍是 `H1`

### 场景: 归档 atom
- **GIVEN** user 点 `Archive` 按钮
- **WHEN** 点击
- **THEN** 立即 (不 debounce) `POST /api/memory/:id/archive {archived: true}`;
  list 中该行消失 (如果当前过滤含 archived 则置灰 + 标 "Archived")

### 场景: 召回测试 (v2 真实 pipeline)
- **GIVEN** user 展开 "Test recall" 面板,输入 "用户偏好什么字体"
- **WHEN** 点 `Search`
- **THEN** server: `recallAtoms(index, query, topK)` → 走 sqlite-vec KNN +
  bge-m3 cosine;返回 `{results: [...], recallTimeMs, tokenBudgetUsed}`;
  UI 展示每条 atom 的 `distance`/`cosine_similarity`/`strength`/`importance`
- **AND** 召回不调 rewriteQuery,query 直接 embed (v2 删了 LLM query 改写)
- **AND** ollama 不可用时 `recallAtoms` 返空数组,UI 标 "No results (embedding
  service unavailable)"

### 场景: 路由切换强制 flush
- **GIVEN** detail 中 user 改了 title 还没到 3s (pending timer 存在),这时点
  sidebar 切换到 `/sessions/<id>`
- **WHEN** React Router 触发 unmount
- **THEN** `useEffect` cleanup 取消 pending timer,await 当前 in-flight
  PATCH 完成 (或 200ms 兜底超时) → 离开页面;下次回到 `/memory` 看到的
  是已保存版本

## 异常流程

### 场景: DB 文件不存在
- **GIVEN** `~/.pi/agent/memory.db` 不存在 (全新机器)
- **WHEN** user 访问 `/memory`
- **THEN** `GET /api/memory` server 端 `new MemoryIndex(dbPath)` + `init()` 成功
  (init 会 CREATE TABLE IF NOT EXISTS + vec0 init) ,返回空数组;UI 显示
  "No memories yet"

### 场景: .md 文件丢失但 DB 行存在
- **GIVEN** DB 行有 `file_path=P1`、`content_hash=H1`,但 `P1` 文件被外部删除
- **WHEN** `GET /api/memory/:id`
- **THEN** server: 调 `readAtomFromFile(P1, H1)` 返回 null;atom 行存在但
  `content: ""` + UI 标 `<memory-error>` 提示

### 场景: hash mismatch 防御
- **GIVEN** DB 行 `content_hash=H1`,外部手动编辑了 `.md` 文件导致内容
  hash 实际是 `H2`
- **WHEN** server `readAtomFromFile(P1, H1)` 用 `expectedHash` 校验
- **THEN** 抛 `Error("content hash mismatch")`;UI 标 `<memory-error>`,不展示脏内容

### 场景: PATCH 写失败
- **GIVEN** user 改了 title 触发 PATCH,但 server 此时 OOM / 磁盘满 / 进程被 kill
- **WHEN** fetch promise reject
- **THEN** client: 恢复 in-memory title 到改之前值,header 显示红色
  `Save failed`,toast 提示 "Retry" 按钮;debounce 重新起一个 timer 3s 后
  重试一次 (不无限重试,第二次失败就停)

### 场景: 编辑期间后台抽取 (concurrent write)
- **GIVEN** compaction 正在跑 `runMemoryExtraction`,写入了一条新 atom A;同时
  user 在 UI 上编辑另一条 atom B
- **WHEN** PATCH B 完成
- **THEN** DB 写入 `updateAtom(B)` 不阻塞 A 的写;SQLite 单文件 lock 串行化;
  最终 list 刷新时同时看到 A 和 B

## 边界条件

### 场景: 0 atom 空态
- **GIVEN** DB 存在但 `memory_index` 表 0 行
- **WHEN** 访问 `/memory`
- **THEN** list 显示 "No memories yet" + 一个 "Run a session to start" 占位

### 场景: 1 atom 极简态
- **GIVEN** DB 1 条 atom
- **WHEN** 访问
- **THEN** list 单卡显示,detail 直接可选中;filters / search 仍可用但只过滤这一条

### 场景: content 是空字符串
- **GIVEN** user 把 body 改成空字符串后保存
- **WHEN** PATCH 触发
- **THEN** frontmatter 仍然有所有字段,`---\n` 后是空字符串;hash 算出来
  不一样 (frontmatter `updated_at` 变了) ,文件正常重写

### 场景: tags 是空数组
- **GIVEN** atom `tags: []`
- **WHEN** 详情装入
- **THEN** chip input 显示空 placeholder "Add tag…";保存时 `tags: []` 正常序列化

### 场景: importance 改到边界值
- **GIVEN** user 把 importance 拖到 0 或 1
- **WHEN** PATCH
- **THEN** server 接受,DB 写入;后续 `runDecay` 用
  `λ = baseDecay * (1 - importance)`:importance=1 时 λ=0 (永不衰减) ,
  importance=0 时 λ=baseDecay (最快衰减) ,与现有逻辑一致

### 场景: type 改成 rule
- **GIVEN** user 把一条 `fact` 的 type 改成 `rule`
- **WHEN** PATCH
- **THEN** server 接受,DB 更新;`.md` 文件被 unlink (v1 老路径 fact/) 写到
  `atoms/rule/<id>.md`;后续 `runDecay` 跳过 `markArchived`,即便 strength
  跌破 archive_threshold 也不归档 — 这是用户主动选择的"永不过期"

### 场景: 极长 body (50KB+)
- **GIVEN** body 是 50KB markdown
- **WHEN** 详情装入
- **THEN** body editor 渲染时 lazy mount:preview tab 渲染完整 markdown (复用
  现有 `Markdown` 组件) ,edit tab 渲染 textarea 默认 60vh 高 + 内部滚动条;
  保存照常走

### 场景: 多个 client 同时编辑同一 atom
- **GIVEN** 两个 webui tab 同时打开同一 atom,都在改 title
- **WHEN** 两个 PATCH 几乎同时发出
- **THEN** SQLite 串行化;后写者覆盖前写者;两个 tab 都在 refetch 后看到同一
  最终值 (前端 3s 轮询会拉新) 。不实现 OT / CRDT。

### 场景: 路由快速切换闪入闪出
- **GIVEN** user 进 `/memory` 0.1s 后立刻点回 chat
- **WHEN** unmount
- **THEN** cleanup 检测无 pending save,无 in-flight fetch,直接放行;如果有
  pending PATCH,await 但加 200ms 兜底超时 (防止后端挂死时页面卡住)

### 场景: 召回空结果 (ollama 不可用)
- **GIVEN** ollama 进程未启动,user 在 recall tester 输入 query
- **WHEN** 点 `Search`
- **THEN** server: `recallAtoms` → `embedText(query)` 失败 → 返 `[]`;
  UI 显示 "No results (embedding service unavailable)" 而非错误

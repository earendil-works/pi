# 使用场景: atom-remigrate

## 正常流程

### 场景: 一次性 LLM 批处理 90 个老 atom
- **GIVEN** memory.db 中 90 个 active atom (90 个 .md 文件在 atoms/{type}/)
- **AND** bge-m3 service 跑在 127.0.0.1:11435
- **AND** LLM extraction 配置 (provider/model) 在 settings.json
- **WHEN** 跑 `npx tsx extensions/personal-assistant/scripts/migrate-legacy-atoms.mts`
- **THEN** 脚本按 5 个 batch (每批 18 个 atom) 喂给 LLM
- **AND** LLM 返回每个 batch 的 "merged" + "expanded" 后新 atom 文本
- **AND** 脚本对每个变化的 atom:
  - 更新 title/summary/content/tags (in-place)
  - 重算 content_fingerprint (sha256 of normalized content)
  - 调 bge-m3 `/api/atoms/{id}/reindex` 同步向量
  - 写 .md 文件
- **AND** 脚本结束输出统计: "merged N clusters · expanded M atoms · skipped K (no change) · errors 0"

### 场景: LLM 合并判定 — 同一主题多个 atom 合成一个
- **GIVEN** batch 里有 4 个 atom: "扩增子物种注释结果文件"、"扩增子物种注释结果文件路径"、"check_seq.py 脚本位置与输出格式"、"check_seq.py 后必须 update-seq 更新 state"
- **AND** LLM 看完 4 个 atom
- **WHEN** LLM 决定: 第一个和第二个合并成 1 个新 atom "扩增子物种注释结果文件路径" (内容含两个原 atom 的所有信息);第三个和第四个合并成 1 个新 atom "check_seq.py 使用与状态更新" (内容含脚本位置 + 必须 update-seq 的约束)
- **THEN** 旧 4 个 atom 都标记 is_latest=0,parent_id 指向新 atom
- **OR** 如果 LLM 决定直接 in-place 改 (用 supersede 链: 旧 atom 保留,新 atom 是新 version)

### 场景: 扩充内容长度 — 合并自然增长
- **GIVEN** 2 个旧 atom 内容分别 200 字 + 250 字,讲同一主题
- **WHEN** LLM 合并: 新 atom 保留两者的所有细节 (路径/约束/工具调用/报错),content 写到 400+ 字
- **THEN** 新 atom `embeddable text version` 不需要 bump (buildEmbeddableText 不变),但要触发 bge-m3 reindex

## 异常流程

### 场景: LLM 返回的 JSON 不合规
- **GIVEN** LLM 因 prompt 太长/网络中断/JSON 格式错
- **WHEN** 解析失败 (parseExtractionJson 返回 null)
- **THEN** 当前 batch 的所有 atom 跳过,日志 "batch 2/5 failed, retrying in 5s"
- **AND** 重试 3 次,3 次都失败则该 batch 跳过,记到 migrate-report.json
- **AND** 不影响后续 batch

### 场景: bge-m3 reindex 失败 (服务 down)
- **GIVEN** 改完一个 atom 文本,调 `/api/atoms/{id}/reindex`
- **WHEN** HTTP 5xx 或超时 (5s)
- **THEN** 该 atom 文本已更新但 bge-m3 向量是旧的 (不匹配新文本)
- **AND** 日志 warn: "atom X reindex failed, vector will be stale until next reconcile"
- **AND** 脚本不中断,继续后续 atom
- **AND** migrate-report.json 列出所有 reindex 失败的 atom id

### 场景: 备份文件创建失败 (磁盘满)
- **GIVEN** memory.db 4.4MB,目标 backup 路径磁盘已满
- **WHEN** `cp memory.db memory.db.bak.YYYYMMDD` 失败
- **THEN** 脚本 abort,日志 "backup failed, refusing to migrate"
- **AND** 0 atom 被改

### 场景: 用户在迁移期间跑 pi (读写 memory.db)
- **GIVEN** 脚本正在 batch 2 改 atom,用户开了新 pi session
- **AND** pi 启动时 session_start hook 跑 runDecay,可能改 memory_index
- **WHEN** SQLite WAL 模式下,两个 connection 都在写
- **THEN** better-sqlite3 busy_timeout=5000ms 允许短暂等待,但 lock 超时会抛 SQLITE_BUSY
- **AND** 脚本 catch 该异常,日志 "DB locked by another process, aborting"
- **AND** 部分 atom 已迁移,部分未迁移 (idempotent 重跑可补)

## 边界条件

### 场景: 已迁移过 (二次执行)
- **GIVEN** 第一轮迁移已完成,所有 atom 标题带 "v2" 后缀 (LLM 加的迁移标记)
- **WHEN** 用户再次跑脚本
- **THEN** 脚本检测到所有 atom 标题都已带 "v2" 后缀,直接退出 "no migration needed"
- **OR** 脚本根据 settings.json flag `migration.atomV2Done = true` 跳过 (持久化标记)

### 场景: 90 个 atom 中部分已被用户手动删过 (DB 实际 70 个)
- **GIVEN** 用户在迁移前手动 archive 了 20 个 atom
- **WHEN** 脚本扫 active atom,只看到 70 个
- **THEN** 只处理这 70 个,backup 文件大小对应全 DB (90 行的)
- **AND** 日志 "found 70 active atoms (db has N total, N-70 are archived/superseded)"

### 场景: 用户对 LLM 合并结果不满意,想回滚
- **GIVEN** 迁移完成,用户跑了一次召回发现"扩增子" 召回 1 个但需要 2 个
- **WHEN** 用户 `cp memory.db.bak.YYYYMMDD memory.db`
- **AND** 调 bge-m3 `/api/atoms/reindex` 全量 reconcile
- **THEN** 召回回到迁移前状态 (id 全在,文本是迁移前的)

### 场景: 迁移后某 atom 的 bge-m3 向量没及时更新,导致召回精度倒退
- **GIVEN** 文本改完了,但 reindex 因网络问题失败,该 atom 向量是旧的
- **WHEN** LLM 召回,可能召回到这个 atom 但 cosine 跟新文本不匹配
- **THEN** 召回质量局部下降,但不致命 (90 个里 1-2 个 stale)
- **AND** 用户跑 `npx tsx extensions/personal-assistant/scripts/reconcile-vectors.mts` 全量对齐 (或等下次 service 重启)

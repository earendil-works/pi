# 使用场景: atom-remigrate

## 正常流程

### 场景: 一次性程序驱动 0.65 dedup 迁移
- **GIVEN** memory.db 中 90 个 active atom (90 个 .md 文件在 atoms/{type}/)
- **AND** bge-m3 service 跑在 127.0.0.1:11435 (此场景**不**调 bge-m3,因为 content 不变,vector 仍正确)
- **WHEN** 跑 `npx tsx extensions/personal-assistant/scripts/migrate-legacy-atoms.mts`
- **THEN** 脚本:
  - 备份 memory.db → memory.db.bak.YYYYMMDD
  - 读 90 atom,按 (access_count DESC, last_access DESC NULLS LAST, created_at DESC) 排序
  - 对每个 atom,从 memory_vectors 表读 embedding,调 `findMostSimilarEmbedding(embedding, 0.65)`
  - 若是 hit (不是自己),调 `markSupersededNoInsert(hit.id, atom.id, now)` 把 hit 标 archived
- **AND** 脚本结束输出: "migration done: 90 → 75 active (archived 15). Re-run idempotent."

### 场景: 同 cluster 0.65+ cosine 自动 merge
- **GIVEN** corpus 有 2 个 atom: "扩增子物种注释结果文件" (embedding A) 和 "扩增子物种注释结果文件路径" (embedding B),A 与 B 的 dense cosine 0.756 (实测)
- **AND** 排序后 A 在前 (access_count 或 last_access 更高)
- **WHEN** 脚本遍历到 A
- **THEN** `findMostSimilarEmbedding(A, 0.65)` 返回 B (cosine 0.756 ≥ 0.65)
- **AND** 调 `markSupersededNoInsert(B.id, A.id, now)`: B 标 is_latest=0,parent_id=A,superseded_at=now
- **AND** A 不变 (id 保留,active,作为"赢")
- **WHEN** 脚本遍历到 B (后续)
- **THEN** B 已是 is_latest=0,`getActiveAtoms()` 已经过滤掉,脚本 skip
- **AND** 召回时只看到 A (B 不参与),precision 提升

### 场景: 不扩张 atom 长度 (用户明确)
- **GIVEN** 2 个 atom 都有 cluster 关系,但其中一个内容 200 字,另一个 300 字
- **WHEN** 0.65 dedup merge (热 atom 赢)
- **THEN** 赢的 atom 保持原内容 (200 字或 300 字),不拉长
- **AND** bge-m3 vector 仍匹配 (content 没变)
- **AND** 召回时用户只看到赢的 atom,LLM 看到 200 或 300 字而非 500 字 (节省 token)

### 场景: Idempotent — 第二次跑 0 改动
- **GIVEN** 第一次 migration 跑完,corpus 已经没有 cosine ≥ 0.65 的 pair (dedup 终态)
- **WHEN** 用户再跑 `npx tsx extensions/personal-assistant/scripts/migrate-legacy-atoms.mts`
- **THEN** 第二次跑:对每个 atom,`findMostSimilarEmbedding(embedding, 0.65)` 返回自己 (cosine 1.0)
- **AND** self-match guard 路径,no-op
- **AND** 0 个 markSupersededNoInsert 调用,0 个 reindex
- **AND** 报告 "0 changes (idempotent)"

### 场景: 目标 2 — Extract prompt 注入现有 tag 字典
- **GIVEN** 启动时 scan corpus,统计 top 50 高频 tag
- **AND** 启动时维护 in-memory `Set<string> tagVocabulary` (来自高频 tag)
- **WHEN** 用户新会话触发 `session_before_compact` 走 extract
- **THEN** LLM prompt 包含一段:
  ```
  ## 现有 tag 字典 (优先复用,不要发明新近义 tag)
  amplicon, 16S, MTB, R, 扩增子, 修复, bug, fix, position, location,
  flow, process, rule, prefer, prefer-not, prefer-must, ...
  
  ## Tag 规范
  - 大小写归一: 全部 lowercase (中文不变)
  - 同义合并: 写 "Amplicon" 视作 "amplicon"; 写 "Bug 修复" 视作 "bug fix"
  - 概念性 tag 至少 1 个 (动作/类别)
  - 总数 3-6 个
  ```

### 场景: 目标 2 — LLM 看到可合并的新信息,更新而非新建
- **GIVEN** 用户会话中提到"check_seq.py 又改了输出格式,现在支持 JSON"
- **AND** corpus 已有 atom "check_seq.py 脚本位置与输出格式" (tsv 格式)
- **WHEN** extract LLM 分析这条新信息
- **THEN** LLM 看到 prompt 中"## 主动更新,非扩张"规则
- **AND** LLM 决定: 现有 atom "check_seq.py 脚本位置与输出格式" 字段 `content` 追加 "2026-07 新增 JSON 格式支持",**不创建新 atom**
- **THEN** `executeItem` 走 supersede 路径 (**cosine ≥ 0.65** 命中旧 atom,Decision 10),新 version 替代旧 version

### 场景: 目标 2 — LLM 误判新建,程序 dedup 兜底
- **GIVEN** LLM 看到"check_seq.py 新增 JSON 格式支持"但没识别到可合并,emit 一个新 atom
- **WHEN** `executeItem` 跑 fingerprint dedup + **0.65** cosine dedup
- **AND** 新 atom content_fingerprint 跟旧 atom 重复 → skip
- **OR** 新 atom 跟旧 atom cosine ≥ 0.65 → supersede
- **THEN** 旧 atom 内容被更新 (新 atom 字段覆盖 + 历史保留),新 atom 不独立存在

### 场景: 目标 2 — 启动时 tag 字典加载
- **GIVEN** corpus 90 atom 加载完成
- **WHEN** `extractMemoriesWithCallLlm` 第一次被调用
- **THEN** 构造 prompt 时先调 `loadTagVocabulary(index)` (新函数),扫 `memory_index.tags` 列 (JSON 解析),统计频次,取 top 50
- **AND** 注入到 prompt 顶部 "## 现有 tag 字典" 段
- **AND** tagVocabulary 缓存 in-memory 直到 session 结束 (不每次都重算)

## 异常流程

### 场景: 备份文件创建失败 (磁盘满)
- **GIVEN** memory.db 4.4MB,目标 backup 路径磁盘已满
- **WHEN** `cp memory.db memory.db.bak.YYYYMMDD` 失败
- **THEN** 脚本 abort,日志 "backup failed, refusing to migrate"
- **AND** 0 atom 被改

### 场景: 用户在迁移期间跑 pi (读写 memory.db)
- **GIVEN** 脚本正在遍历 atom 标 archived,用户开了新 pi session
- **AND** pi 启动时 session_start hook 跑 runDecay,可能改 memory_index
- **WHEN** SQLite WAL 模式下,两个 connection 都在写
- **THEN** better-sqlite3 busy_timeout=5000ms 允许短暂等待,但 lock 超时会抛 SQLITE_BUSY
- **AND** 脚本 catch 该异常,日志 "DB locked by another process, aborting"
- **AND** 部分 atom 已迁移,部分未迁移 (idempotent 重跑可补)
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

### 场景: 用户对合并结果不满意,想回滚
- **GIVEN** 迁移完成,用户跑了一次召回发现"扩增子" 召回 1 个但需要 2 个 (某 cluster 错误合并)
- **WHEN** 用户 `cp memory.db.bak.YYYYMMDD memory.db`
- **AND** 重启 bge-m3 service (它启动时自动从 db 重建内存索引)
- **THEN** 召回回到迁移前状态 (id 全在,is_latest 全 1,文本是迁移前的)

### 场景: 30 天后用户想再合一次,降到 0.60 阈值
- **GIVEN** 第一次 0.65 dedup 跑完,corpus 75 atom,精度改善但还有 0.55-0.65 范围 cluster 残留
- **WHEN** 用户跑 `npx tsx migrate-legacy-atoms.mts --threshold=0.60` (脚本支持 CLI 阈值)
- **THEN** 第二次跑 0.60 dedup,捕获 36 个新 pair (90 → 65)
- **AND** 0 误合并 (实测样本都是真 cluster)
- **AND** idempotent: 0.65 跑过的 cluster 不会再被 0.60 重复 supersede (已经是 archived)

### 场景: 目标 2 — 边界: corpus 完全空,tag 字典为空
- **GIVEN** 用户首次启动,corpus 0 atom
- **WHEN** 第一次 extract 触发
- **THEN** `loadTagVocabulary` 返回空集,prompt 中 "## 现有 tag 字典" 段为 "(空,自由 emit)"
- **AND** 不报错,正常走 extract

### 场景: 目标 2 — 边界: corpus 满 1000 atom,tag 字典扫描慢
- **GIVEN** corpus 1000 atom
- **WHEN** `loadTagVocabulary` 扫所有 active atom 的 tags 列
- **THEN** 单次扫约 50ms,缓存 in-memory 整 session
- **AND** 用户感知不到延迟 (session_before_compact 已有 1-2s LLM call)

### 场景: 目标 2 — 边界: LLM 不遵守 tag 规范
- **GIVEN** 提示词要求"tag 全 lowercase" + "至少 1 个概念性 tag"
- **WHEN** LLM 仍 emit `["Amplicon", "X101SC", "16S"]` (全专名,大写)
- **THEN** 程序端做归一化: `["amplicon", "x101sc", "16s"]`
- **AND** 检测概念性 tag 缺失: 若 0 个概念性 tag,reject 整个 item,日志 "tag lacks concept marker, skipped"
- **OR** 仅 warn 写入,不强 reject (用户后续可手动改)

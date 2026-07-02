# 变更提案: atom-remigrate

## 动机

当前 personal-assistant 记忆系统有严重的"原子过碎 + 短内容 + 高假阳性召回"问题,根本原因在**历史 atom 的写法不规整**,而非召回算法。

实测证据 (本会话, 2026-07-02):
- 90 个 active atom,平均 content 长度仅 199 字 (fact) / 244 字 (process) / 134 字 (rule)
- LLM 召回时一次只看到 1-2 句 summary,大量上下文被丢失,需要再 read 全文才能用
- 召回假阳性高: query "修复的脚本和修复逻辑给我" → 8 个 hit,2 真 6 假 (precision 25%)
- 重复 cluster 至少 9 个 (扩增子物种注释/iCAMP 分组/check_seq/RNAVIRUS-DELIVERY-CHECK/smart-sample-find/workMonitor/X101SC26052587/README) — 多个 atom 讲同一主题的不同侧面

根因: 当前 `executeItem` 的写入路径只做 fingerprint 精确去重 + cosine ≥ 0.92 单一阈值去重,**不解决"同一主题多个 atom"的语义级冗余**。LLM 每次 extract 各自独立的 atom,从不合并。

本次变更目标: **一次性 LLM 批处理 90 个老 atom**,合并语义级重复、扩充每个剩余 atom 的 content 长度 (因为合并后自然变长)。不动召回策略、不动 bge-m3 service,只动 atom 文本 + 触发 reindex。

## 影响范围

- **新增 Capability**: `migration/atom-remigrate` (一次性脚本,不可重复执行)
- **修改 Capability**: `personal-assistant.memory` (atom 文本字段 in-place 更新)
- **删除 Capability**: 无

## 非目标

- 不改召回策略 (search.ts / format.ts / hybrid-search.ts / server.py 全部零改动)
- 不改 extract prompt (`EXTRACT_PROMPT_V2` 保持现状,后续可单独 change 优化)
- 不改 decay / strength / access_count 字段 (只改 title/summary/content/tags 4 个文本字段 + content_fingerprint 重算)
- 不删 atom (即使新版本更短,只要 LLM 决定保留就保留)
- 不改 schema (`memory_index` 表 0 列变化,`content_fingerprint` 是已存在列)
- 不动 webui (UI 自然显示新文本,无前端代码变化)
- 不重建 bge-m3 全量索引 (只对改动的 atom 调 `reindex_one`)

## 验收标准

1. **合并后 atom 数量减少 ≥ 20%** (90 → ≤ 72),由 LLM 判定,只要合并 cluster 至少 6 个即达标
2. **剩余 atom 平均 content 长度 ≥ 350 字** (从 199/244/134 提升 ~75%)
3. **任何被改的 atom**: 同一 id 保留,`updated_at` 更新,`version` +1,`access_count` 不变,`is_latest=1`,`archived=0`
4. **每个被改的 atom**: bge-m3 向量通过 `/api/atoms/{id}/reindex` 重算,新 cosine/sparse 跟新文本一致
5. **召回真阳性率 (precision@5) 在迁移后 ≥ 40%** (用户原 case "修复的脚本和修复逻辑给我",top-5 内至少 2 个真相关) — 通过 `recall-quality.test.ts` 验证
6. **数据完整性**: 迁移前后 `atom.id` 集合相同 (只是文本变化,无增删)
7. **可重入**: 脚本运行 2 次,第二次为 no-op (检测到 title 已是新格式就跳过)
8. **可回滚**: 迁移前自动备份 memory.db → memory.db.bak.YYYYMMDD,出错可手动 cp 回滚

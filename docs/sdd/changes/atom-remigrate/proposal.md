# 变更提案: atom-remigrate

## 动机

当前 personal-assistant 记忆系统有严重的"原子过碎 + 标签冗余 + 高假阳性召回"问题,根因在**两个层面**:

**1. 历史 atom 已经冗余** (本次目标 1: 一次性治理)
- 90 个 active atom 中至少 9 个 cluster 重复 (扩增子物种注释/iCAMP 分组/check_seq/RNAVIRUS-DELIVERY-CHECK/smart-sample-find/workMonitor/X101SC26052587/README 各 2-3 个)
- 召回假阳性高: query "修复的脚本和修复逻辑给我" → 8 个 hit,2 真 6 假 (precision 25%)
- 召回端看到的是"扩增子物种注释结果文件" + "扩增子物种注释结果文件路径" 两个几乎相同的 atom,无法判断哪个是 LLM 真正想要的

**2. 现有 extract pipeline 还会持续产生冗余** (本次目标 2: 防止未来再出现)
- `EXTRACT_PROMPT_V2` 对 tags 只说 "3-8 个,短小 (1-3 词),含中英文",**没要求** 概念性 vs 专名比例、tag 一致性、是否更新已有 atom
- 84 个老 atom 产生 350 个 unique tag,平均每 tag 出现 1.1 次。**tag 体系本身已无序**
- `executeItem` 写入路径只做 fingerprint 精确去重 + cosine ≥ 0.92 单一阈值去重。LLM 提取时没有"现有 atom 上下文",不会主动合并语义相关的新信息

**目标 1**: 一次性 LLM 批处理 90 个老 atom,**只合并不扩张** (不刻意加长 content),in-place 改 + supersede 链,id 保留,bge-m3 reindex。
**目标 2**: 改 `EXTRACT_PROMPT_V2`,强制 LLM (a) 看现有 tag 字典后再 emit tags, (b) "新信息可归入已有 atom 就更新而非新建"。从源头防止未来再产生冗余。

## 影响范围

- **新增 Capability**: `migration/atom-remigrate` (一次性脚本,不可重复执行)
- **修改 Capability**: 
  - `personal-assistant.memory` (atom 文本字段 in-place 更新 — 目标 1)
  - `personal-assistant.extraction` (`EXTRACT_PROMPT_V2` 加现有 tag 字典注入 + 主动更新规则 — 目标 2)
- **删除 Capability**: 无

## 非目标

- 不改召回策略 (search.ts / format.ts / hybrid-search.ts / server.py 全部零改动)
- 不扩张 atom content 长度 (用户明确: 无须扩张新 atom)
- 不改 decay / strength / access_count 字段 (只改 title/summary/content/tags 4 个文本字段 + content_fingerprint 重算)
- 不删 atom (即使新版本更短,只要 LLM 决定保留就保留)
- 不改 schema (`memory_index` 表 0 列变化,`content_fingerprint` 是已存在列)
- 不动 webui (UI 自然显示新文本,无前端代码变化)
- 不重建 bge-m3 全量索引 (只对改动的 atom 调 `reindex_one`)
- 不引入 tag 同义词表 LLM 自动聚类 (那是另一个独立 change)
- 不回填 source_session (那是另一个 change)

## 验收标准

### 目标 1: 合并迁移 (程序驱动 0.65 dedup)
1. **合并后 atom 数量减少 ≥ 17%** (90 → ≤ 75),由 0.65 cosine dedup 自动触发 35 pair merge
2. **不扩张**: 合并是 markSupersededNoInsert 标 archived,不修改 content,长度自然不变
3. **任何被改的 atom**: 同一 id 保留,被 supersede 的 atom 仅 `is_latest=0` + `parent_id` + `superseded_at` 三个字段变化;`version` / `access_count` / `last_access` 不动
4. **不需要 bge-m3 reindex**: content 没变,vector 跟文本仍一致 (这是目标 1 比 LLM batch 简单的关键)
5. **召回真阳性率 (precision@5) ≥ 40%** (用户原 case "修复的脚本和修复逻辑给我",top-5 内至少 2 个真相关) — 通过 `recall-quality.test.ts` 验证
6. **数据完整性**: 迁移前后 `atom.id` 集合相同,只 is_latest 状态变化
7. **天然 idempotent**: 第二次跑 0 个改动 (0.65 dedup 终态不变,所有 self-match 走 guard path)
8. **可回滚**: 迁移前自动备份 memory.db → memory.db.bak.YYYYMMDD,出错可手动 cp 回滚
8a. **dedup 阈值 0.65 (跨目标 1+2)**: 现有 0.92 跟 recall floor 0.55 严重脱节,改为 0.65。90 atom 实测触发 35 个真实 cluster merge,0 误伤

### 目标 2: 防止未来冗余
9. **`EXTRACT_PROMPT_V2` 包含现有 tag 字典 (top 50 高频 tag)**: LLM extract 时能看到现有 tags,优先复用
10. **`EXTRACT_PROMPT_V2` 包含"主动更新,非扩张"规则**: 明确告诉 LLM,新信息可归入已有 atom 时更新而非新建
11. **强制 tag 大小写归一**: LLM 输出后程序 lowercase (中文不变),避免 "Amplicon" / "amplicon" 这种
12. **强制至少 1 个概念性 tag**: 每 atom 至少 1 个"动作/类别" tag (e.g. "修复"/"位置"/"流程"),不允许全是专名
13. **新增 extraction 单元测试**: 验证 LLM 输出 tags 全 lowercase,至少 1 个概念性 tag
14. **新会话 30 天后**: corpus atom 平均 tag 重复率 ≥ 2.0 (即每个 tag 平均被 ≥ 2 个 atom 使用) — 通过 `tag-quality.test.ts` 验证

# 实施计划: Pi 个人助手定制

## 架构

```
pi/                                          # fork 仓库
├── extensions/
│   └── personal-assistant/
│       ├── index.ts                         # 导出 [memory, tools, cron]
│       ├── memory.ts                        # 全自动: 注入 + 提取 + 衰减
│       ├── tools.ts                         # todo_write + web_search + web_fetch
│       └── cron.ts                          # cron_write
├── SOUL.md
├── USER.md
├── skills/                                  # 可选 (Phase 3)
├── prompts/                                 # 可选 (Phase 3)
├── packages/
│   └── coding-agent/src/core/
│       ├── settings-manager.ts              # 改: +PersonalAssistantConfig
│       └── extensions/loader.ts             # 改: +1 discovery 源
└── .pi/                                     # 不动

~/.pi/agent/
├── settings.json                            # + personalAssistant 段
├── data/
│   ├── memory.db                            # SQLite: memory_index + memory_fts
│   ├── memory/
│   │   ├── atoms/{type}/{slug}.md           # 记忆原子 (YAML frontmatter + MD)
│   │   ├── reports/extract-{ts}.md          # 提取报告
│   │   ├── reports/decay-{ts}.md            # 衰减报告
│   │   └── archive/{type}/{slug}.md         # 归档记忆
│   ├── todo.json
│   └── cron.json
└── sessions/
```

---

## 任务

### T0: 配置类型定义
**文件**: `packages/coding-agent/src/core/settings-manager.ts`
**改动**: 新增 `PersonalAssistantConfig` 接口族 + `Settings` 加 `personalAssistant?` 字段
**验证**: TypeScript 编译通过

### T1: 扩展发现路径
**文件**: `packages/coding-agent/src/core/extensions/loader.ts`
**改动**: `discoverAndLoadExtensions()` 新增扫描 `<repo-root>/extensions/`
**方法**: 从 loader.ts `__dirname` 向上推算 repo root, 若 `extensions/` 存在则加入 discovery
**验证**: 编译通过, 从任意目录启动 pi 日志显示 personal-assistant 已加载

### T2: SOUL.md + USER.md
**文件**: `<fork>/SOUL.md`, `<fork>/USER.md`
**来源**: `nanobot/templates/SOUL.md` + `nanobot/templates/USER.md`
**Extension**: `extensions/personal-assistant/memory.ts`, `before_agent_start` 读取注入
**config 路径**: `personalAssistant.persona.soul_path/user_path`, 空=默认 fork 根
**验证**: 启动 pi -> system prompt 含人格内容

### T3: 记忆存储层
**文件**: `extensions/personal-assistant/memory.ts` (部分)
**来源**: `nanobot/memory/atom.py` + `nanobot/memory/memory_index.py`
**实现**:
- MemoryAtom interface (7 种类型)
- SQLite schema: `memory_index` (metadata) + `memory_fts` (FTS5 unicode61)
- `write_atom()` -> `<data>/memory/atoms/{type}/{slug}.md` (YAML frontmatter)
- `read_atom()` -> parse YAML + MD body
- `MemoryIndex.upsert()` -> INSERT OR REPLACE + FTS5 insert (jieba 分词)
- `MemoryIndex.rebuild()` -> 从文件重建索引
- `MemoryIndex.search()` -> FTS5 BM25 + 可选 embedding 混合排序
- `_prep_fts_text()` -> jieba 中文分词 (Node.js 版)
**验证**: session_start -> SQLite 初始化日志

### T4: 记忆注入
**来源**: `nanobot/memory/inject.py` + `nanobot/memory/query.py`
**事件**: `before_agent_start`
**实现**:
1. QueryRewriter.rewrite(raw_query) -> LLM (config query_rewrite provider/model) -> `{keywords, target_types}`
   fallback: jieba 提取关键词 + 所有 7 种类型
2. MemoryIndex.search(typedQuery, top_k=config.max_inject_count):
   - FTS5: `memory_fts MATCH "kw1" "kw2"`
   - Embedding: 调 Ollama API (`POST /api/embeddings`) 算 cosine similarity (try-catch, 不可用跳过)
   - Hybrid = (0.5 x FTS5_norm + 0.5 x cosine_norm) x (0.5 + 0.3 x strength + 0.2 x importance)
3. `_format_memory_context(atoms)` -> `<memory-context>` XML 块
4. 拼在 user message 前: `"{memory_context}\n\n{user_content}"`
5. `_update_access()` 更新被检索记忆
**验证**: 提问相关话题 -> agent 回复引用记忆

### T5: 记忆提取
**来源**: `nanobot/memory/memory_extractor.py` + `nanobot/templates/memory/extract.md`
**事件**: `session_before_compact`
**实现**:
1. `_format_messages(messages)` -> "[role] content"
2. `_extract_keywords(messages)` -> jieba 提取关键词
3. `MemoryIndex.search(keywords, top_k=5)` -> 已有相关记忆
4. `render_template("extract.md", messages=..., existing_atoms=...)` -> LLM
5. 调 LLM (config extraction provider/model, 空=主 agent)
6. 解析 JSON plan: `{plan: [{action:"create"|"update"|"skip", ...}]}`
7. 写报告 `<data>/memory/reports/extract-{ts}.md`
8. 执行 plan:
   - create: new MemoryAtom -> write_atom() -> index.upsert()
   - update: find atom file -> read_atom() -> modify -> write_atom() -> index.upsert()
   - skip: 仅记录
**验证**: 长对话触发压缩 -> reports 生成 + atoms 有新文件

### T6: 记忆衰减
**来源**: `nanobot/memory/decay_task.py`
**事件**: `session_start` (距上次 > 6h 时执行一次)
**实现**:
1. 获取 `memory_index WHERE archived=0`
2. 对每个 atom 计算:
   - `lambda = base_decay x (1 - importance)`  // constraint: 0
   - `denominator = 1 + 0.3 x ln(1 + access_count + 2)`
   - `new_strength = strength x exp(-lambda x delta_days / denominator)`
3. UPDATE DB
4. 若 type != "constraint" AND new_strength < archive_threshold: archive
5. 生成衰减报告
**验证**: 启动 pi -> 衰减检查日志

### T7: todo_write 工具
**文件**: `extensions/personal-assistant/tools.ts`
**来源**: `nanobot/agent/todo.py`
**注册**: `todo_write({todos: [{action: "add"|"done"|"update", content?, id?, priority?, category?}], merge: bool})`
**存储**: `<data>/todo.json`
**验证**: 批量增删改查

### T8: cron_write 工具
**文件**: `extensions/personal-assistant/cron.ts`
**来源**: `nanobot/cron/service.py + types.py`
**注册**: `cron_write({operations: [{action: "add"|"list"|"remove"|"toggle", name?, schedule?, prompt?, id?, enabled?}], merge: bool})`
**存储**: `<data>/cron.json`
**schedule**: `{kind:"at", time:"09:00"}` | `{kind:"every", interval:3600}` | `{kind:"cron", expr:"0 9 * * 1-5", tz:"Asia/Shanghai"}`
**执行**: `session_start` 检查 overdue -> agent 自动执行
**验证**: 添加 1 分钟后任务 -> 等 1 分钟 -> 重启 pi -> 触发

### T9: web_search 工具
**文件**: `extensions/personal-assistant/tools.ts`
**来源**: `nanobot/agent/tools/search.py`
**注册**: `web_search({query, max_results?})`
**验证**: 搜索 -> 返回链接

### T10: web_fetch 工具
**文件**: `extensions/personal-assistant/tools.ts`
**来源**: `nanobot/agent/tools/web.py`
**注册**: `web_fetch({url, max_length?})`
**实现**: HTTP GET -> readability 提取文本 -> SSRF 检查
**验证**: 抓取 URL -> 返回纯文本

### T11: Skill 迁移 (可选)
**来源**: `nanobot/skills/weather/ + frontend-slides/ + frontend-design/ + skill-creator/`
**位置**: `<fork>/skills/`

### T12: Prompt 模板 (可选)
**位置**: `<fork>/prompts/`
**内容**: remember.md, todo.md, weekly.md, summary.md

---

## 依赖图

```
T0 ----+
       |
T1 ----+---- T2 ---- T3 ---- T4 ---- T5 ---- T6
                                          |
                                          +---- T7 ---- T8 ---- T9 ---- T10

T6 ---- T11 ---- T12
```

## 验证清单

| # | 验证 |
|---|------|
| 1 | `pi` 从任意目录启动, extension 自动加载, 无报错 |
| 2 | SOUL.md + USER.md 在 system prompt 中可见 |
| 3 | 长对话 -> 压缩 -> atoms 生成 |
| 4 | 新会话提问相关 -> agent 引用记忆 |
| 5 | constraint 记忆永不归档 |
| 6 | todo_write 批量操作 |
| 7 | cron_write 添加 + 逾期执行 |
| 8 | web_search/web_fetch 返回结果 |

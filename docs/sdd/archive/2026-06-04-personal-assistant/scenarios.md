# 场景

## 1. SOUL/USER 注入
`来源: nanobot/memory/persona_manager.py _load_persona() -> ContextBuilder.build_system_prompt()`
`模板: nanobot/templates/SOUL.md + USER.md`

GIVEN 用户启动 pi, 构建 system prompt
WHEN `before_agent_start` 触发
THEN 读取 `settings.json personalAssistant.persona.soul_path` (默认 `<fork>/SOUL.md`)
AND 读取 `settings.json personalAssistant.persona.user_path` (默认 `<fork>/USER.md`)
AND 内容注入 system prompt 的人格段

## 2. 扩展自动加载
`来源: 方案A架构决策`

GIVEN pi 从任意路径启动
WHEN `discoverAndLoadExtensions()` 执行
THEN 扫描 `<repo-root>/extensions/` (从 loader.ts `__dirname` 向上推算)
AND `extensions/personal-assistant/index.ts` 被加载
AND 注册的事件钩子对所有会话生效

## 3. 记忆注入
`来源: nanobot/memory/inject.py MemoryInjector.inject()`
`调用链: before_agent_start -> inject(msg) -> QueryRewriter.rewrite() -> MemoryIndex.search() -> _format_memory_context()`

GIVEN 用户发消息 "上次那个 redis 超时后来怎么解决的"
WHEN `before_agent_start` 处理该消息
THEN:
  a. QueryRewriter.rewrite(raw_query) -> **LLM 改写** -> `{keywords: ["redis","超时","解决"], target_types: ["solution","knowledge"]}`
     失败 fallback: jieba 提取关键词 + 所有 7 种类型
  b. MemoryIndex.search(typedQuery, top_k=config.max_inject_count):
     - FTS5 BM25: `memory_fts MATCH "redis" "超时" "解决"` + type filter -> BM25 score
     - Embedding (若 raw_query 存在且 Ollama 可用):
       对每个 FTS5 candidate 调 Ollama API 算 cosine similarity
     - 混合排序:
       `hybrid = (0.5 x FTS5_norm + 0.5 x cosine_norm) x (0.5 + 0.3 x strength + 0.2 x importance)`
  c. `_format_memory_context(atoms)` -> `<memory-context>` XML 块
  d. 拼在 user message 前: `"{memory_context}\n\n{user_content}"`
  e. `_update_access()` 更新被检索记忆的 access_count + last_access

## 4. 记忆提取
`来源: nanobot/memory/memory_extractor.py`
`触发点: session_before_compact`
`prompt 模板: nanobot/templates/memory/extract.md`

GIVEN 对话触发压缩 (token 达 80% 窗口 / 手动 /compact / idle)
WHEN `session_before_compact` 触发
THEN:
  a. `_format_messages(messages)` -> "[role] content" 每行
  b. `_extract_keywords(messages)` -> jieba 从消息提取关键词
  c. `index.search(keywords, top_k=5)` -> 已有的相关记忆
  d. `render_template("extract.md", messages=..., existing_atoms=...)` -> LLM prompt
  e. 调 LLM (config `memory.extraction.provider/model`, 空=主 agent)
  f. 解析 JSON plan: `{plan: [{action: "create"|"update"|"skip", ...}]}`
  g. 写报告 `<data>/memory/reports/extract-{timestamp}.md`
  h. 执行 plan:
     - create: new MemoryAtom -> `write_atom()` -> `index.upsert()`
     - update: find atom file -> `read_atom()` -> modify fields -> `write_atom()` -> `index.upsert()`
     - skip: 仅记录报告

## 5. 记忆衰减
`来源: nanobot/memory/decay_task.py`

GIVEN `session_start` 且距上次衰减检查 > 6h
WHEN 衰减执行
THEN:
  a. 获取 `memory_index WHERE archived=0`
  b. 对每个 atom:
     - `lambda = base_decay x (1 - importance)`  // constraint: importance=1, lambda=0
     - `delta_days = (now - last_access) / 86400`
     - `denominator = 1 + 0.3 x ln(1 + access_count + 2)`
     - `new_strength = strength x exp(-lambda x delta_days / denominator)`
  c. `UPDATE memory_index SET strength = new_str`
  d. 若 type != "constraint" AND new_strength < archive_threshold:
     - atom 文件名不变, 目录从 `memory/atoms/{type}/` 移到 `memory/archive/{type}/`
     - DB: `archived=1`, `full_path` 更新
  e. 生成衰减报告 `memory/reports/decay-{timestamp}.md`

## 6. 约束永久性
`来源: nanobot/memory/decay_task.py _should_archive()`

GIVEN constraint 类型 (importance=1.0)
WHEN 衰减检查
THEN `lambda = 0.025 x (1 - 1.0) = 0` -> strength 永不变 -> 永不归档

## 7. 待办管理
`来源: nanobot/agent/todo.py`

GIVEN LLM 调 `todo_write({todos: [{action:"add", content:"整理报告", priority:"high"}, {action:"list"}]})`
WHEN 工具执行
THEN `~/.pi/agent/data/todo.json` 更新
AND 返回当前待办列表

## 8. 定时任务
`来源: nanobot/cron/service.py + types.py`

GIVEN LLM 调 `cron_write({operations: [{action:"add", name:"站会", schedule:{kind:"cron", expr:"0 9 * * 1-5", tz:"Asia/Shanghai"}, prompt:"站会时间到了"}]})`
WHEN 工具执行
THEN 写入 `~/.pi/agent/data/cron.json`
WHEN 下次 `session_start`
THEN 检查 overdue 任务, 逐个发 prompt 给 agent 执行

## 9. 网页搜索
`来源: nanobot/agent/tools/search.py`

GIVEN LLM 调 `web_search({query: "Python 3.13 新特性", max_results: 5})`
WHEN 工具执行
THEN 调 config.search.provider API (默认 tavily)
AND 返回 `[{title, url, snippet}]` 列表

## 10. 网页抓取
`来源: nanobot/agent/tools/web.py`

GIVEN LLM 调 `web_fetch({url: "https://docs.python.org/3.13/whatsnew/3.13.html"})`
WHEN 工具执行
THEN 检查 URL 非内网 (SSRF 防范)
AND HTTP GET 页面 HTML
AND readability 提取纯文本
AND 返回文本, 超 max_length 截断

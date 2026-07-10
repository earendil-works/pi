# 变更提案: agent-driven-memory-save

## 动机

memory 子系统当前写路径只有一个:`session_before_compact` → LLM 抽取 (`extraction.ts:executePlan`) → `writeAtomToFile` → index → vector。这条路径有三个结构性问题:

1. **agent 没有显式写入口** — 想"立刻记下这条规则"必须等 compact,且 agent 自己无法控制粒度或类型。LLM 抽取是事后批处理,会话中学到的东西有可能跨多轮才被识别出来。
2. **agent 可以绕过 schema** — 通用 `write`/`edit`/`bash` 可以直接落盘 `~/.pi/agent/memory/atoms/**`,绕过 frontmatter 校验、embedding、index、dedup,产出不可被 recall 找到的"幽灵 atom"或污染 DB。
3. **抽取失败 = compact 取消** — `session_before_compact` 当前是 hard-gate (memory.ts:336),LLM 不可达就阻止 compact;现代对话里很多 turn 不值得抽,失败概率随 session 长度上升。

## 影响范围

- 新增 Capability: `agent-memory-write-tool` — agent 可通过单一 `memory_save` tool 主动写 memory
- 修改 Capability: `memory-pipeline` — 拆分 dedup 为两阶段 (查 → 写),供新 tool 与现有 PATCH 路径复用
- 修改 Capability: `memory-v2` — `session_before_compact` 改为 safety net (0 save 时跑,失败 graceful 不再 cancel compact)
- 修改 Capability: `memory-v2` — system prompt 增量,告知 agent `memory_save` 的存在与使用规范
- 修改 Capability: `memory-v2` — `tools.ts:tool_call` hook 加分支,硬阻断 `write`/`edit`/`bash` 直接落盘 `atoms/**`

## 非目标

- 不替换 webui `PATCH /api/memory/:id` 路径(那是给人/UI 用的,与 agent 工具正交)
- 不引入 `memory_update` / `memory_archive` tool(用户确认:更新走 overwrite 复用 id;归档由 supersede/auto-decay/webui 负责)
- 不改 extraction LLM 抽取 prompt / `executePlan` 逻辑本身,只调整 `session_before_compact` 的触发条件与失败行为
- 不改 HTTP API 形态 / DB schema / 前端 UI
- 不改 recall / gate / rerank / hybrid-search 任意读路径

## 验收标准

1. agent 可通过 `memory_save` tool 主动写 atom,不依赖 compact 触发
2. `memory_save` 无 id 且 cosine 相似度 ≥ 0.65 时返回 `{conflict: {id, score, title}}`,不写入
3. `memory_save` 带 id 且 DB 存在该 atom 时,旧 atom 的 file/row/vector 全清,新 atom 复用 id 入库(幂等 overwrite)
4. `memory_save` 带 id 但 DB 不存在 → 返回 `{error: "id_not_found"}`,不写入
5. agent 调用 `write` 工具路径命中 `~/.pi/agent/memory/atoms/**` → tool_call hook 返回 block error
6. agent 用 `bash` 通过 `>` / `>>` / `tee ` 显式写到该路径 → tool_call hook 返回 block error
7. 进程内 writer (`writeAtomToFile` 自身) 不被 hook 拦截(自洽)
8. 整段对话 agent `memory_save` ≥ 1 次 → `session_before_compact` safety net 跳过
9. 整段对话 agent `memory_save` = 0 次 → safety net 跑抽取,产物入 `~/.pi/agent/memory/inbox/`(不入 atoms 主库)
10. safety net 抽取失败 (无 model 配置 / auth 失败 / LLM 错误) → graceful skip,compact 继续
11. embedding 服务 15s 超时或不可达 → atom 仍写入,但无向量(`memory_vectors` 缺行,recall 走 sparse 兜底)
12. 现有 webui PATCH /api/memory/:id 路径行为不变(回归)
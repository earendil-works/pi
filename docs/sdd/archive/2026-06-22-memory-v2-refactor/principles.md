# 本变更原则

<!-- 一句话一条，里程碑追加到 CLAUDE.md -->

- 记忆系统使用纯向量检索,删除 FTS5、混合检索、BM25 评分。
- LLM 只决定记忆的内容(type/title/content/tags/importance),代码决定存储策略(skip/supersede/create),LLM 不再决定 create/update/skip。
- 内容指纹(sha256 标准化 content)+ 嵌入余弦相似度阈值(默认 0.92)是去重的唯一依据,token 词袋 Jaccard 不再使用。
- 记忆类型简化为三大类(rule/fact/process),每类对应一个目录;rule 类型永不因衰减自动归档。
- 记忆文件路径使用 atom.id 作为文件名,不基于 title slug,避免 slug 冲突覆盖。
- 注入采用 L0(summary)/L1(content)双层结构,L1 仅对 top-N=3 触发,默认 token budget 4000。
- 召回失败(embedding 服务不可用)直接返回空结果,无 FTS 兜底、无 LLM 改写回退。
- 写入路径使用 SQLite 事务保证原子性(supersede 旧 atom + 插入新 atom 在同一事务),fingerprint 唯一索引防并发重复写入。
- 嵌入向量化时机:写入时同步算(去除网络依赖)、编辑后重算、归档时删除向量。
- 旧数据不迁移,新 DB 从零开始,production 现有 177 atom 废弃。

## 已知风险与设计取舍 (sdd-release 安全审计)

- **测试 fixture 含真实会话**: `extensions/personal-assistant/test/fixtures/session-sample.jsonl` 是用户真实 session 截取 (416KB,最后 200 条),含用户名/项目路径/LLM 完整响应。仓库为私人项目 (no upstream sync),接受此风险,不替换为合成数据。
- **embed.ts 无 SSRF guard**: `embed.ts` 直接 fetch `cfg.ollamaUrl` (默认 `http://127.0.0.1:11434`),未复用 `tools.ts` 的 `isPrivateIP` guard。接受风险 — 设计假设 ollama 始终是本地内嵌服务,config 仅 trusted local 来源写入 (settings.json 不可被未授权用户修改)。如未来 config 可被 prompt 注入或 webui 写入,需补 guard。
- **召回 memory 无结构化分隔**: 召回 atom content 直接拼接到 user message (`memory.ts` context hook),不包裹 `<memory-context>` 标签。LLM 可能将 memory content 误识别为 instruction。接受 — local-only threat model + memory 来源已 controlled (LLM 自身提取 + PATCH 需要 access to webui)。
- **session_before_compact LLM 存根**: hook 内 `callLlm` 永远返回 `{"items":[]}`,不会通过 LLM 提取 atoms。workaround 是手动调 `POST /api/memory/extract`。已知偏差,待 ExtensionContext API 稳定后替换为 `ctx.session.complete(prompt)`。
- **0-vector pollution workaround**: 嵌入失败时仍写入 DB 但 vector 长度为 0,这些 atom 在 KNN 中永远不被召回 (cosine similarity 对 0 向量定义不明)。已记录在 `decay.ts` 注释,后续应改为"嵌入失败则不写入"。
- **事务默认 deferred BEGIN**: better-sqlite3 默认 `BEGIN DEFERRED`,supersede + insert 的并发场景可能在读后写失败时重试。已记录为偏差 (本机串行使用下不触发)。

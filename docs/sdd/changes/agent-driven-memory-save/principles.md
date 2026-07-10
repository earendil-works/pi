# 本变更原则

<!-- 一句话一条,里程碑追加到 CLAUDE.md -->

- agent-driven `memory_save` 是 memory 写入的主路径,`session_before_compact` 退化为仅在 agent 整段对话零调用时的兜底。
- 去重走 fingerprint (sha256(normalized content).slice(0,16)) + LLM oldId 决策两条路径,与 extract pipeline 共享同一函数 `extraction.ts:executeItem`;不引入 cosine gate 或 LLM 二次确认(2026-07-09 commit 2a9697795 已锁定)。
- overwrite 走 `MemoryIndex.updateAtom` in-place UPDATE(保留 id,SQL 自动 `version = version + 1`),不删不插;supersede 链仅由 webui PATCH `supersedeIfSimilar` 路径产生,与 agent `memory_save` 正交。
- agent 不可绕过 `memory_save` tool 直接落盘 `~/.pi/agent/memory/atoms/**`,`tool_call` hook 必须硬阻断 `write` / `edit` / `bash` 写该路径(读不受限;`writeAtomToFile` 经 fs 直调,不经 hook,自洽)。
- safety net 失败必须 graceful skip,不再取消 compact;抽取不可达是工程常态,不是用户错误。
- embedding 服务不可达不阻塞写入,atom 入库但 vector 用 zero-vector fallback(`embedding ?? new Array(1024).fill(0)`),recall 走 bge-m3 sparse channel 兜底。
- agent save 计数用于触发 safety net 判定,计入"调用"而不计入"成功"(被 fingerprint 拒也算 agent 主动管理过 memory)。
- TUI context hook 与 webui `/api/memory/search` 必须通过同一 `recallPipeline()` 函数完成 rewrite → recall → rerank → merge,除 gate 外不接受 pipeline 漂移。
- `recallPipeline` 接受 `recent: string[] | null` 参数,TUI 传前 3 条 user msg(指代消解),webui 默认传 null(无会话上下文);`topK` 默认 20 两路径一致。
- `recallPipeline` 是 TUI 与 webui 唯一的 recall 入口;inline 重复实现视为 regression,review 阶段必须拒绝。
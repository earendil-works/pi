# 本变更原则

<!-- 一句话一条,里程碑追加到 CLAUDE.md -->

- agent-driven `memory_save` 是 memory 写入的主路径,session_before_compact 退化为仅在 agent 整段对话零调用时的兜底。
- 所有写入前必须先做 cosine 查 (与 extract pipeline 共用同一阈值 0.65 与同一函数 `supersedeIfSimilar`),不允许在不知有相似 atom 的情况下覆盖。
- agent 不可绕过 `memory_save` tool 直接落盘 `~/.pi/agent/memory/atoms/**`,`tool_call` hook 必须硬阻断 `write` / `edit` / `bash` 写该路径(读不受限)。
- safety net 失败必须 graceful skip,不再取消 compact;抽取不可达是工程常态,不是用户错误。
- embedding 服务不可达不阻塞写入,atom 仍入库但无向量,recall 走 sparse channel 兜底。
- overwrite 模式 (agent 提供 id) 不保留版本链,视为"替换"而非"修订";supersede 链仅在 auto-extract (`extraction.ts:executePlan`) 路径保留,与 agent `memory_save` 正交。
- agent save 计数用于触发 safety net 判定,计入"调用"而不计入"成功"(被 conflict 拒也算 agent 主动管理过 memory)。
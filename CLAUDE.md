# CLAUDE.md

Project-wide principles distilled from archived SDD changes. These apply to all
work in this repo; per-change principles are in `docs/sdd/archive/<change>/principles.md`.

## Satellite 远程执行原则

- Guardrail 拦截后返回 guidance error,不静默默重定向——让模型看见错误才能自纠正
- satellite 子工具 schema 与原生 pi 工具完全对齐:参数名、类型、可选性、description 一致
- `transfer_file` 走 HTTP body 传输,文件内容不经过 LLM context tokens
- `transfer_file` direction 字面量只有 `upload`/`download`,agent 必须显式声明方向
- bash guardrail 最多容忍 2 次同一模式违规,第 3 次返回硬错误
- 合法 bash 命令不受拦截(仅拦截 cat/sed/echo >/find 模式)
- 远程路径模式通过 `SATELLITE_GUARD_PATTERN` env var 配置,默认为空(不启用 guardrail)

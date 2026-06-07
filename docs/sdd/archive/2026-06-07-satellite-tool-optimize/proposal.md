# 变更提案: satellite-tool-optimize

## 动机

Agent 在使用 satellite MCP 工具时存在三个不一致的工具选择问题:

1. **远程 bash vs 专用工具选错**: Agent 调用 `satellite_remote_exec` 后,倾向在 union 内选 `tool="bash"` 并用 `cat`/`sed`/`echo >` 代替专用的 `read_file`/`edit_file`/`write_file`。bash 命令缺乏 offset/limit 截断保护、无模糊匹配、无 diff 反馈,且 `find` 在远程深度目录中会长时间阻塞。

2. **远程工具 vs 本地工具选错**: Agent 对匹配 `TJPROJ[数字]` 的远程路径,仍然调用本地 `bash`/`read`/`write`/`edit`,而不是 `satellite_remote_exec`。本地无法访问远程文件系统。

3. **文件传输方向混乱**: Agent 在 local↔remote 之间传递文件时,常出现本地 cat 读然后 local write 写、或 remote read 然后 remote write——完全反了。缺少一个显式声明 "从哪到哪" 的工具。

4. **缺少远程搜索工具**: satellite 没有 `find`/`grep` 子操作,agent 被迫用 bash find/rg,在 HPC 深目录结构中极慢且无 truncation 保护。

**核心矛盾**: Agent 训练数据中 `bash(cat ...)` 的 token 概率远高于 `satellite_remote_exec(read_file ...)`,导致即使有更好的工具,也选择熟悉的模式。

**解决思路**: Forge 风格 guardrail(bash intent detection → guidance error,让模型自纠正) + 补齐缺失的工具(transfer_file/find_files/grep_files) + schema/description 对齐原生工具。

## 影响范围

- 修改 Capability: satellite MCP — schema 对齐、描述增强、bash intent detection guardrail、default timeout
- 新增 Capability: `transfer_file` 子操作(local↔remote 双向文件传输,带 HTTP 传输通道)
- 新增 Capability: `find_files` + `grep_files` 子操作(fd/rg 远程文件搜索)
- 新增 Capability: tool routing guardrail(本地工具拦截远程路径,通过 MCP prompt 注入)
- 删除: `extensions/satellite/satellite-mcp.ts` (v2 stdio,不再维护)

## 非目标

- 不改变 satellite 的 union tool 架构(保持 `remote_exec` 单工具 + 子操作模式)
- 不修改 MCP transport 层
- 不实现 transparent redirect(静默默重定向),遵循 guardrail 模式
- 层 A guardrail 为软约束(prompt 注入),硬拦截 deferred 到后续 change

## 验收标准

1. **Schema 对齐**: 8 个子操作的参数名、类型、可选性与原生 pi 工具一致
2. **描述增强**: 每个子操作 description 含"何时使用"guidance + 与 bash 的对比
3. **bash guardrail**: `handleBash` 检测 `cat`/`sed`/`echo >` → 返回 guidance error;检测 `find` → 自动注入 timeout/limit
4. **bash 超时**: 默认 30s,agent 未指定 timeout 则 kill + isError
5. **transfer_file**: 双路径参数(direction + local_path + remote_path),HTTP 通道传输,不走 LLM context
6. **find_files + grep_files**: 远程执行 fd/rg,带 limit/truncation,行为匹配原生 `find`/`grep`
7. **层 A prompt 注入**: 从 `mcp.json` 读取 `remotePathPattern` → 注入 system prompt 声明远程路径归属
8. **向后兼容**: 现有 `remote_exec` 调用不受影响
9. **v2 清理**: 删除 `satellite-mcp.ts`

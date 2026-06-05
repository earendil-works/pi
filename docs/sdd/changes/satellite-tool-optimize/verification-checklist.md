# Verification Checklist: satellite-tool-optimize

> 生成时间: 2026-06-05 | 审查者必须逐项验证并附可追溯证据
> 状态: [ ] 待验证 | [x] 通过 | [!] 失败（必须修复或记录偏差）

## 场景验证 (Scenarios)

| # | 场景 | 来源 | 验证方式 | 验证命令/步骤 | 期望结果 | 状态 |
|---|------|------|----------|--------------|---------|------|
| S1 | 层 A — system prompt 声明远程路径归属 (软约束) | scenarios.md:5 | code-review + manual | 编辑 `~/.pi/agent/mcp.json` 包含 `remotePathPattern: "/TJPROJ\\d+"`;启动 `pi` CLI;打印 `event.systemPrompt` 含 "Remote Paths" 节 | 启动后 systemPrompt 包含 "Files matching pattern `/TJPROJ\d+/` are on the remote HPC" | [ ] |
| S2 | 层 B — bash cat 引导到 read_file | scenarios.md:12 | unit-test | `bun test extensions/satellite/satellite-server.test.ts -t "bash cat"` | 拦截, isError=true, content 含 "Prefer read_file" | [ ] |
| S3 | 层 B — bash sed -i 引导到 edit_file | scenarios.md:17 | unit-test | `bun test -t "bash sed -i"` | isError=true, content 含 "Prefer edit_file" | [ ] |
| S4 | 层 B — bash echo > 引导到 write_file | scenarios.md:22 | unit-test | `bun test -t "bash echo"` | isError=true, content 含 "Prefer write_file" | [ ] |
| S5 | 层 B — bash find 引导到 find_files | scenarios.md:27 | unit-test | `bun test -t "bash find"` | isError=true, content 含 "Prefer find_files" | [ ] |
| S6 | 层 B — 合法 bash 命令正常通过 | scenarios.md:33 | unit-test | `bun test -t "legitimate bash"` | 不拦截, spawn 正常执行 | [ ] |
| S7 | Agent 自纠正后直接调 read_file | scenarios.md:38 | manual | 通过 MCP 调用 `remote_exec(tool="read_file", path=...)` | 返回文件内容,无拦截 | [ ] |
| S8 | Schema 对齐 — list_dir path 可选 | scenarios.md:43 | unit-test | `bun test -t "list_dir default path"` | 不传 path 时默认 ".";handler 列出当前目录 | [ ] |
| S9 | bash 默认超时 30s | scenarios.md:48 | unit-test | `bun test -t "default timeout"` | `sleep 60` 无 timeout 在 30-35s 内返回 isError | [ ] |
| S10 | transfer_file — 上传本地文件到远程 | scenarios.md:53 | unit-test + curl | `bun test -t "transfer_file upload"` + `curl -X POST --data-binary "@file" /transfer?path=...` | upload handler 返回 content;POST /transfer 写文件成功 | [ ] |
| S11 | transfer_file — 从远程下载文件到本地 | scenarios.md:60 | unit-test + curl | `bun test -t "transfer_file download"` + `curl /transfer?path=...` | download handler 写文件成功;GET /transfer 返回字节 | [ ] |
| S12 | find_files — 远程按 glob 搜索文件 | scenarios.md:66 | unit-test | `bun test -t "find_files"`(fd available) | 返回文件列表,limit 截断生效 | [ ] |
| S13 | grep_files — 远程按正则搜索代码 | scenarios.md:72 | unit-test | `bun test -t "grep_files"`(rg available) | 返回匹配行,limit 截断生效 | [ ] |
| S14 | find_files — 远程 fd 未安装 | scenarios.md:78 | unit-test | `bun test -t "find_files fd missing"` (mock which fd to return empty) | isError=true, content 含 "fd not found... apt install fd-find" | [ ] |
| S15 | grep_files — 远程 rg 未安装 | scenarios.md:84 | unit-test | `bun test -t "grep_files rg missing"` (mock which rg) | isError=true, content 含 "ripgrep not found... apt install ripgrep" | [ ] |
| S16 | transfer_file — direction 参数无效 | scenarios.md:90 | unit-test | `bun test -t "transfer_file invalid direction"` | isError=true, content 含 "direction must be 'upload' or 'download'" | [ ] |
| S17 | Agent 连续无视 guardrail (层 B) | scenarios.md:101 | unit-test | `bun test -t "guardrail retry budget"` | 第 3 次 cat 返回 hard error: "Blocked: you have tried bash cat 3 times" | [ ] |
| S18 | 路径包含 TJPROJ 但不匹配正则 | scenarios.md:113 | unit-test | `bun test -t "TJPROJ-backup"` | detectIntent 不匹配,正常 spawn | [ ] |
| S19 | 远程路径被挂载到本地 | scenarios.md:118 | manual | 模拟 NFS 挂载,验证本地 read 仍可工作 | 软约束, 不阻止本地工具 | [ ] |
| S20 | bash 命令参数缺失 | scenarios.md:123 | unit-test | `bun test -t "bash missing command"` | zod validation error, isError=true | [ ] |
| S21 | satellite unreachable 时 guardrail 仍触发 | scenarios.md:128 | manual | 关闭 satellite-server, 触发层 A guardrail | 引导 agent 用 satellite_remote_exec, 失败时返回 connection error | [ ] |

## 需求验证 (Requirements)

| # | 需求 | 来源 | 验证方式 | 期望证据 | 状态 |
|---|------|------|----------|---------|------|
| R1 | Bash Guardrail Intent Detection | spec.md ADDED #1 | code-review | `extensions/satellite/satellite-server.ts:detectIntent` 实现 + `bun test` 全 8 个场景通过 | [ ] |
| R2 | Guardrail Retry Budget | spec.md ADDED #2 | code-review | `guardrailRetry` Map + 第 3 次 hard-block 逻辑, `bun test` 通过 | [ ] |
| R3 | Bash Default Timeout | spec.md ADDED #3 | code-review + unit-test | `handleBash` 中 `timeout = args.timeout ?? 30`, `bun test` 通过 | [ ] |
| R4 | Sub-Operation Schema Alignment | spec.md ADDED #4 | unit-test | `list_dir` schema path 改为 `.optional().default(".")` + 8 个 schema 全部存在 | [ ] |
| R5 | File Transfer Sub-Operation | spec.md ADDED #5 | unit-test + curl | `transfer_file` schema + handler 实现, `bun test` + `curl /transfer` 双向通过 | [ ] |
| R6 | HTTP Transfer Endpoints | spec.md ADDED #6 | curl | `POST /transfer?path=` 写文件, `GET /transfer?path=` 读文件, 无 auth → 401, 缺 path → 400 | [ ] |
| R7 | Remote File Search Sub-Operations | spec.md ADDED #7 | unit-test | `find_files` + `grep_files` schema + handler, fd/rg 缺失时 isError | [ ] |
| R8 | Layer A System Prompt Soft Guardrail | spec.md ADDED #8 | manual | 启动时 systemPrompt 包含 "Remote Paths" 节, 包含 `remotePathPattern` 提示 | [ ] |

## 通过标准

- [ ] 所有场景 (S1-S21) 状态为 [x]，每项有可追溯证据
- [ ] 所有需求 (R1-R8) 状态为 [x]，每项有源码行号
- [ ] 证据格式: R 类 → 源码文件:行号，S 类 → curl 输出/screenshot/测试结果

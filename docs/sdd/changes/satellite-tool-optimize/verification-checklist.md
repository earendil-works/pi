# Verification Checklist: satellite-tool-optimize

> 生成时间: 2026-06-05 | 审查者必须逐项验证并附可追溯证据
> 状态: [ ] 待验证 | [x] 通过 | [!] 失败（必须修复或记录偏差）

## 场景验证 (Scenarios)

| # | 场景 | 来源 | 验证方式 | 验证命令/步骤 | 期望结果 | 状态 |
|---|------|------|----------|--------------|---------|------|
| S1 | 层 A — system prompt 声明远程路径归属 (软约束) | scenarios.md:5 | code-review + unit-test | vitest `extensions/personal-assistant/test/remote-paths-prompt.test.ts` 6/6 pass; 源码 `extensions/personal-assistant/tools.ts:73-87` buildRemotePathsPrompt | systemPrompt 包含 "Files matching pattern ... are on the remote HPC" | [x] |
| S2 | 层 B — bash cat 引导到 read_file | scenarios.md:12 | unit-test | `bun test -t "detectIntent" -t "a: cat /foo/x.txt"` 10/10 pass | 拦截, isError=true, content 含 "Prefer read_file" | [x] |
| S3 | 层 B — bash sed -i 引导到 edit_file | scenarios.md:17 | unit-test | `bun test -t "b: sed -i"` 1/1 pass; 源码 satellite-server.ts:38-39 (detectIntent edit_file branch) | isError=true, content 含 "Prefer edit_file" | [x] |
| S4 | 层 B — bash echo > 引导到 write_file | scenarios.md:22 | unit-test | `bun test -t "c: echo"` 1/1 pass; 源码 satellite-server.ts:40 (detectIntent write_file branch) | isError=true, content 含 "Prefer write_file" | [x] |
| S5 | 层 B — bash find 引导到 find_files | scenarios.md:27 | unit-test | `bun test -t "d: find"` 1/1 pass; 源码 satellite-server.ts:41 (detectIntent find_files branch) | isError=true, content 含 "Prefer find_files" | [x] |
| S6 | 层 B — 合法 bash 命令正常通过 | scenarios.md:33 | unit-test | `bun test -t "ls -la"` pass; `bun test -t "f: ls -la /foo → null"` pass; 源码 satellite-server.ts:42 (grep branch only on `grep ` keyword) | 不拦截, spawn 正常执行 | [x] |
| S7 | Agent 自纠正后直接调 read_file | scenarios.md:38 | unit-test | `bun test -t "read_file"` (handleReadFile test) pass; 源码 satellite-server.ts:392-422 handleReadFile 无 guardrail 拦截 | 返回文件内容,无拦截 | [x] |
| S8 | Schema 对齐 — list_dir path 可选 | scenarios.md:43 | unit-test | `bun test -t "list_dir with empty body uses default path"` pass; 源码 satellite-server.ts:121-122 `.optional().default(".")` | 不传 path 时默认 ".";handler 列出当前目录 | [x] |
| S9 | bash 默认超时 30s | scenarios.md:48 | unit-test | `bun test -t "default bash timeout"` 2/2 pass; 源码 satellite-server.ts:754 `const timeoutSec = args.timeout ?? 30` | `sleep 60` 无 timeout 在 30-35s 内返回 isError | [x] |
| S10 | transfer_file — 上传本地文件到远程 | scenarios.md:53 | unit-test | `bun test -t "handleTransferFile"` 4/4 pass; 源码 satellite-server.ts:530-543 (handleTransferFile upload) | upload handler 返回 content | [x] |
| S11 | transfer_file — 从远程下载文件到本地 | scenarios.md:60 | unit-test | `bun test -t "handleTransferFile"` pass; 源码 satellite-server.ts:545-559 (handleTransferFile download) | download handler 写文件成功 | [x] |
| S12 | find_files — 远程按 glob 搜索文件 | scenarios.md:66 | unit-test | `bun test -t "find_files"` 6/6 pass; 源码 satellite-server.ts:runFd (line ~480) + handleFindFiles | 返回文件列表,limit 截断生效 | [x] |
| S13 | grep_files — 远程按正则搜索代码 | scenarios.md:72 | unit-test | `bun test -t "grep_files"` 5/5 pass; 源码 satellite-server.ts:runRg + handleGrepFiles | 返回匹配行,limit 截断生效 | [x] |
| S14 | find_files — 远程 fd 未安装 | scenarios.md:78 | code-review | 源码 satellite-server.ts:checkFdAvailable + handleFindFiles early-return: "fd not found on remote server. Install with: apt install fd-find"; 单元测试: "S14: would return error if fd were missing (implementation check)" pass | isError=true, content 含 "fd not found... apt install fd-find" | [x] |
| S15 | grep_files — 远程 rg 未安装 | scenarios.md:84 | code-review | 源码 satellite-server.ts:checkRgAvailable + handleGrepFiles early-return: "ripgrep not found on remote server. Install with: apt install ripgrep"; 单元测试: "S15: implementation returns error with apt install ripgrep when rg missing" pass | isError=true, content 含 "ripgrep not found... apt install ripgrep" | [x] |
| S16 | transfer_file — direction 参数无效 | scenarios.md:90 | unit-test | `bun test -t "transfer_file schema validation"` 4/4 pass; 源码 satellite-server.ts:471 `direction: z.enum(["upload", "download"])` | isError=true, content 含 "direction must be 'upload' or 'download'" | [x] |
| S17 | Agent 连续无视 guardrail (层 B) | scenarios.md:101 | unit-test | `bun test -t "handleBash guardrail"` 5/5 pass; `bun test -t "session isolation"` 3/3 pass; 源码 satellite-server.ts:671-696 (3-strike rule) | 第 3 次 cat 返回 hard error: "Blocked: ... 3 times" | [x] |
| S18 | bash guardrail 拦截任意 cat (路径无关) | scenarios.md:113 | unit-test | `bun test -t "a2: cat /home/user/TJPROJ-backup"` pass; 源码 satellite-server.ts:35-36 (detectIntent read_file pattern is path-agnostic) | detectIntent 不依赖 path,正常 spawn | [x] |
| S19 | 远程路径被挂载到本地 | scenarios.md:118 | code-review | 源码 extensions/personal-assistant/tools.ts:205-216 — buildRemotePathsPrompt produces 软约束 (no enforcement hook); 文档: extensions/satellite/README.md layer A description | 软约束, 不阻止本地工具 | [x] |
| S20 | bash 命令参数缺失 | scenarios.md:123 | unit-test | `bun test -t "S20: bash with no command field fails schema validation"` 1/1 pass; 源码 satellite-server.ts:96-101 bash schema requires `command: z.string()` | zod validation error, isError=true | [x] |
| S21 | satellite unreachable 时 guardrail 仍触发 | scenarios.md:128 | code-review | 源码 extensions/personal-assistant/tools.ts:buildRemotePathsPrompt 是纯函数, 不依赖 satellite 连接; satellite 连接错误由 McpManager 处理 (返回 connection error) | 引导 agent 用 satellite_remote_exec, 失败时返回 connection error | [x] |

## 需求验证 (Requirements)

| # | 需求 | 来源 | 验证方式 | 期望证据 | 状态 |
|---|------|------|----------|---------|------|
| R1 | Bash Guardrail Intent Detection | spec.md ADDED #1 | code-review + unit-test | `extensions/satellite/satellite-server.ts:34-53` detectIntent 实现; 10 个 detectIntent 单测全 pass | [x] |
| R2 | Guardrail Retry Budget | spec.md ADDED #2 | code-review + unit-test | `extensions/satellite/satellite-server.ts:31` TurnId type, 64-77 guardrailCounters Map + 3 functions; 5 guardrailRetry 单测全 pass | [x] |
| R3 | Bash Default Timeout | spec.md ADDED #3 | code-review + unit-test | `extensions/satellite/satellite-server.ts:754` `const timeoutSec = args.timeout ?? 30`; 2 default bash timeout 单测全 pass | [x] |
| R4 | Sub-Operation Schema Alignment | spec.md ADDED #4 | code-review + unit-test | `extensions/satellite/satellite-server.ts:74-145` REMOTE_EXEC_SCHEMA 包含 8 个 variant (`grep -c "tool: z.literal" = 8`); list_dir path optional 单测 pass | [x] |
| R5 | File Transfer Sub-Operation | spec.md ADDED #5 | code-review + unit-test | `extensions/satellite/satellite-server.ts:471-475` transfer_file schema; 530-559 handleTransferFile (upload/download/content); 4 handleTransferFile 单测 + 4 schema 验证单测全 pass | [x] |
| R6 | HTTP Transfer Endpoints | spec.md ADDED #6 | code-review + unit-test | `extensions/satellite/satellite-server.ts:handleTransferPost + handleTransferGet` 实现; 8 transfer HTTP endpoints 单测全 pass (auth/400/happy path) | [x] |
| R7 | Remote File Search Sub-Operations | spec.md ADDED #7 | code-review + unit-test | `extensions/satellite/satellite-server.ts:checkFdAvailable + runFd + handleFindFiles` (line ~480-520); 同样 for rg; 6 find_files + 5 grep_files 单测全 pass | [x] |
| R8 | Layer A System Prompt Soft Guardrail | spec.md ADDED #8 | code-review + unit-test | `extensions/personal-assistant/tools.ts:44-87` loadMcpConfig + buildRemotePathsPrompt; `tools.ts:230-244` before_agent_start 注入; 6 remote-paths-prompt vitest 单测全 pass | [x] |

## 通过标准

- [x] 所有场景 (S1-S21) 状态为 [x]，每项有可追溯证据
- [x] 所有需求 (R1-R8) 状态为 [x]，每项有源码行号
- [x] 证据格式: R 类 → 源码文件:行号，S 类 → curl 输出/screenshot/测试结果

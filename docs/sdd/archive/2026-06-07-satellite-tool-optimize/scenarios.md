# 使用场景

## 正常流程

### 场景: 层 A — system prompt 声明远程路径归属 (软约束)
**GIVEN** `mcp.json` 配置了 `remotePathPattern: "/TJPROJ\\d+"`
**WHEN** agent 启动并连接 satellite MCP
**THEN** system prompt 注入: "Files under /TJPROJ\\d+/ are on remote HPC. Use satellite_remote_exec for all file operations on these paths."
**AND** Agent 在后续对话中优先选择 `satellite_remote_exec` 而非本地 `bash`/`read`/`write`/`edit`
**AND** 此为软约束(prompt 级),agent 可能忽略但概率降低

### 场景: 层 B — bash cat 引导到 read_file
**GIVEN** Agent 调用了 `satellite_remote_exec(tool="bash", command="cat /TJPROJ1/data/x.log")`
**WHEN** satellite handleBash 检测到 `cat <path>` 模式
**THEN** 不 spawn,返回 error: "Use read_file (tool='read_file') instead of bash cat. It supports offset, limit, and truncation. Try: tool=read_file, path='/TJPROJ1/data/x.log'"

### 场景: 层 B — bash sed -i 引导到 edit_file
**GIVEN** Agent 调用了 `satellite_remote_exec(tool="bash", command="sed -i 's/x/y/g' /TJPROJ1/config.ini")`
**WHEN** satellite handleBash 检测到 `sed -i` 模式
**THEN** 返回 error: "Use edit_file (tool='edit_file') instead of bash sed -i. It supports fuzzy matching, multi-edit atomicity, and diff feedback."

### 场景: 层 B — bash echo > 引导到 write_file
**GIVEN** Agent 调用了 `satellite_remote_exec(tool="bash", command="echo 'new data' > /TJPROJ1/out.txt")`
**WHEN** satellite handleBash 检测到 `echo/printf >` 模式
**THEN** 返回 error: "Use write_file (tool='write_file') instead of bash echo redirect. It auto-creates parent directories and handles file locking."

### 场景: 层 B — bash find 引导到 find_files
**GIVEN** Agent 调用了 `satellite_remote_exec(tool="bash", command="find /TJPROJ1/ -name '*.ts'")`
**WHEN** satellite handleBash 检测到 `find` 命令
**THEN** 返回 error: "Prefer find_files over bash find. It uses fd with proper limit/truncation. Use tool=find_files, pattern='*.ts', path='/TJPROJ1/'"

### 场景: 层 B — 合法 bash 命令正常通过
**GIVEN** Agent 调用了 `satellite_remote_exec(tool="bash", command="ls -la /TJPROJ1/data/")`
**WHEN** satellite handleBash 检测,但不匹配 cat/sed/echo/find 模式
**THEN** 正常 spawn 执行,不受 guardrail 影响

### 场景: Agent 自纠正后直接调 read_file
**GIVEN** 前一轮 agent 被 guardrail 纠正(无论层 A 或层 B)
**WHEN** 下一轮 agent 直接调用 `satellite_remote_exec(tool="read_file", path="/TJPROJ1/data/file.txt")`
**THEN** 直接执行 handleReadFile(带 offset/limit/截断),无拦截

### 场景: Schema 对齐 — list_dir path 可选
**GIVEN** Agent 调用 `satellite_remote_exec(tool="list_dir")` (不传 path)
**WHEN** satellite 处理
**THEN** 默认使用 ".",行为与原生 `ls` 一致(path 可选)

### 场景: bash 默认超时 30s
**GIVEN** Agent 调 `satellite_remote_exec(tool="bash", command="sleep 60")` 无 timeout 参数
**WHEN** 30s 后命令仍未返回
**THEN** 进程被 kill,返回 isError: "Command exceeded 30s timeout (no timeout set). Use timeout=<seconds> for long tasks."

### 场景: transfer_file — 上传本地文件到远程
**GIVEN** Agent 需要将 `/home/user/input.csv` 传到远程 `/TJPROJ1/project/data.csv`
**WHEN** Agent 调用:
  `read(local_path="/home/user/input.csv")` → 读到内容
  `satellite_remote_exec(tool="transfer_file", direction="upload", local_path="/home/user/input.csv", remote_path="/TJPROJ1/project/data.csv")`
**THEN** pi agent 读 local_path → POST /transfer?path=remote_path(body=bytes) → satellite 写文件 → 返回确认

### 场景: transfer_file — 从远程下载文件到本地
**GIVEN** Agent 需要下载 `/TJPROJ1/project/result.csv` 到本地 `./output/result.csv`
**WHEN** Agent 调用:
  `satellite_remote_exec(tool="transfer_file", direction="download", remote_path="/TJPROJ1/project/result.csv", local_path="./output/result.csv")`
**THEN** pi agent GET /transfer?path=remote_path → 读取内容 → write local_path → 返回确认

### 场景: find_files — 远程按 glob 搜索文件
**GIVEN** Agent 需要在远程搜索所有 `.ts` 文件
**WHEN** Agent 调用:
  `satellite_remote_exec(tool="find_files", pattern="*.ts", path="/TJPROJ1/project/")`
**THEN** satellite 执行 fd --glob --hidden --no-require-git → 返回文件列表(带 limit/截断)

### 场景: grep_files — 远程按正则搜索代码
**GIVEN** Agent 需要在远程搜索函数定义
**WHEN** Agent 调用:
  `satellite_remote_exec(tool="grep_files", pattern="function\\s+handle", path="/TJPROJ1/project/src/", glob="*.ts")`
**THEN** satellite 执行 rg 搜索 → 返回匹配行(带上下文行数、limit/截断)

### 场景: find_files — 远程 fd 未安装
**GIVEN** 远程服务器无 `fd` 可执行
**WHEN** Agent 调 `satellite_remote_exec(tool="find_files", pattern="*.ts", path="/TJPROJ1/")`
**THEN** satellite 执行 `which fd` 返回空,返回 isError: "fd not found on remote server. Install with: apt install fd-find"
**AND** 不降级到 system find(决策 5: 不做 fallback,明确报错)

### 场景: grep_files — 远程 rg 未安装
**GIVEN** 远程服务器无 `rg` 可执行
**WHEN** Agent 调 `satellite_remote_exec(tool="grep_files", pattern="function", path="/TJPROJ1/")`
**THEN** 返回 isError: "ripgrep not found. Install with: apt install ripgrep"
**AND** 不降级到 grep

### 场景: transfer_file — direction 参数无效
**GIVEN** Agent 调 `satellite_remote_exec(tool="transfer_file", direction="push", ...)`
**WHEN** satellite 验证 direction 非 "upload" 或 "download"
**THEN** 返回 isError: "direction must be 'upload' or 'download'"

---

## 异常流程



### 场景: Agent 连续无视 guardrail (层 B)
**GIVEN** Agent 第一次被层 B guardrail 拦截 (cat → read_file guidance)
**WHEN** Agent 再次调用 `satellite_remote_exec(tool="bash", command="cat ...")`
**AND** Guardrail 计数 +1 (已累计 2 次)
**THEN** 返回 hard error



---

## 边界条件

### 场景: bash guardrail 拦截任意 cat (路径无关)
**GIVEN** Agent 调 `bash(command="cat /home/user/TJPROJ-backup/notes.md")` (本地文件,但路径含 TJPROJ 字面量)
**WHEN** bash guardrail detectIntent 检测 `cat <path>` 模式
**THEN** 不依赖 path 匹配,统一拦截,返回 guidance 指向 `tool="read_file"`(guardrail 关注命令意图,非路径归属)

### 场景: 远程路径被挂载到本地
**GIVEN** /TJPROJ1 通过 NFS 挂载到本地文件系统,本地工具可直接读写
**WHEN** 层 A prompt 已注入远程路径声明
**THEN** Agent 仍优先选择 satellite_remote_exec(由 prompt 引导),但也允许本地工具(软约束不阻止执行)

### 场景: bash 命令参数缺失
**GIVEN** Agent 调 `satellite_remote_exec(tool="bash")` 但没传 `command` 参数
**WHEN** satellite 验证
**THEN** 返回 zod validation error(isError=true)

### 场景: satellite unreachable 时 guardrail 仍触发
**GIVEN** 层 A guardrail 拦截了远程路径,返回 guidance 建议用 satellite_remote_exec
**WHEN** satellite MCP 服务器不可达
**THEN** satellite_remote_exec 调用返回 MCP connection error,agent 自己处理(重试或告知用户)

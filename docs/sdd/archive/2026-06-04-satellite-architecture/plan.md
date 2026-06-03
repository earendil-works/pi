# 执行计划: satellite-architecture

## 任务列表

### Task 1: 卫星协议类型定义
- **文件**: `extensions/satellite/protocol.ts`
- **内容**: 定义 SatelliteRequest（id + tool + args）、SatelliteResponse（id + ok + result/error）、ToolDefinition（name + description + schema + execute）接口，使用 TypeBox schema 定义 5 个工具的参数类型（read_file: {path}, write_file: {path,content}, edit_file: {path,old_string,new_string}, bash: {command,cwd?}, list_dir: {path}）
- **验证**: `bun run extensions/satellite/protocol.ts` 无报错
- **依赖**: 无
- **状态**: [x]
- **审查**: [x]

### Task 2: 卫星工具定义与 Schema 校验
- **文件**: `extensions/satellite/tools.ts`
- **内容**: 实现 5 个工具定义对象（read_file/write_file/edit_file/bash/list_dir），每个包含 name、description、参数 schema（TypeBox）、execute 函数。实现 validateToolArgs(tool, args) 函数，使用 TypeBox Value.Check 校验参数，校验失败返回具体错误信息。实现 toolRegistry Map 存储工具定义
- **验证**: 编写简单的内联测试脚本验证 validateToolArgs 对合法/非法参数的返回值
- **依赖**: Task 1
- **状态**: [x]
- **审查**: [x]

### Task 3: 卫星 WebSocket 服务器
- **文件**: `extensions/satellite/server.ts`
- **内容**: 使用 Bun 内置 WebSocket 服务器，绑定 127.0.0.1:port。验证 Authorization 头中的 Bearer token（与 config.auth_token 比对）。接收 SatelliteRequest，查找工具定义，调用 validateToolArgs 校验，执行工具，返回 SatelliteResponse。输出日志到 stdout：`[timestamp] tool_name args_summary → ok/error duration_ms`
- **验证**: 启动卫星服务器，用 curl 测试 WebSocket upgrade 被拒绝（无 token），用正确 token 连接成功
- **依赖**: Task 1, Task 2
- **状态**: [x]
- **审查**: [x]

### Task 4: 卫星配置
- **文件**: `extensions/satellite/config.ts`
- **内容**: 定义 SatelliteConfig 接口（remote_port: number, auth_token: string, local_port: number, ssh_user: string, ssh_host: string）。实现 loadSatelliteConfig() 从 `~/.pi/agent/settings.json` 的 personalAssistant.satellite 读取。实现 validateConfig() 检查必填字段
- **验证**: 创建测试 settings.json，验证 loadSatelliteConfig 正确读取，验证 validateConfig 对缺失字段报错
- **依赖**: 无
- **状态**: [x]
- **审查**: [x]

### Task 5: 卫星入口与构建脚本
- **文件**: `extensions/satellite/satellite.ts`, `extensions/satellite/build.sh`
- **内容**: satellite.ts 作为入口，解析命令行参数（--port, --token, --config），加载配置，启动 WebSocket 服务器。build.sh 执行 `bun build --compile satellite.ts --outfile satellite` 编译为单二进制
- **验证**: `bun run build.sh` 生成 satellite 二进制，运行 `./satellite --port 9000 --token test` 启动成功，stdout 输出启动日志
- **依赖**: Task 3, Task 4
- **状态**: [x]
- **审查**: [x]

### Task 6: 添加 satellite 配置到 PersonalAssistantConfig
- **文件**: `packages/coding-agent/src/core/settings-manager.ts`
- **内容**: 在 PersonalAssistantConfig 接口添加 `satellite?: { remote_port?: number, local_port?: number, ssh_user?: string, ssh_host?: string, auth_token?: string }` 字段
- **验证**: `tsgo --noEmit` 无报错
- **依赖**: 无
- **状态**: [x]
- **审查**: [x]

### Task 7: SSH Tunnel 管理器
- **文件**: `extensions/satellite/tunnel.ts`
- **内容**: 实现 TunnelManager 类，管理 SSH tunnel 生命周期。startTunnel(config) 使用 `ssh -L local_port:localhost:remote_port ssh_user@ssh_host -N -f` 建立隧道，返回 child process。stopTunnel() 关闭子进程。isRunning() 检查子进程状态。connect(config) 建立 WebSocket 连接到 ws://localhost:local_port，发送 Authorization: Bearer token 头
- **验证**: 在本地模拟 SSH tunnel（用 socat 或 nc），验证 TunnelManager 能建立和关闭连接
- **依赖**: Task 6
- **状态**: [x]
- **审查**: [x]

### Task 8: remote 工具
- **文件**: `extensions/satellite/remote-tool.ts`
- **内容**: 创建 remote 工具的 ToolDefinition，参数 schema 为 `Type.Object({ tool: Type.String(), args: Type.Record(Type.String(), Type.Any()) })`。execute 函数：(1) 查找目标工具定义 (2) 调用 validateToolArgs 校验 args (3) 通过 TunnelManager 发送 SatelliteRequest (4) 返回结果。连接未建立时自动调用 connect()
- **验证**: 编写测试：验证缺少 tool 参数返回校验错误，验证 args 校验失败返回具体错误
- **依赖**: Task 2, Task 7
- **状态**: [x]
- **审查**: [x]

### Task 9: /connect /disconnect /satellite 命令
- **文件**: `extensions/satellite/commands.ts`
- **内容**: 实现三个 slash command。/connect: 调用 TunnelManager.connect()，输出连接状态。/disconnect: 调用 TunnelManager.disconnect()，输出断开状态。/satellite: 显示当前连接状态（host, port, uptime, 是否连接）
- **验证**: 验证命令注册正确，参数解析正确
- **依赖**: Task 7
- **状态**: [x]
- **审查**: [x]

### Task 10: 卫星扩展入口
- **文件**: `extensions/satellite/index.ts`
- **内容**: 创建扩展工厂函数，读取配置，注册 remote 工具，注册 /connect /disconnect /satellite 命令，在 session_shutdown 时清理 TunnelManager
- **验证**: `tsgo --noEmit` 无报错
- **依赖**: Task 8, Task 9
- **状态**: [x]
- **审查**: [x]

### Task 11: 端到端验证
- **文件**: 无（验证任务）
- **内容**: 完整流程验证：(1) 编译卫星二进制 (2) 在本地用 socat 模拟 SSH tunnel (3) 启动卫星 (4) 运行 Pi，模型调用 remote 工具执行 bash/read_file/write_file (5) 验证日志输出正确 (6) 验证参数校验拦截非法调用 (7) 验证 token 验证拒绝未授权连接
- **验证**: 所有场景通过
- **依赖**: Task 5, Task 10
- **状态**: [ ]
- **审查**: [ ]

## 验证策略

- 单元测试: 工具 schema 校验、配置加载/校验、协议类型兼容性
- 集成测试: WebSocket 连接建立、token 验证、工具调用转发、连接生命周期
- 安全检查: 127.0.0.1 绑定验证、token 验证、参数校验拦截
- 类型检查: `tsgo --noEmit` 全程通过

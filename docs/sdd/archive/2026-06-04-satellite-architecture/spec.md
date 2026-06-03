# Delta Spec: satellite-architecture

## Capability: satellite

### ADDED

#### Requirement: remote 工具
系统 SHALL 提供 `remote` 工具作为单一入口，允许模型自主决定何时将工具调用转发到远程卫星服务器执行。

##### Scenario: 执行远程 shell 命令
- **GIVEN** 卫星已连接，auth token 验证通过
- **WHEN** 模型调用 `remote({ tool: "bash", args: { command: "systemctl status nginx" } })`
- **THEN** 卫星执行命令，返回 `{ stdout, stderr, exit_code }`

##### Scenario: 读取远程文件
- **GIVEN** 卫星已连接
- **WHEN** 模型调用 `remote({ tool: "read_file", args: { path: "/etc/nginx/nginx.conf" } })`
- **THEN** 卫星读取文件内容并返回

##### Scenario: 写入远程文件
- **GIVEN** 卫星已连接
- **WHEN** 模型调用 `remote({ tool: "write_file", args: { path: "/tmp/test.txt", content: "hello" } })`
- **THEN** 卫星写入文件，返回成功

##### Scenario: 编辑远程文件
- **GIVEN** 卫星已连接，远程文件存在
- **WHEN** 模型调用 `remote({ tool: "edit_file", args: { path, old_string, new_string } })`
- **THEN** 卫星执行编辑，返回成功

##### Scenario: 列出远程目录
- **GIVEN** 卫星已连接
- **WHEN** 模型调用 `remote({ tool: "list_dir", args: { path: "/var/log" } })`
- **THEN** 卫星返回目录条目列表

##### Scenario: 参数校验失败
- **GIVEN** 卫星已连接
- **WHEN** 调用 `remote({ tool: "bash", args: {} })` 缺少 command
- **THEN** 本地校验失败，不转发到卫星

#### Requirement: 卫星程序
系统 SHALL 提供卫星程序作为服务器端 Bun 单二进制，暴露 read_file/write_file/edit_file/bash/list_dir 五个工具，绑定 127.0.0.1，必须验证 auth token。

##### Scenario: 卫星启动
- **GIVEN** 用户在服务器运行 `./satellite --port 9000 --token my-secret`
- **WHEN** 卫星启动
- **THEN** stdout 输出绑定地址和 token 验证配置

##### Scenario: 无 token 连接
- **GIVEN** 卫星已部署，配置了 auth_token
- **WHEN** 尝试建立 WebSocket 连接但未提供 token
- **THEN** 卫星拒绝连接，返回 HTTP 401

##### Scenario: 查看卫星日志
- **GIVEN** 卫星在前台运行
- **WHEN** 模型调用远程工具
- **THEN** stdout 输出：`[2025-05-27 10:00:00] bash command="ls -la" → ok 3ms`

#### Requirement: SSH Tunnel 管理
系统 SHALL 自动建立/重连/清理 SSH 隧道，连接生命周期对模型透明。

##### Scenario: 自动建立连接
- **GIVEN** 配置了卫星但未连接
- **WHEN** 模型首次调用 `remote` 工具
- **THEN** 系统自动建立 SSH tunnel + WebSocket 连接，然后执行工具调用

##### Scenario: WebSocket 断开
- **GIVEN** 连接中断
- **WHEN** 模型调用 `remote` 工具
- **THEN** 自动重连（指数退避 1s/2s/4s/8s，最大 30s），重连后重试

##### Scenario: 连续重连失败
- **GIVEN** 连接断开
- **WHEN** 连续 5 次重连失败
- **THEN** 停止重试，返回错误提示使用 `/connect`

##### Scenario: Pi 退出清理
- **GIVEN** 卫星已连接
- **WHEN** Pi 进程退出
- **THEN** 自动关闭 WebSocket 和 SSH tunnel

#### Requirement: 连接管理命令
系统 SHALL 提供 `/connect`、`/disconnect`、`/satellite` 命令管理连接生命周期。

##### Scenario: 使用 /connect 手动连接
- **GIVEN** 配置了卫星，当前未连接
- **WHEN** 用户执行 `/connect`
- **THEN** 系统建立连接，显示连接状态

##### Scenario: 使用 /disconnect 断开
- **GIVEN** 卫星已连接
- **WHEN** 用户执行 `/disconnect`
- **THEN** 系统关闭 WebSocket 和 SSH tunnel

#### Requirement: 卫星配置
系统 SHALL 在 `~/.pi/agent/settings.json` 的 `personalAssistant.satellite` 中存储卫星连接配置。

##### Scenario: 端口配置
- **GIVEN** settings.json 配置了 remote_port 和 local_port
- **WHEN** 系统建立 SSH tunnel
- **THEN** 使用配置的端口映射

##### Scenario: 端口冲突
- **GIVEN** 本地端口被占用
- **WHEN** 系统尝试建立 SSH tunnel
- **THEN** 返回端口占用错误

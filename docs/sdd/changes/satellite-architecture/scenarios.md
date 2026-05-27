# 使用场景

## 正常流程

### 场景: 执行远程 shell 命令
**GIVEN** 卫星已连接，auth token 验证通过
**WHEN** 模型调用 `remote({ tool: "bash", args: { command: "systemctl status nginx" } })`
**THEN** 卫星执行命令，返回 `{ stdout, stderr, exit_code }`

### 场景: 读取远程文件
**GIVEN** 卫星已连接
**WHEN** 模型调用 `remote({ tool: "read_file", args: { path: "/etc/nginx/nginx.conf" } })`
**THEN** 卫星读取文件内容并返回

### 场景: 写入远程文件
**GIVEN** 卫星已连接
**WHEN** 模型调用 `remote({ tool: "write_file", args: { path: "/tmp/test.txt", content: "hello" } })`
**THEN** 卫星写入文件，返回成功

### 场景: 编辑远程文件
**GIVEN** 卫星已连接，远程文件存在
**WHEN** 模型调用 `remote({ tool: "edit_file", args: { path, old_string, new_string } })`
**THEN** 卫星执行编辑，返回成功

### 场景: 列出远程目录
**GIVEN** 卫星已连接
**WHEN** 模型调用 `remote({ tool: "list_dir", args: { path: "/var/log" } })`
**THEN** 卫星返回目录条目列表

### 场景: 自动建立连接
**GIVEN** 配置了卫星但未连接
**WHEN** 模型首次调用 `remote` 工具
**THEN** 系统自动建立 SSH tunnel + WebSocket 连接，然后执行工具调用

### 场景: 使用 /connect 手动连接
**GIVEN** 配置了卫星，当前未连接
**WHEN** 用户执行 `/connect`
**THEN** 系统建立连接，显示连接状态

### 场景: 使用 /disconnect 断开
**GIVEN** 卫星已连接
**WHEN** 用户执行 `/disconnect`
**THEN** 系统关闭 WebSocket 和 SSH tunnel

### 场景: 远程 bash 维护 CWD 状态
**GIVEN** 卫星已连接
**WHEN** 模型依次调用 `remote({ tool: "bash", args: { command: "cd /app" } })` 然后 `remote({ tool: "bash", args: { command: "ls" } })`
**THEN** 第二次 ls 在 /app 目录下执行

### 场景: 查看卫星日志
**GIVEN** 卫星在前台运行
**WHEN** 模型调用远程工具
**THEN** stdout 输出：`[2025-05-27 10:00:00] bash command="ls -la" → ok 3ms`

## 异常流程

### 场景: 卫星未部署
**GIVEN** 配置了卫星但服务器上未部署二进制
**WHEN** 模型调用 `remote` 工具
**THEN** 系统返回 SSH 连接错误

### 场景: 无 token 连接
**GIVEN** 卫星已部署，配置了 auth_token，但连接时未提供 token
**WHEN** 尝试建立 WebSocket 连接
**THEN** 卫星拒绝连接，返回 HTTP 401

### 场景: SSH 连接失败
**GIVEN** 配置了卫星但 SSH 连接失败（网络不通、密钥错误）
**WHEN** 模型调用 `remote` 工具
**THEN** 系统返回 SSH 连接错误信息

### 场景: WebSocket 断开
**GIVEN** 连接中断
**WHEN** 模型调用 `remote` 工具
**THEN** 自动重连（指数退避 1s/2s/4s/8s，最大 30s），重连后重试

### 场景: 连续重连失败
**GIVEN** 连接断开
**WHEN** 连续 5 次重连失败
**THEN** 停止重试，返回错误提示使用 `/connect`

### 场景: 参数校验失败
**GIVEN** 卫星已连接
**WHEN** 调用 `remote({ tool: "bash", args: {} })` 缺少 command
**THEN** 本地校验失败，不转发到卫星

### 场景: 卫星端执行失败
**GIVEN** 卫星已连接
**WHEN** 调用 `remote({ tool: "read_file", args: { path: "/nonexistent" } })`
**THEN** 卫星返回错误，本地透传给模型

### 场景: 端口冲突
**GIVEN** 本地端口被占用
**WHEN** 系统尝试建立 SSH tunnel
**THEN** 返回端口占用错误

## 边界条件

### 场景: 大文件读取
**GIVEN** 卫星已连接
**WHEN** 读取超过 10MB 的远程文件
**THEN** 返回截断内容 + 提示

### 场景: 长时间命令
**GIVEN** 卫星已连接
**WHEN** bash 命令超过 120 秒
**THEN** 返回超时错误

### 场景: Pi 退出清理
**GIVEN** 卫星已连接
**WHEN** Pi 进程退出
**THEN** 自动关闭 WebSocket 和 SSH tunnel

### 场景: 空闲超时
**GIVEN** 卫星已连接
**WHEN** 超过 30 分钟无调用
**THEN** 自动断开连接

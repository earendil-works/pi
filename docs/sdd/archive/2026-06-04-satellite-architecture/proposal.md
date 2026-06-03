# 变更提案: satellite-architecture

## 动机

当前 Agent 操控远程服务器的方式（SSH command、SSH MCP server）缺乏原生体验。每次操作都需要 SSH 握手，无法维持连接状态（CWD、环境变量），且工具输出需要解析 stdout/stderr 文本。

需要一种卫星架构：在远程服务器部署轻量级卫星程序，本地 Agent 通过 WebSocket over SSH tunnel 转发工具调用，实现与本地工具一致的调用体验。

## 影响范围

- 新增 Capability:
  - `remote` 工具 — 单一入口，模型自主决定何时转发工具调用到远程服务器
  - 卫星程序 — 服务器端 Bun 单二进制，暴露 read_file/write_file/edit_file/bash/list_dir
  - SSH tunnel 管理 — 自动建立/重连/清理 SSH 隧道
  - `/connect`、`/disconnect`、`/satellite` 命令
  - `satellite` 配置节

- 修改 Capability:
  - PersonalAssistantConfig — 新增 `satellite` 字段

## 非目标

- 不支持多服务器同时连接（当前仅单服务器）
- 不支持卫星端自定义工具扩展（仅内置 5 个工具）
- 不自动部署卫星二进制（用户手动编译部署）
- 不支持卫星端 agent 能力（无模型调用）

## 验收标准

- `remote({ tool: "bash", args: { command: "ls" } })` 执行远程命令并返回结果
- `remote` 工具在转发前使用与本地工具相同的 schema 校验
- 卫星绑定 127.0.0.1 且必须验证 auth token
- SSH tunnel 自动建立、自动重连、Pi 退出时清理
- `/connect`、`/disconnect`、`/satellite` 命令正常工作
- 端口可配置（本地端口、远程端口独立配置）
- 卫星程序零依赖部署（Bun 单二进制，~5MB）
- 卫星日志输出到 stdout（工具名、参数、结果、耗时）
- 用户手动编译部署卫星

# 使用场景

## 正常流程

### Scenario: Local bash 跑 `ls`,不被拦截
- **GIVEN** 用户的 coding-agent 启动时 active 工具集 = `[read, bash, edit, write]`(`agent-session.ts` 默认)
- **WHEN** Model 调 `bash` 工具,`command` 为 `ls /home/qjh/Documents/Noah/MGM/`
- **THEN** `tool_call` hook 不返回 `block`,model 收到 `ls` 输出继续工作

### Scenario: Local bash 跑 `cat`,引导到 `read` 仍然不适用
- **GIVEN** Local bash hook 整段删除
- **WHEN** Model 调 `bash` 工具,`command` 为 `cat /etc/hostname`
- **THEN** Hook 不返回 `block`,model 收到 `cat` 输出;但这不是设计目标——只是说 guardrail 不再强制建议;model 自己选 `read` 仍是更优选择(不消耗在 suggestion 上)

### Scenario: Satellite bash 跑 `cat`,引导到 `read`
- **GIVEN** Satellite guardrail 保留 `read/edit/write` 三个 intent
- **WHEN** Model 调 `satellite_remote_exec`,`tool: "bash"`,`command: "cat /etc/hostname"`
- **THEN** 返回 `{block: true, reason: "Prefer read over bash cat. Use { tool:\"read\", path:'/etc/hostname' } for offset/limit/truncation."}`

### Scenario: Satellite bash 跑 `ls`,不再拦截
- **GIVEN** Satellite 的 `list` sub-tool 已删除
- **WHEN** Model 调 `satellite_remote_exec`,`tool: "bash"`,`command: "ls -la /tmp"`
- **THEN** Hook 不返回 `block`(因为 `ls` 已不在 detect 范围),model 收到 `ls` 输出

### Scenario: Satellite 调 `tool: "list"` 报错
- **GIVEN** Schema enum 已移除 `"list"`
- **WHEN** Model 调 `satellite_remote_exec`,`tool: "list"`,`path: "/tmp"`
- **THEN** Server 端 zod 校验返回 `Invalid tool name` 错误(SCHEMA 拒绝)

### Scenario: 3rd cat 仍硬拦截
- **GIVEN** Satellite bash `cat` budget 仍每 turn 计数
- **WHEN** 同 turn 内第 3 次调 `cat`
- **THEN** 返回 `Blocked: you have tried bash with similar intent 3 times. Use tool=read instead.`

## 异常流程

### Scenario: Local bash 跑 grep 100 次仍不拦截
- **GIVEN** Local guardrail 已删除
- **WHEN** Model 调 `bash` 工具,`command: "grep foo /tmp"`,共 100 次
- **THEN** 100 次均不返回 `block`,model 自由执行

### Scenario: 旧 session 引用 `tool: "list"` 报 schema error
- **GIVEN** 用户已升级到新版本但旧 session jsonl 中有 `{ tool: "list", path: "..." }` 工具调用
- **WHEN** Replay session 时 model 重新发出 `tool: "list"` 调用
- **THEN** `validateSchemaShape` 返回 `SCHEMA ERROR`,model 看到错误并改用 `bash ls`

### Scenario: 缺 `fd`/`rg` 二进制的 satellite server 不再校验
- **GIVEN** `handleFindFiles`/`handleGrepFiles` 已删除
- **WHEN** 远程 HPC 没有装 `fd`/`rg`
- **THEN** Server 不再因为 `fd not found` / `rg not found` 报错(已无调用方)

## 边界条件

### Scenario: 同一 turn local bash `ls` 1000 次
- **GIVEN** Local hook 已删除
- **WHEN** Model 调 `bash ls` 1000 次
- **THEN** 1000 次均不返回 `block`;但 `OutputAccumulator` 仍截断 50KB / 2000 行,防止 context 爆炸

### Scenario: 卫星调 `tool: "bash"` + `command: "ls -la"` 不再被 intercept
- **GIVEN** Satellite hook 的 bash intent budget 只剩 `read/edit/write` 三个 key
- **WHEN** Model 调 `satellite_remote_exec`,`tool: "bash"`,`command: "ls"`
- **THEN** `checkBashIntentCommon` 返回 undefined;budget map 不再增加 `ls` 计数 key

### Scenario: `BashIntent` 类型不能引用 `list`/`find`/`grep`
- **GIVEN** TypeScript strict mode
- **WHEN** 写新代码引用 `BashIntent` 联合类型
- **THEN** 编译期报错如果用了 `"list"` 等已删除的 intent;运行期 `detectBashIntent` 也不会返回这些字面量

### Scenario: 反向兼容 — 旧 release 仍能调 `list`
- **GIVEN** 用户的 satellite server 是旧版(未升级)
- **WHEN** Client 端调 `tool: "list"` 给旧 server
- **THEN** 旧 server 仍正常处理(本次改动不影响旧 server);**只有升级 client + server 时,旧 schema 才被拒绝**——这是预期破坏性变更,在 CHANGELOG 注明

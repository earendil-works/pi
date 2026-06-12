# 变更提案: 精简 bash guardrail — 删除 local gate + 删除 satellite list/find/grep

## 动机

**核心矛盾**:bash guardrail 把 model 从 `bash ls` 引导到 sub-tool,但引导目标在 local 端不存在 / 在 satellite 端跟 bash 等价。

### 三个具体痛点

1. **Local guardrail 卡死 agent**:本地默认 active 工具集是 `[read, bash, edit, write]`(`agent-session.ts:173`),`ls/grep/find` **不在** 默认 active 里。System prompt 明确说「Use bash for file operations like ls, rg, find」(`system-prompt.ts:114`),但 guardrail 反向拦截 `bash ls` 并建议 `tool="list"`(实际本地不存在 `list` 工具)→ model 三次后硬拦截 → 卡死

2. **Satellite guardrail 引导无价值**:`list/find/grep` sub-tool 实质是 `bash(ls/find/grep)` 的薄包装:
   - `list` = 调 `fs.readdir` + 排序,等价 `bash ls`
   - `find` = 调 `fd` 子进程,等价 `bash(find ...)`  
   - `grep` = 调 `rg` 子进程,等价 `bash(grep ...)`
   - `utils.ts:143` 注释明示这组工具的截断/格式化是「mirroring local pi」,而非卫星特有
   - 唯一差异是输出格式,而 `bash` + `OutputAccumulator` 已经处理截断

3. **维护负担**:6 个 intent × 2 个 prefix(local/satellite)= 12 个计数 key + 6 段 guidance 文案 + 3 套测试 fixture。删掉无价值的一半,budget Map / guidance 分支 / 测试都减半

### 保留的部分

`read/write/edit` sub-tool 的 guardrail **保留**,因为它们有真实价值:
- `read` 提供 offset/limit/truncation,避免 model 调 `cat` 一段 50KB 文件烧光 context
- `write` 提供原子写(没有「写入一半被中断」风险)
- `edit` 提供 fuzzy match,等价 `bash(sed -i)` 不可靠
- 这三个 sub-tool 的输出被 `compaction/utils.ts:61` 当作 file tracking 信号

## 影响范围

- 新增 Capability: 无
- 修改 Capability: `personal-assistant/satellite-bash-guardrail`(窄化意图集合)
- 删除 Capability:
  - `personal-assistant/local-bash-guardrail`(local bash gate 整层)
  - `satellite/list-sub-tool`(MCP `tool:"list"` + `handleListDir` + 测试 + 文档)
  - `satellite/find-sub-tool`(MCP `tool:"find"` + `handleFindFiles` + `runFd` + `checkFdAvailable` + fd 依赖)
  - `satellite/grep-sub-tool`(MCP `tool:"grep"` + `handleGrepFiles` + `runRg` + `checkRgAvailable` + rg 依赖)

## 非目标

- **不** 修改 `local pi` 工具集:`ls/grep/find` 工厂函数保留,仅不在本次改动中启用
- **不** 改变 satellite 的 `read/write/edit` 行为,也不动 `transfer_file`
- **不** 修改 file tracking(compaction/utils.ts 仍依赖 `read/write/edit` 的 sub-tool 调用)
- **不** 修改 `mcp.json` schema(`SATELLITE_GUARD_PATTERN` env var、path scope 校验保留)
- **不** 改 `local-bash-guards.test.ts` 的反向引用:`extensions/satellite/test/satellite-schema.test.ts` 不引用它
- **不** 释放新版本(version bump 不在本次范围)

## 验收标准

### Local bash gate 删除
- [ ] `extensions/personal-assistant/tools.ts` 的 `tool_call` hook 中 `if (event.toolName === "bash")` 分支被删除
- [ ] Local bash 调 `ls`/`find`/`grep`/`cat`/`sed -i`/`echo >` 任意次均不被拦截
- [ ] Sentinel 测试:同一 turn 内 `bash ls` 调 100 次仍返回 undefined

### Satellite sub-tool 删除
- [ ] `extensions/satellite/schema.ts` 的 `tool` enum 不含 `list`/`find`/`grep`
- [ ] `extensions/satellite/satellite-server.ts` 中:
  - `handleListDir` 函数删除
  - `handleFindFiles` 函数删除
  - `handleGrepFiles` 函数删除
  - 连带 `runFd`/`runRg`/`truncateLine`/`GREP_MAX_LINE_LENGTH`/`MAX_LS_ENTRIES`/`checkFdAvailable`/`checkRgAvailable` 删除
  - `TOOL_HANDLERS` 只剩 `read`/`write`/`edit`/`bash`/`transfer_file` 5 个 key
  - `createMcpServer` 的 description 字符串不含 `list`/`find`/`grep` 字面量
- [ ] `extensions/satellite/README.md` 工具表删除 `list_dir`/`find_files`/`grep_files` 三行
- [ ] `extensions/satellite/README.md` Requirements 章节删除 `fd`/`rg` 依赖说明
- [ ] server 在缺少 `fd`/`rg` 二进制时不再检查可用性(已无调用方)

### Guardrail 窄化
- [ ] `extensions/personal-assistant/tools.ts` 中 `BashIntent` 类型从 `"read" | "edit" | "write" | "list" | "find" | "grep"` 窄化为 `"read" | "edit" | "write"`
- [ ] `detectBashIntent` 移除 `ls/ll/dir`/`find`/`grep` 三条 regex
- [ ] `getBashGuidance` 只剩 `read`/`edit`/`write` 三个 case
- [ ] `checkBashIntentCommon` 函数的 `prefix: "local" | "satellite"` 参数删除(只保留 `satellite` 一档)
- [ ] `validateSchemaShape` 的允许工具列表更新为 `bash, read, write, edit, transfer_file`

### 测试
- [ ] `extensions/personal-assistant/test/local-bash-guards.test.ts` 整文件删除
- [ ] `extensions/personal-assistant/test/satellite-guards.test.ts`:
  - 删除 "bash ls → suggests list" / "bash find → suggests find" / "bash grep → suggests grep" 三个 case
  - 保留 "bash cat → suggests read" / "bash sed -i → suggests edit" / "bash echo > → suggests write" / "3rd violation" / "legit bash" / "find as path component" / "grep as path component" / "find after &&" 八个 case
  - 新增 sentinel:"bash ls/find/grep → no block"(任意次均不拦截)
- [ ] `extensions/satellite/test/satellite-schema.test.ts`:
  - 移除 `list`/`find`/`grep` 在 enum / description / TOOL_HANDLERS 的所有 assertion
  - 新增 negative test:"enum does NOT include list/find/grep"
- [ ] `npm run check` 全 pass(无 lint / type / shrinkwrap 错误)

### 反向兼容性
- [ ] 现有 `pi update` 流程不受影响(本次不 release)
- [ ] 用户已部署的 satellite server 不需要立即升级,但下次启动会拒绝 `tool:"list"` 等旧调用
- [ ] 文档/CHANGELOG 同步:`extensions/satellite/CHANGELOG.md` 写「Removed list/find/grep sub-tools — use bash instead」

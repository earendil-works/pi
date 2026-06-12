# Design: trim-bash-guardrail

## Context

Personal-assistant 扩展 + satellite MCP 工具集有一组 bash intent guardrail:在 `tool_call` hook 里检测 `bash` 工具的 `command` 字段,如果匹配 `cat`/`ls`/`find`/`grep`/`sed -i`/`echo >` 模式,就返回 guidance error 引导 model 改用对应的 sub-tool。每 turn 计数,前 2 次 guidance,第 3 次硬拦截。

代码同时被两个 hook 调用:
1. **Local bash hook** (`extensions/personal-assistant/tools.ts:945-950`):拦截 `event.toolName === "bash"` 的本地调用
2. **Satellite hook** (`extensions/personal-assistant/tools.ts:409-411`):拦截 `event.toolName === "satellite_remote_exec"` 且 `input.tool === "bash"` 的远程调用

### 当前痛点

**Local 端无意义**:
- local pi 默认 active 工具集是 `[read, bash, edit, write]`(`agent-session.ts:173`),`ls/grep/find` **不在** 默认集合
- system prompt 默认建议「Use bash for file operations like ls, rg, find」(`system-prompt.ts:114`)
- guardrail 反向拦截 `bash ls` 并建议 `tool="list"`,但 local pi **没有 `list` 工具**——实际工具叫 `ls`(`tools/ls.ts:101`),且未启用
- 结果:model 被引导到不存在 / 未启用的工具,3 次后硬拦截,**agent 卡死**

**Satellite 端 `list/find/grep` 无价值**:
- `list` sub-tool 实质是 `fs.readdir` + 排序,等价 `bash ls`
- `find` sub-tool 调 `fd` 子进程,等价 `bash(find ...)`
- `grep` sub-tool 调 `rg` 子进程,等价 `bash(grep ...)`
- `utils.ts:143` 注释明示这些工具的截断/格式化是「mirroring local pi」,非卫星特有
- 唯一差异是输出格式,但 `bash` + `OutputAccumulator` 已处理截断

**`read/write/edit` 仍有价值**:
- `read` 提供 offset/limit/truncation,避免 model 调 `cat` 一段 50KB 文件烧光 context
- `write` 提供原子写
- `edit` 提供 fuzzy match,等价 `bash(sed -i)` 不可靠
- 这三个 sub-tool 的输出被 `compaction/utils.ts:61` 当作 file tracking 信号

## Goals / Non-Goals

**Goals**:
- 删除 local bash hook 的整段 guardrail 逻辑
- 删除 satellite 的 `list`/`find`/`grep` 三个 sub-tool(handlers / schema / 文档 / 测试)
- 保留 satellite 的 `read`/`write`/`edit` sub-tool 和对应的 `cat`/`sed -i`/`echo >` guardrail
- 维护本地工具集 `createAllTools` / `createReadOnlyTools` 不动(`ls/grep/find` 工厂函数仍可用,`--tools read,grep,find,ls` opt-in 模式不受影响)
- 所有测试 / 文档 / CHANGELOG 同步更新

**Non-Goals**:
- 不重新设计 satellite 的 path scope 校验
- 不动 `transfer_file` sub-tool 和它的 hook
- 不动 file tracking(只删 `list/find/grep` sub-tool 的 handler,`read/write/edit` 的 tracking 保留)
- 不 bump 版本号 / 不 release
- 不引入新机制(如「未启用工具的 placeholder」)——直接删,model 用 bash

## Decisions

### 1. 删除整个 local bash guardrail 分支,而不是把它改成「fall through」

**Decision**: 在 `tool_call` hook 中,删除 `if (event.toolName === "bash")` 整段 if 块,包括对 `checkBashIntentCommon` 的调用。

**Rationale**:
- Fall-through 需要在每次 bash 调用时做 active 工具集检查,增加复杂度
- 既然 local 端没有可推荐的 sub-tool,任何本地 bash 调用都不该被 guardrail 触碰
- 完全删除是最简洁的实现,符合 "no dead code" 原则

**Alternatives considered**:
- (a) 改成「只在 active 工具包含 `ls/grep/find` 时才拦截」:增加运行时检查,bash 是默认 active 工具之一,这逻辑复杂且容易出错
- (b) 改成「在拦截前检查 sub-tool 是否在 active」:同上,且需要从 hook 拿 active 工具集
- (c) **采用**:完全删除

### 2. Satellite `list/find/grep` sub-tool 整个删,不留 deprecated 状态

**Decision**: 从 schema / server handler / TOOL_HANDLERS / description / README / 测试 全部移除,不保留 `if (tool === "list") throw new Error("removed")` 的 placeholder。

**Rationale**:
- 这些 sub-tool 没有外部调用方(只有 personal-assistant client 和自家测试)
- placeholder 增加维护负担,且会让 server 错误信息更乱
- 「YAGNI + surgical change」:删干净

**Alternatives considered**:
- (a) 保留 schema,handler 抛 deprecated 警告:无意义,client 端已被 gate
- (b) 保留 schema 但标记 `deprecated: true`:MCP schema 不支持该字段
- (c) **采用**:全删

### 3. `checkBashIntentCommon` 保留,但 `prefix: "local" | "satellite"` 参数删除

**Decision**: 函数仍在,但只接受 `prefix: "satellite"`(写死常量),不再有 `prefix: "local"` 分支。

**Rationale**:
- 卫星端仍需要这个函数的 budget 计数逻辑(`cat/sed-i/echo>` 仍要 3 次拦截)
- 删除 `local` 分支后,prefix 参数可以简化为常量
- 内部 `bashIntentBudget` map 仍要保留(`clearBashIntentBudget` 还要导出给测试)

**Alternatives considered**:
- (a) 把 `checkBashIntentCommon` 内联到 `validateSatelliteCall`:失去独立可测性,测试要重构
- (b) **采用**:保留函数,只删除 `prefix` 参数

### 4. `BashIntent` 类型从 6 个 union 缩到 3 个

**Decision**: `type BashIntent = "read" | "edit" | "write"`,删除 `"list" | "find" | "grep"`。

**Rationale**:
- 编译期保证 `detectBashIntent` 不会返回已删除的 intent
- 减少 `getBashGuidance` switch 的 case
- 测试时如果引用 `"list"` 字面量,会编译错误,起到 sentinel 作用

### 5. local-bash-guards.test.ts 整文件删除

**Decision**: 删除整个 `extensions/personal-assistant/test/local-bash-guards.test.ts`,不保留为「测试用 stub」。

**Rationale**:
- 没有 local guardrail 就没有 local guardrail 测试
- 文件唯一的导出引用是 `checkBashIntentCommon`,在精简后该函数只剩 `satellite` 分支,local 测试用例无意义

### 6. 测试不引入 mock harness 替代真实 pi 上下文

**Decision**: 测试仍用 vitest + 直接 import `validateSatelliteCall`,不引入 pi mockup。

**Rationale**:
- AGENTS.md 规定用 harness, 但本测试不依赖 pi runtime——只测纯函数 `checkBashIntentCommon` + `validateSatelliteCall`
- 现有测试就是这种纯函数测试,不需改

## Architecture

### 数据流

```
Model tool call
    ↓
pi agent runtime 触发 tool_call event
    ↓
personal-assistant tool_call hook
    ├─ toolName === "bash"             ← 本次删除该分支
    │   └─ checkBashIntentCommon("local") ← 删除
    │
    └─ toolName === "satellite_remote_exec"
        ├─ validateSchemaShape
        │   └─ 检查 tool ∈ {bash, read, write, edit, transfer_file}
        │       (本次从 8 个值缩到 5 个)
        ├─ validatePathScope
        └─ checkBashIntent (内部调 checkBashIntentCommon "satellite")
            └─ 仍拦截 cat/sed-i/echo>,不拦截 ls/find/grep
    ↓
返回 {block, reason} 或 undefined
    ↓
Agent runtime 决定是否执行
```

### 关键改动文件

| 文件 | 改动 |
|------|------|
| `extensions/satellite/schema.ts` | enum 从 8 个值 → 5 个值 |
| `extensions/satellite/satellite-server.ts` | 删 `handleListDir` / `handleFindFiles` / `handleGrepFiles` / 辅助函数 / 常量 / TOOL_HANDLERS 3 个 key / description 中的 3 行示例 |
| `extensions/satellite/test/satellite-schema.test.ts` | 删 3 个值的所有 assertion + 加 negative test |
| `extensions/satellite/README.md` | 删 3 行工具表 + Requirements 章节 |
| `extensions/personal-assistant/tools.ts` | 缩 `BashIntent` / 删 3 条 regex / 缩 `getBashGuidance` / 删 local hook 分支 / 改 `checkBashIntentCommon` 签名 / 改 `validateSchemaShape` 允许值列表 |
| `extensions/personal-assistant/test/local-bash-guards.test.ts` | 整文件删除 |
| `extensions/personal-assistant/test/satellite-guards.test.ts` | 删 3 个 case + 加 sentinel |
| `extensions/satellite/CHANGELOG.md` | `## [Unreleased]` → `### Removed` 段 |

### `checkBashIntentCommon` 新签名

```typescript
// Before
export function checkBashIntentCommon(
    command: string,
    turnId: string,
    prefix: "local" | "satellite",
): string | undefined

// After
export function checkBashIntentCommon(
    command: string,
    turnId: string,
): string | undefined
```

内部 `key = ${turnId}:satellite:${intent}` —— prefix 写死为 `"satellite"`,因为函数唯一调用方在卫星 hook。

### `BashIntent` 缩窄

```typescript
// Before
type BashIntent = "read" | "edit" | "write" | "list" | "find" | "grep";

// After
type BashIntent = "read" | "edit" | "write";
```

### `validateSchemaShape` 允许值更新

```typescript
// Before
"  bash, read, write, edit, list, find, grep, transfer_file"

// After
"  bash, read, write, edit, transfer_file"
```

### `REMOTE_EXEC_INPUT_SCHEMA` enum 更新

```typescript
// Before
tool: z.enum(["bash", "read", "write", "edit", "list", "find", "grep", "transfer_file"])

// After
tool: z.enum(["bash", "read", "write", "edit", "transfer_file"])
```

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Satellite server 拒绝旧 client 的 `tool:"list"` 调用(破坏性变更) | CHANGELOG 写明「client + server 须同步升级」;旧 session jsonl 里有 `list` 调用 replay 会失败,这是预期 |
| 删除 local guardrail 后,model 频繁调 `bash cat` 烧光 context | 仍是 guidance 而非强制;model 自己会选 `read`(因为 sub-tool 输出已格式化);且 `OutputAccumulator` 截断 50KB / 2000 行 |
| `fd`/`rg` 依赖声明从 README 删除后,用户不知需要装 | 这两个二进制现在没人在用,删除是「无依赖胜于有依赖」;CHANGELOG 会提及 |
| 测试删除后,`checkBashIntentCommon` 的 `cat/sed-i/echo>` 分支无对应 test | 保留这 3 个 satellite case(`bash cat → suggests read` 等),覆盖核心功能 |
| `BashIntent` 缩窄后,如果将来要加回 sub-tool,需要重新定义 | 简单 — 只需加 union 成员 + regex + guidance case;YAGNI,不预先抽象 |
| 旧 release tag 还在 npm 上,用户 `pi update` 拿到旧版没有这层修复 | 本次不 release,等用户主动决定;CHANGELOG 在 unreleased 段写明 |

## Testing Strategy

### 单元测试

**`extensions/personal-assistant/test/satellite-guards.test.ts`**(精简后):
- 保留 8 个 case:`bash cat → suggests read` / `bash sed -i → suggests edit` / `bash echo > → suggests write` / `3rd violation` / `legit bash` / `find as path component` / `grep as path component` / `find after &&`
- 删 3 个 case:`bash ls → suggests list` / `bash find → suggests find` / `bash grep → suggests grep`
- 新增 sentinel: **`bash ls/find/grep → no block`**——验证新行为,同 turn 100 次仍返回 undefined
- 新增 sentinel: **`BashIntent type guards`**——`detectBashIntent("ls /tmp")` 返回 `null`(TypeScript 编译期保证不会返回 `"list"`)

**`extensions/satellite/test/satellite-schema.test.ts`**(精简后):
- 删 enum 包含 `list`/`find`/`grep` 的 3 处 assertion
- 删 description 引用 `list`/`find`/`grep` 的 assertion
- 删 TOOL_HANDLERS block 包含 `list:`/`find:`/`grep:` 的 assertion
- **新增 negative test**:`expect(enumValues).not.toContain("list")` 等 3 个

### 集成测试

无需新增——本次改动是纯客户端/纯服务端删除,没有跨包交互变更。

### 边界条件覆盖

- Schema rejection:调 `tool:"list"` 给 server 收到 zod 错误——通过 `satellite-schema.test.ts` 验证 enum 收缩
- Hook 不触发:同 turn `bash ls` 100 次——通过 `satellite-guards.test.ts` 新 sentinel 验证
- Type guard:引用 `"list"` 字面量编译失败——通过 `npm run check` 验证

## Implementation Notes

### 改动顺序(sdd-develop 阶段)

1. **Schema + 文档先行** — 改 `schema.ts` 和 `README.md`,这是「最不破坏性」的改动,因为 server 还没改完
2. **Server handlers** — 删 `satellite-server.ts` 三个 handler + 辅助函数 + TOOL_HANDLERS 三个 entry
3. **Description 字符串** — 改 `createMcpServer` 的 description,移除 list/find/grep 示例
4. **Client guardrail** — 改 `personal-assistant/tools.ts` 的 `BashIntent` / `detectBashIntent` / `getBashGuidance` / `checkBashIntentCommon` / `validateSchemaShape`
5. **Local hook 删分支** — 删 `tool_call` hook 中的 `if (event.toolName === "bash")` 整段
6. **Tests** — 删 `local-bash-guards.test.ts`;改 `satellite-guards.test.ts` 和 `satellite-schema.test.ts`
7. **CHANGELOG** — 写 `### Removed` 段
8. **Run `npm run check`** — 验证所有改动无 lint / type 错误

### 依赖关系

- Schema 改动 → Server handler 改动 → Test 改动 (顺序)
- Client guardrail 改动不依赖 server 改动
- Test 改动是最后一步,确保其他改动完成后测试有意义的失败信号

### Gotchas

- `satellite-server.ts` 里的 description 字符串是多行模板字符串,改时注意转义和 `List`/`Search` 标签的对齐
- `bashIntentBudget` Map 的 key 格式是 `${turnId}:${prefix}:${intent}`,改 `prefix` 后,旧 turn 的 budget 残留会被新 key 跳过——这是 fine,因为 `clearBashIntentBudget` 仍按 `turnId:` 前缀清
- `readdir` import 在删 `handleListDir` 后是否还被用?需要 grep 确认(可能 `handleReadFile` 也用)
- `MAX_LS_ENTRIES` / `GREP_MAX_LINE_LENGTH` 等常量删之前 grep 一次确保无其他使用
- `checkFdAvailable` / `checkRgAvailable` 函数如果只在 `handleFindFiles` / `handleGrepFiles` 里调,可以直接删;否则保留(但如果只服务于已删 handler,必删)

<!-- archived-with: 2026-06-12-trim-bash-guardrail | status: final -->

# Design: agent-driven-memory-save

## Context

memory 子系统当前写路径是单点:`session_before_compact` → LLM 抽取 (`extraction.ts:executePlan`) → `writeAtomToFile` → `MemoryIndex.insertAtom` → `embedText` → `upsertVector`。这条路径在 `memory.ts:336` 注册为 hook,失败会 cancel compact (hard-gate)。

**痛点**:

1. **agent 写入路径缺失** — agent 想立刻"记住用户偏好 X"必须等下一次 compact,且 agent 完全无法控制粒度、类型、importance。LLM 抽取是事后批处理,常常会漏掉跨多轮才显现的认知。
2. **agent 可绕过 schema** — agent 持有通用 `write`/`edit`/`bash`,理论上可写任意路径。`~/.pi/agent/memory/atoms/**` 当前没有任何写入保护,绕过后产出的 .md 文件缺 frontmatter、缺 index 行、缺 vector,在 recall / list / get 路径上不可见(成为"幽灵 atom")。`freshenContentFromDisk` (`packages/webui/server/routes/memory.ts:199`) 仅刷新 content,不补 vector。
3. **hard-gate compact** — 抽取失败 cancel compact (memory.ts:336-353),对长 session 来说抽取失败率随消息数上升,用户体验差。

**为什么需要变更**: 把 memory write 从"系统定时批处理"变成"agent 显式调用",提高质量上限(schema 严格、可观测、可审计);同时用路径 hook 杜绝幽灵 atom;把 hard-gate 改成只在 agent 完全缺席时跑的 safety net。

## Goals / Non-Goals

### Goals

- agent 可通过单一 `memory_save` tool 显式写 atom,不依赖 compact
- 两阶段 cosine dedup: 先查最相似,相似时返 conflict 给 agent 决策;agent 接受冲突或换 id 时才落写
- overwrite (id 复用) 幂等,旧 atom 的 file/row/vector 全清
- `tool_call` hook 硬阻断 `write`/`edit`/`bash` 写 `~/.pi/agent/memory/atoms/**` (读不受限)
- `session_before_compact` 退化为 safety net: 仅在 agent 整段 0 次 save 时跑
- safety net 失败 graceful skip,不再 cancel compact
- 嵌入失败 graceful,atom 仍入库但无向量
- webui PATCH /api/memory/:id 路径行为不变 (回归)

### Non-Goals

- 不引入 `memory_update` / `memory_archive` tool
- 不改 HTTP API 形态、DB schema、前端 UI
- 不改 extraction LLM 抽取 prompt 与 `executePlan` 核心逻辑
- 不改 recall / gate / rerank / hybrid-search 任何读路径
- 不解决 inbox 堆积问题 (后续独立 change)
- 不在 agent 写路径上加 user 二次确认 UI

## Decisions

### 1. 单一 tool 而非多 tool

**Decision**: 只暴露 `memory_save` 一个 tool,内部根据是否带 `id` 区分 create / overwrite / supersede 三种 mode。

**Rationale**: 用户明确选择 save-only — 更新通过 overwrite 复用 id 完成,归档由 webui / supersede 链 / auto-decay 负责。少 tool = agent prompt 短、误用率低。`supersedeIfSimilar` 拆分后,create 路径天然得到 supersede 模式 (conflict → agent 接受 → markSupersededTx)。

**Alternatives considered**:
- 三 tool (`memory_save` / `memory_update` / `memory_archive`): 已被用户否决
- 单 tool + action 枚举 (`memory_write({action:...})`): action 字符串弱类型,出错信息模糊

### 2. 两阶段 cosine dedup (查后写)

**Decision**: `memory_save` 不带 id 时,先把内容 embed,然后 `findMostSimilarEmbedding(0.65)`。命中 → 返回 `{conflict:{id,score,title}}` 不写入。未命中 → 写入新 atom。

**Rationale**: 与 `extraction.ts:executeItem` (lines 122-162) 行为一致 — 同一阈值 0.65、同一函数 `supersedeIfSimilar`。agent 看到 conflict 后可选择: (a) 用相同 id 重写,走 overwrite (旧 atom 直接删); (b) 不带 id 再调一次,接受 conflict 走 supersede (旧 atom 进 supersede 链,history 保留)。

**Alternatives considered**:
- 单阶段 (直接 supersede 旧 atom, 不让 agent 决定): 抹掉 agent 决策权,违反 "agent-driven" 核心
- 0.92 阈值 (与 webui PATCH 一致): 太松, 容易把语义相关的 atom 误标冲突
- 无 dedup: 重复 atom 污染 DB

### 3. overwrite 不保留版本链

**Decision**: `memory_save` 带 id 且 DB 存在 → 删旧 file/row/vector,新 atom 用相同 id 写入,version+1,无 parent_id / superseded_at 链。

**Rationale**: 用户明确语义"全部重写就行" — overwrite 是替换 (replace) 而非修订 (update),保留 history 没有用户意义。supersede 链仍然由 cosine 命中路径维护 (markSupersededTx 自动产生),只是 overwrite 路径不产生链。

**Alternatives considered**:
- overwrite 走 markSupersededTx: 会产生新旧两条 atom row,DB 体量上升,但符合 v2 数据模型 (append-only version chain)
- overwrite 仅 updateAtom (in-place): 简化实现,但失去 is_latest 0→1 的语义信号

### 4. tool_call hook 硬阻断 + writer 自洽

**Decision**: `tools.ts:934` 的 `tool_call` hook 加分支,检测 `write`/`edit` 的 `path` 字段,以及 `bash` 的 `command` 字段中匹配 `>` / `>>` / `tee ` + 解析后命中 `~/.pi/agent/memory/atoms/**` 的子路径,返回 `{block: true, reason: ...}`。**不阻断 `read` / `bash` 读操作**。

**Rationale**: writer (`writeAtomToFile`) 直接调 `fs.writeFile`,不经 tool_call,自然不被 hook。agent 调 `read` 看 atom 全文是合法用例 (recall 只给 summary),hook 不应阻断。bash 阻断只看显式写模式,不看读模式 (避免误伤 `cat ~/.pi/agent/memory/atoms/.../foo.md`)。

**Alternatives considered**:
- 软警告 (写入成功但标记 stale): 污染 DB,违背"数据质量优先"
- 仅挡 write/edit 不过滤 bash: agent 用 `bash` 一行就绕过,等于没挡

### 5. safety net 仅在 0 save 时触发

**Decision**: `session_before_compact` 进入前检查 segment 内 `memory_save` 调用计数;`>= 1` → 跳过抽取直接 return;`== 0` → 跑原有抽取流程。

**Rationale**: agent-driven 是主路径,auto-extract 是兜底。预期 agent save 率 ≥ 95%,safety net 触发 < 5%,既保留"agent 完全忘记存"的兜底又不重复做 agent 已经做过的抽取。

**Alternatives considered**:
- 始终跑抽取 + 与 agent save 去重: 烧 token,重复跑同一段对话
- session 级去重 (整个 session 仅第一次跑): 粒度粗,后期长 session 可能漏掉

### 6. safety net 失败 graceful

**Decision**: safety net 路径 catch 抽取失败 (无 model 配置 / auth 失败 / LLM 错误),`ctx.ui.notify` 提示,return `undefined`,compact 继续。

**Rationale**: 当前是 `cancel: true` (memory.ts:352),把工程问题转嫁给用户体验。改成 graceful skip 后,user 至少 compact 能进行,memory 短暂缺失下次 agent 主动 save 补回。

**Alternatives considered**:
- 保留 cancel 但加 retry: 增加复杂度,没解决根因
- fail loud (抛错给 user): 已通过 notify 实现,符合 graceful 原则

### 7. system prompt 增量

**Decision**: `tools.ts:828` 的 `before_agent_start` hook 注入一段 memory 操作规范,告知 agent `memory_save` 的存在、使用时机、conflict 处理方式。

**Rationale**: agent 不主动存是结构性遗忘风险的核心,prompt 提示是低成本缓解。规范包括: 重要事实/规则/流程主动存;save 前先看 conflict 提示;不存瞬时对话/工具输出/猜测性内容。

**Alternatives considered**:
- 不改 prompt,纯靠 tool 暴露: 遗忘率不可控,违背原则
- 强 prompt 强制每 turn 评估是否 save: cognitive overhead,稀释注意力

## Architecture

### 组件划分

```
extensions/personal-assistant/
├── memory-save.ts          [NEW]   tool 定义 + 三 mode 编排 + dedup 调用
├── dedup.ts                [MOD]   拆 findSimilarPhase + commitSupersedePhase
├── tools.ts                [MOD]   register memory_save + 路径 hook + system prompt
├── memory.ts               [MOD]   session_before_compact 改 safety net
├── file-store.ts           [REUSE] writeAtomToFile / isSafeFilename / computeContentHash
├── storage.ts              [REUSE] MemoryIndex.{insertAtom, updateAtom, deleteVector,
│                                    findMostSimilarEmbedding, markSupersededTx, getAtom}
├── embed.ts                [REUSE] embedText / buildEmbeddableText
├── tag-alias.ts            [REUSE] normalizeTags
├── extraction.ts           [REUSE] extractMemoriesWithCallLlm (safety net 内部调)
└── test/
    └── memory-save-tool.test.ts  [NEW]  6 case: new/conflict/overwrite/id-not-found/
                                              embedding-down/path-guard
```

### Tool 接口 (TypeBox schema)

```typescript
const MemorySaveParams = Type.Object({
  id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  type: Type.Union([
    Type.Literal("rule"),
    Type.Literal("fact"),
    Type.Literal("process"),
  ]),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  content: Type.String({ minLength: 1 }),
  tags: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
  importance: Type.Number({ minimum: 0, maximum: 1 }),
  source_session: Type.Optional(Type.String()),
});
```

返回值 (`details` 字段):

```typescript
type MemorySaveResult =
  | { ok: true; id: string; action: "created" | "overwritten" | "superseded"; superseded_id?: string; embedding: "ok" | "skipped" }
  | { ok: false; error: "id_not_found" | "invalid_type" | "content_required"; details?: unknown }
  | { conflict: { id: string; score: number; title: string } };
```

### 数据流 (mode: new, 无 id)

```
agent: memory_save({type, title, content, tags, importance})
  ↓
buildAtom(input)                         // memory-save.ts: 拼 MemoryAtom,生成 content_fingerprint
  ↓
embedText(content+summary+tags, 15s)    // embed.ts:64 — null on timeout/down
  ├─ null → skip dedup, 直接 insertAtom (graceful)
  └─ ok   → findMostSimilarEmbedding(embedding, 0.65)  // storage.ts:473
              ├─ hit  → return {conflict: {id, score, title}}
              └─ none → insertAtom + writeAtomToFile + upsertVector → return {ok, action:"created"}
```

### 数据流 (mode: overwrite, 带 id)

```
agent: memory_save({id, type, ...})
  ↓
MemoryIndex.getAtom(id)                  // storage.ts:278
  ├─ null → return {ok:false, error:"id_not_found"}
  └─ ok   → deleteVector(id)             // storage.ts:827
            + fs.unlink(<atoms dir>/<type>/<id>.md)
            + insertAtom(newAtom with same id)   // storage.ts:156, version = old.version + 1
            + writeAtomToFile(newAtom)
            + upsertVector if embedding ok
            → return {ok, action:"overwritten"}
```

### tool_call hook 分支

```typescript
// tools.ts:934
pi.on("tool_call", async (event) => {
  if (event.toolName === SATELLITE_TOOL_NAME) { /* ... existing ... */ }

  // NEW: Memory atom path guard
  if (event.toolName === "write" || event.toolName === "edit") {
    const path = resolveHome((event.input.path ?? event.input.file_path) as string);
    if (isUnderAtomsDir(path, atomsDir)) {
      return {
        block: true,
        reason: "memory atoms must be written via memory_save tool, not direct file write. " +
                "Use memory_save({type, title, content, ...}) instead.",
      };
    }
  }
  if (event.toolName === "bash") {
    const cmd = String(event.input.command ?? "");
    if (looksLikeWriteToAtomsDir(cmd, atomsDir)) {
      return { block: true, reason: "memory atoms must be written via memory_save tool, not bash heredoc/redirect" };
    }
  }

  return undefined;
});
```

`looksLikeWriteToAtomsDir` 检测: 命令字符串包含 `>` / `>>` / `tee` 之一,且 expand 后路径命中 `atoms/**`。简化实现: 不做完整 shell 解析,只做正则匹配 `>(>?)\s*["']?~?/?[^{}<>]*atoms/` 或 `tee\s+~?/?[^{}<>]*atoms/`。

### system prompt 增量

```typescript
// tools.ts:828, before_agent_start 内追加
const memorySection = [
  "",
  "## Memory",
  "",
  "You have a `memory_save` tool to durably record important facts, rules, and processes.",
  "Use it proactively when the user states a preference, defines a rule, or describes a workflow.",
  "",
  "Rules:",
  "  1. Save DURABLE knowledge only — preferences, rules, conventions, recurring processes. Do NOT save transient chat, tool outputs, or speculative guesses.",
  "  2. If `memory_save` returns `{conflict: {...}}`, an existing similar atom exists. Re-call `memory_save` with `id=<conflicted_id>` to overwrite, or omit `id` to accept the supersede.",
  "  3. Set `importance` honestly (0-1): 0=trivial, 0.5=default, 1=critical. Don't inflate.",
  "  4. Tags should be lowercase, hyphen-separated, 1-3 words each.",
].join("\n");
```

### session_before_compact safety net 改造

```typescript
// memory.ts:336
let segmentMemorySaveCount = 0;

pi.on("before_agent_start", () => {
  segmentMemorySaveCount = 0;  // reset per segment
});

// memory-save.ts tool 的 execute 末尾
segmentMemorySaveCount++;

pi.on("session_before_compact", async (event, ctx) => {
  // Safety net: skip if agent actively managed memory this segment
  if (segmentMemorySaveCount > 0) {
    return undefined;
  }

  // 否则跑原有抽取流程,但失败改为 graceful
  try {
    await runCompactExtraction(event, ctx, { inboxMode: true });
    return undefined;
  } catch (err) {
    notifySafely(ctx, `memory: safety net skipped — ${err.message}`, "warn");
    return undefined;  // 不再 cancel compact
  }
});
```

`runCompactExtraction` 增加 `inboxMode` 选项: 抽取结果写入 `~/.pi/agent/memory/inbox/`,而非 atoms 主库。读最近 `tool_call` log 提供给 LLM 作为先验 (但当前 count=0 时 log 必为空,只在 safety net 触发后 agent 又 save 时有用 — 此场景当前不存在,简化实现不读 log)。

> **简化**: 第一版 safety net 不读 tool_call log,因为触发条件 = 0 save,log 必为空。后续版本若 safety net 触发条件放宽,再加入 log 读取。

## Existing Code to Reuse

### Reuse: writeAtomToFile
- **Path**: `extensions/personal-assistant/file-store.ts:42`
- **Why**: 唯一受支持的 atom file 写入路径,生成 frontmatter、`isSafeFilename` 校验、递归 mkdir,正是 `memory_save` overwrite 与 new 路径需要复用的核心原语
- **Risk**: 设计假设其行为不会变化 (frontmatter schema / 路径 layout);若 file-store 重构,所有写入路径同步改
- **Decision**: reuse

### Reuse: MemoryIndex.insertAtom
- **Path**: `extensions/personal-assistant/storage.ts:156`
- **Why**: 标准 atom 入库路径,处理 SQL 事务、tags JSON 序列化、`memory_vectors` 关联。`memory_save` new 路径与 overwrite 路径都调它
- **Risk**: 假设 `(atom, embedding)` 一起传;overwrite 路径需要先 `deleteVector` 再 `insertAtom` (PRIMARY KEY 不冲突),两步不原子
- **Decision**: reuse (调用方负责两步协调)

### Reuse: MemoryIndex.updateAtom
- **Path**: `extensions/personal-assistant/storage.ts:186`
- **Why**: in-place update 原语,version+1,可保持 is_latest=1。考虑过 overwrite 路径用它 (不删 file),但 `version+1` 不改 version 字段由 SQL 内部处理,实际效果等同 overwrite
- **Risk**: 不重写 file (file-store 与 DB 不同步);决定 overwrite 路径走"删 file + insertAtom"两步而非 updateAtom,以保证 file 和 DB 严格一致
- **Decision**: not-used (决策见 Decision 3: overwrite 走删 + insert,不用 updateAtom)

### Reuse: MemoryIndex.findMostSimilarEmbedding
- **Path**: `extensions/personal-assistant/storage.ts:473`
- **Why**: cosine 查,返回最相似的 active atom + score。`memory_save` 两阶段 dedup 的 phase 1
- **Risk**: 假设 active filter (archived=0, is_latest=1) 已内置;若该假设变化,dedup 会命中 archived atom
- **Decision**: reuse

### Reuse: MemoryIndex.markSupersededTx
- **Path**: `extensions/personal-assistant/storage.ts:541`
- **Why**: 标准的 supersede 链写入,事务原子。当前 `memory_save` 不直接调 (因为 overwrite 简化 supersede),但 `dedup.ts` 拆分后 phase 2 仍用它
- **Risk**: 假设 oldId + newAtom shape 不变;若 storage 重构,所有 dedup 路径同步改
- **Decision**: reuse (via dedup.ts 拆分后的 phase 2)

### Reuse: MemoryIndex.deleteVector
- **Path**: `extensions/personal-assistant/storage.ts:827`
- **Why**: 清向量。overwrite 路径必须先调,否则 insertAtom 新行会因 PRIMARY KEY 冲突
- **Risk**: 单独调用不参与事务,与 insertAtom 之间有窗口;overwrite 路径接受这个窗口 (短时间无向量比阻塞重要)
- **Decision**: reuse

### Reuse: MemoryIndex.getAtom
- **Path**: `extensions/personal-assistant/storage.ts:278`
- **Why**: id 查找。overwrite 路径需要先查再写,以区分"id_not_found"和正常 overwrite
- **Risk**: 假设 getAtom 返回 rowToAtom 后的完整 MemoryAtom (含 source_session 等字段)
- **Decision**: reuse

### Reuse: embedText
- **Path**: `extensions/personal-assistant/embed.ts:64`
- **Why**: 唯一的 embed 入口,15s timeout,任何失败返 null (符合 graceful 原则)。`memory_save` 必须用它以保持失败语义一致
- **Risk**: 假设 15s timeout 足够;若 agent save 频繁,embed 调用排队不会拖慢 save 本身 (save 不 await embed timeout 时再写)
- **Decision**: reuse

### Reuse: buildEmbeddableText
- **Path**: `extensions/personal-assistant/embed.ts:150`
- **Why**: 与存储侧 `CURRENT_EMBEDDABLE_TEXT_VERSION = 2` 对齐 — embeddable text = title + summary + tags (无 content),保持 recall 行为一致
- **Risk**: 假设 embeddable text 形状不变;若 version bump,需要走 storage.init 的自动 re-index
- **Decision**: reuse

### Reuse: normalizeTags
- **Path**: `extensions/personal-assistant/tag-alias.ts:23`
- **Why**: tag alias 折叠 + Set 去重。`memory_save` 写入前必须调,与 PATCH 路径保持一致
- **Risk**: 假设 alias map 配置已加载;若 `tagAliases` 缺失会跳过折叠 (graceful)
- **Decision**: reuse

### Reuse: computeContentHash
- **Path**: `extensions/personal-assistant/file-store.ts:105`
- **Why**: sha256(normalized content).slice(0,16) — `MemoryAtom.content_fingerprint` 的生成函数。`memory_save` 必须用它以保证 fingerprint 与 webui PATCH 写入的 atom 形状一致
- **Risk**: 算法不能变,否则跨路径写入的 atom fingerprint 不一致
- **Decision**: reuse

### Reuse: isSafeFilename
- **Path**: `extensions/personal-assistant/file-store.ts:312`
- **Why**: id 合法性校验 (无 `/` / `\` / `\0` / leading dot)。`memory_save` overwrite 路径要复用 (id 由 agent 提供,需校验)
- **Risk**: 已有的 limit 200 字符 / 拒绝空 / 拒绝相对路径
- **Decision**: reuse

### Reuse: supersedeIfSimilar (split)
- **Path**: `extensions/personal-assistant/dedup.ts:18`
- **Why**: 现有 dedup gate,与 extraction 共用阈值 0.65。`memory_save` 复用其 phase 1 (查),phase 2 (supersede 写) 不直接调但保留供 webui PATCH
- **Risk**: 拆分后 phase 1 / phase 2 必须保持幂等 (同一 index + 同一输入产生同一输出)
- **Decision**: extend (拆分而非重写)

### Reuse: DEFAULT_DB_PATH / DEFAULT_ATOMS_DIR
- **Path**: `extensions/personal-assistant/memory.ts:126, 129`
- **Why**: 默认路径常量,`memory_save` 必须用同一路径解析以保证与现有 atom 共处一目录
- **Risk**: 用户可能自定义路径;`memory_save` 必须从 `loadConfig()` 读 `dbPath` / `atomsDir`,不直接用 default
- **Decision**: reuse (config-driven)

### Reuse: loadConfig
- **Path**: `extensions/personal-assistant/memory.ts:261`
- **Why**: 读 `~/.pi/agent/settings.json`,graceful fallback `{}`。`memory_save` 启动时调以拿 dbPath / atomsDir / embedding config
- **Risk**: 失败返 `{}` 而非抛错,调用方需自己 coalesce 字段
- **Decision**: reuse

### Reuse: notifySafely
- **Path**: `extensions/personal-assistant/memory.ts:137`
- **Why**: ctx.ui.notify 的安全包装,safety net 失败时用
- **Risk**: 仅在 ctx 提供 ui 时调用,否则降级 console.warn
- **Decision**: reuse

### Reuse: runCompactExtraction / extractMemoriesWithCallLlm
- **Path**: `extensions/personal-assistant/memory.ts:246` (re-export),实际实现 `extraction.ts`
- **Why**: safety net 内部调,与原有行为一致 (除了输出到 inbox 而非 atoms)
- **Risk**: `executePlan` 内部写 atoms 目录;需要新增 `inboxMode` 参数让产物落到 inbox
- **Decision**: extend (新增 `inboxMode` 参数,产物路径切换)

### Reuse: tools.ts tool_call hook 入口
- **Path**: `extensions/personal-assistant/tools.ts:934`
- **Why**: agent 所有 tool 调用的拦截点;新分支加在 satellite check 之后
- **Risk**: hook 已处理 satellite 工具,新分支不能干扰其 return
- **Decision**: extend (新增分支)

### Reuse: tools.ts before_agent_start system prompt 注入
- **Path**: `extensions/personal-assistant/tools.ts:828`
- **Why**: 每段对话开始注入 system prompt;新增 memory 段落
- **Risk**: 已注入 todowrite planning 段落;memory 段落不能与之冲突 (e.g., 重复提示"先 plan 再 save")
- **Decision**: extend (新增段落)

### Invent: memory-save.ts (新模块)
- **Why**: 没有现成的"agent 显式写 atom"工具,需要新模块统一定义 tool schema + execute 编排 + dedup phase 调用
- **Risk**: 新增模块需在 `registerTools` 中注册,否则 agent 看不到 tool
- **Decision**: invent-new

### Invent: tool_call path guard helper
- **Why**: 没有现成的"路径属于 atoms 目录"判定函数;新模块或 inline 函数实现
- **Risk**: 路径 resolve 必须正确处理 `~` / 相对路径 / symlink
- **Decision**: invent-new (放在 memory-save.ts 旁,或 tools.ts 内部 helper)

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| agent 遗忘 save,关键对话未被记录 | system prompt 显式提醒 + safety net 兜底 (count=0 时跑抽取) |
| agent importance 主观性导致 DB 稀释 | tool schema 强制 `importance` 必填,无 default;最低 0,最高 1 |
| agent overwrite 不慎覆盖重要 atom | overwrite 走 `getAtom` → `deleteVector` + `unlink` 两步,不与历史混淆;但 agent 需自己确认 id (从 recall 拿到) |
| tool_call hook 误伤合法 `read` 已有 atom | hook 仅检查 `write`/`edit`/`bash` 写模式;`read` 路径完全不受限 |
| bash 命令解析不够 robust 漏过某些 heredoc 写法 | 第一版覆盖最常见模式 (`>`, `>>`, `tee`);后续可加强解析 |
| safety net 触发条件简单 (`>=1`) 长期可能不精准 | 第一版 ship,数据驱动调优 (后续可加"覆盖 ≥80% 重要 turn"判定) |
| overwrite 不保留版本链 → agent 反复 overwrite 丢掉 history | decision 3 已接受此 trade-off;supersede 链由 cosine 命中路径保留 |
| inbox 文件无清理机制会持续堆积 | inbox 不参与 recall,主路径不受影响;清理 cron 后续独立 change |
| embedding 服务长期 down → 新 atom 全无向量,recall 退化 | sparse channel 兜底 (`hybrid-search.ts`);decay 仍按 importance 跑,atom 不消失 |
| agent 用 overwrite 把别人写的 atom 覆盖掉 | overwrite 不区分 owner,任何 agent save 都能 overwrite;无 audit;trade-off 接受 (本就是 single-user 系统) |

## Testing Strategy

### 单元测试 (`test/memory-save-tool.test.ts`)

| Case | Given | When | Then |
|------|-------|------|------|
| new, no conflict | DB 空 | `memory_save({type:"rule", title, content, importance:0.7})` | `{ok:true, action:"created", id:<uuid>}`;DB 1 row, file 存在, vector upserted |
| conflict detected | DB 1 atom cosine 0.78 | `memory_save({...})` 无 id | `{conflict:{id, score:0.78, title}}`;DB 不变 |
| overwrite, id exists | DB 1 atom id=a-123 | `memory_save({id:"a-123", content:"new", ...})` | `{ok:true, action:"overwritten"}`;旧 file 删,新 file 写,vector 重 embed |
| overwrite, id not found | DB 空 | `memory_save({id:"a-ghost", ...})` | `{ok:false, error:"id_not_found"}`;DB 不变 |
| embedding down | ollama ECONNREFUSED | `memory_save({...})` | `{ok:true, action:"created", embedding:"skipped"}`;DB 1 row, vector 缺行 |
| invalid type | — | `memory_save({type:"opinion", ...})` | `{ok:false, error:"invalid_type"}` |
| empty content | — | `memory_save({content:"", ...})` | `{ok:false, error:"content_required"}` |

### 集成测试

- `tool_call` hook: mock agent 调 `write({path:"~/.pi/agent/memory/atoms/process/foo.md"})` → hook 返回 block error,fs 不写
- `tool_call` hook: mock `bash({command:"cat > ~/.pi/agent/memory/atoms/process/foo.md"})` → block
- `tool_call` hook: mock `read({path:"~/.pi/agent/memory/atoms/process/a-123.md"})` → 不拦截,正常返回内容
- safety net: segment 内 0 save + compact 触发 → `runCompactExtraction` 跑,inbox 有新文件,atoms 不变
- safety net: segment 内 1 save + compact 触发 → 跳过,无 inbox 文件
- safety net: 抽取失败 (mock callLlm throws) → graceful skip,compact 继续,ctx.ui.notify 调用

### 边界

- importance 0 / 0.5 / 1 三个值,均落库正确
- title 长度 1 / 100 / 200,均通过;201 应被 schema 拒 (Type.String maxLength)
- tags 空数组 vs 字段缺失,行为等价
- 嵌入超时 15s → null 路径,不阻塞 save

### 回归

- 现有 webui PATCH 路径 (路由 `packages/webui/server/routes/memory.ts`) 行为不变
- 现有 `session_before_compact` 抽取逻辑 (extraction.ts:executePlan) 不变,仅调用条件与失败处理变
- 现有 recall / gate / rerank / hybrid-search 不受影响

## Implementation Notes

### 任务依赖顺序

1. `dedup.ts` 拆分 phase 1 / phase 2 (基座,被多路径复用)
2. `memory-save.ts` 新建 (含 tool 定义 + 三 mode 编排 + 调用拆分后的 dedup)
3. `tools.ts` 注册 tool + 路径 hook 分支 + system prompt 段
4. `memory.ts` 改 `session_before_compact` 为 safety net + segment 计数
5. `extraction.ts:executePlan` 加 `inboxMode` 参数 (或 memory-save.ts 层包装)
6. 测试: 6 case 单元测试 + 4 case 集成测试

### 进程内 counter

`segmentMemorySaveCount` 用 module-level variable in `memory-save.ts`,在 `before_agent_start` (tools.ts:828) 里 reset。`memory-save.ts` 与 `tools.ts` 都在 `registerTools` 内注册,counter 共享同一个 module scope。

### cosine 阈值 0.65 vs 0.92

- `extraction.ts` / `dedup.ts` 用 **0.65** (低阈值早预警,LLM 二次确认)
- webui PATCH `supersedeIfSimilar` 用 **0.92** (高阈值才 supersede,user 主动编辑)

`memory_save` 走 **0.65** (与 extraction 对齐),因为:
1. agent-driven 是新写入,与 extraction 路径同级,需要同样的早期预警
2. webui PATCH 0.92 是因为 user 已经手动编辑了,语义上 user 知道自己在改;agent 不知道,需要更早的 conflict 提示

### 文件改动清单

| 路径 | 动作 | 行数估计 |
|------|------|----------|
| `extensions/personal-assistant/memory-save.ts` | 新建 | ~150 |
| `extensions/personal-assistant/dedup.ts` | 改 (拆分 phase 1/2) | +30 -10 |
| `extensions/personal-assistant/tools.ts` | 改 (register + hook + prompt) | +80 |
| `extensions/personal-assistant/memory.ts` | 改 (safety net + counter) | +20 -10 |
| `extensions/personal-assistant/extraction.ts` | 改 (inboxMode 参数) | +30 -5 |
| `extensions/personal-assistant/test/memory-save-tool.test.ts` | 新建 | ~250 |

合计 ~550 行新增/改动。

### 验证 checklist (sdd-review 阶段执行)

- [ ] npm run check 全绿
- [ ] 7 个单元测试 + 4 个集成测试全过
- [ ] 现有 webui PATCH 测试 (`packages/webui/server/test/memory-routes.test.ts`) 全过
- [ ] 现有 extraction 测试 (`extensions/personal-assistant/test/session-before-compact.test.ts`) 全过
- [ ] 手工 smoke: agent 调 `memory_save` 三种 mode 各一次,UI 显示 ok
- [ ] 手工 smoke: agent 试图 `write` atom 文件,UI 显示 block error
- [ ] 手工 smoke: 整段 0 save,compact 触发后 inbox 有文件
# Design: memory-pipeline-hardening

## Context

Memory 管线当前在 webui 写入路径下有 5 个真实痛点(经源码逐条核验):

1. **CAS 缺失**: `packages/webui/server/routes/memory.ts:216-288` 的 PATCH 不校验 `expected_version`,3 秒 debounce + 3 秒轮询的组合下乐观更新会无声覆盖远端。
2. **supersede 跳过**: `extraction.ts:122-162` 的 cosine > 0.92 自动 supersede 门**只**被 extraction 流程调用。`MemoryEditor.tsx` 的 webui PATCH 直接打 `memory.ts:216`,绕过去重门,触发 `MemoryEditor.tsx:158-167` 的 `empty body` 警告(同标题 atom 覆盖 .md 文件)。
3. **轮询浪费**: `MemoryDetail.tsx:73` 的 `setInterval(..., 3000)` 在无变化时也是 100% 冗余网络。无 SSE 推送。
4. **tag 无归一化**: `MemoryEditor.tsx:64` 只做 `split+trim+filter`,同概念的多种写法产生孤立检索噪声。
5. **score 缺维度**: `search.ts:506-508` 的 `score = cosine × (1 + 0.3strength + 0.2importance)` 不含 `tag_overlap` 和 `freshness_decay`。

## Goals / Non-Goals

**Goals**:
- webui PATCH 路径接入 `If-Match` 版本校验(409 终止冲突)
- webui PATCH 路径复用 `extraction.ts` 的 cosine supersede 门
- `MemoryDetail` 用 SSE 替换 3 秒轮询
- 写入时归一化 tag(走 `settings.memory.tagAliases` 映射)
- 检索 score 加 `tag_overlap` 和 `freshness_decay` 两维度,保持 `cosine/score` 向后兼容

**Non-Goals**:
- 不实现 LLM 提议合并对话框(用户选择 静默自动 supersede)
- 不替换 List/Stats 轮询(SSE 仅 Detail)
- 不重构 `MemoryDetail.tsx:35-44` 的 `computePatch`(SSE+server CAS 让本地深比较问题降级)
- 不引入新依赖

## Decisions

### 1. CAS 用 HTTP `If-Match` 头
**Decision**: PATCH 请求带 `If-Match: "<version>"`,服务端校验失败返回 `409 + {error:"version_conflict", current:atom}`。
**Rationale**: REST 标准,中间件/代理可识别;`fetch()` API 直接传 `headers` 即可,无 body schema 改动。
**Alternatives**: body 字段 `expected_version`(拒绝,语义不够 REST,跨代理不识别)。

### 2. webui PATCH 复用 extraction 的 supersede 门
**Decision**: 抽出 `extraction.ts:122-162` 的 cosine dedup 逻辑为独立函数 `supersedeIfSimilar(index, newAtom, embedding, atomsDir)`,`executeItem` 和 PATCH 路由都调用。
**Rationale**: 单一去重门,杜绝 webui 路径绕过;cosine 阈值 0.92 已经过既有测试覆盖(`extraction.test.ts` 间接覆盖)。
**Alternatives**: LLM 判断(拒绝,webui 同步路径下延迟高);UI 弹窗(拒绝,用户已选 静默自动 supersede)。

### 3. SSE 单连接 + 心跳保活
**Decision**: 新增 `GET /api/memory/:id/stream`,用 `res.write()` 推 SSE 帧。维护 `Map<atomId, Set<Response>>` 订阅表,PATCH 命中时遍历推送。心跳 25s 一次注释帧。
**Rationale**: express 原生 `res` 即可,无需 ws 升级;注释帧防 NAT/中间设备切断;订阅表用内存 Map(atom 数量 O(100s),GC 友好)。
**Alternatives**: WebSocket(过度工程,server→client 单向即可);全表广播(拒绝,只 Detail 需要)。

### 4. tag 归一化双侧 + alias 存 settings 表
**Decision**: 写入路径经 `normalizeTags(input, aliases?)` —— trim → 空过滤 → alias 折叠 → Set 去重 → 保序。alias 源是 `settings.memory.tagAliases`(`PersonalAssistantConfig` 扩展字段)。**查询侧**对 query 做同样的 split + alias 折叠,用于 `computeTagOverlap`。
**Rationale**: 双侧归一化是关键 —— 否则 atom 用 `code-style`、query 用 `coding-rule` 即便 alias 折叠了也只是单侧有效。`settings.json` 通过既有 `PATCH /api/settings`(settings.ts:86) 修改即可,无需新接口。`deps.settings` 已存在于 `MemoryDeps`(memory.ts:57),`normalizeTags` 在 PATCH 路由里直接读。
**Alternatives**: 单独 `tag_aliases.json` 文件(拒绝,用户已选 settings 表);LLM 自动提议 alias(拒绝,非目标);数据库维护 alias 表(拒绝,MVP 不需要);仅写入侧归一化(拒绝,查询侧不归一化则 tag_overlap 仍漏命中)。

### 5. score 公式加法叠加 tag_overlap + freshness
**Decision**: 新公式
```ts
const tagOverlap = computeTagOverlap(query, atom.tags);    // 0..1,query 经 alias 归一
const freshness = computeFreshness(atom.updated_at);       // 0..1
score = cosine × (1 + 0.3strength + 0.2importance)
      + wTag × tagOverlap
      + wFreshness × freshness;
// 默认 wTag=0.10, wFreshness=0.05,均可由 settings.memory.{tagOverlapWeight,freshnessWeight} 覆盖
```
**Rationale**: 主项 `cosine × (1+...)` 保持向后兼容(agent 的 `memory_get` 工具和 `SearchResponse.score` 字段);加法项贡献 ≤ 0.15,不会颠覆排序,只对边缘 case 调整。`tagOverlap` 计算前先 `normalizeQueryTags(query, settings.tagAliases)`,确保双侧归一。
**Alternatives**: 乘法叠加(拒绝,会放大 cosine 差异);替换主项(拒绝,破坏 back-compat);tag_overlap 作为独立阈值门(拒绝,作用同 BM25 通道冗余)。

## Architecture

### 组件 + 数据流

```
┌─────────────────┐    If-Match: <v>    ┌──────────────────────┐
│  MemoryDetail   │ ───────────────────>│  PATCH /api/memory/  │
│  (EventSource)  │                     │       :id           │
│                 │<─ 200 atom / 409 ──│  supersede 门 (cos)  │
└─────────────────┘                     │  tag 归一化          │
        │                               │  writeAtomToFile     │
        │ SSE                            └──────────┬───────────┘
        │                                          │
        │ event: atom                              ▼
        │                                  ┌──────────────────┐
        │<─────────────────────────────────│ 订阅表: Map<id,  │
        │                                  │  Set<Response>>   │
        │                                  └──────────────────┘
```

### 新增/修改接口

```ts
// 新增 extensions/personal-assistant/dedup.ts(从 extraction.ts 抽出)
export async function supersedeIfSimilar(
  index: MemoryIndex,
  atomsDir: string,
  newAtom: MemoryAtom,
  embedding: number[] | null,
  threshold?: number, // 默认 0.92
): Promise<{ status: "supersede" | "create"; atom: MemoryAtom }>;

// 新增 extensions/personal-assistant/tag-alias.ts
export function normalizeTags(
  input: string[],
  aliases?: Record<string, string>,
): string[];
// aliases 来自 settings.memory.tagAliases(见 PersonalAssistantConfig 扩展)

// 扩展 PersonalAssistantConfig.memory(memory.ts:67-103)
tagAliases?: Record<string, string>;     // 写入归一化 + 查询 token 折叠
tagOverlapWeight?: number;               // 默认 0.10
freshnessWeight?: number;                // 默认 0.05

// 新增 extensions/personal-assistant/scoring.ts(从 search.ts 抽出)
export function computeTagOverlap(query: string, tags: string[]): number;
export function computeFreshness(updatedAt: number, now?: number): number;

// 修改 extensions/personal-assistant/search.ts
// score 公式扩展;新增字段加到 RecallResult: tagOverlap, freshness

// 修改 packages/webui/server/routes/memory.ts
// PATCH: 校验 If-Match,409 终止;调用 supersedeIfSimilar;normalizeTags;订阅表广播
// 新增 registerStreamMemoryById: GET /api/memory/:id/stream (SSE)

// 修改 packages/webui/web/src/lib/api.ts
// api.memory.patch 增加 headers 参数透传

// 修改 packages/webui/web/src/components/memory/MemoryDetail.tsx
// EventSource 替换 setInterval,onmessage 更新本地 atom;useAutoSave 的 onSave 带 If-Match

// 修改 packages/webui/web/src/components/memory/MemoryEditor.tsx
// handleTagsChange 走 normalizeTags(input),输入即时归一化
```

### 错误处理

| 场景 | 状态码 | 响应 |
|---|---|---|
| `If-Match` 缺失 | 400 | `{error:"missing_if_match"}` |
| `If-Match` version 不匹配 | 409 | `{error:"version_conflict", current:atom}` |
| `If-Match` 是 `"*"` | 428 | (ETag precondition required 语义) |
| atom 不存在 | 404 | `{error:"atom_not_found"}` |
| supersede 命中 | 200 | `{...newAtom, status:"superseded", previousId:"..."}` |

## Existing Code to Reuse

### Reuse: `markSupersededTx`
- **Path**: `extensions/personal-assistant/storage.ts:609`
- **Why**: 已经是 supersede 的事务化实现,新 PATCH 路径可直接调用,无需重写 audit log / FTS5 mirror / vector 转移。
- **Risk**: 该函数签名固定 `(oldId, newAtom, newEmbedding)`,需要保证新 atom 字段对齐 `MemoryAtom` 全字段(从 `existing` spread 继承)。
- **Decision**: reuse

### Reuse: `findMostSimilarEmbedding`
- **Path**: `extensions/personal-assistant/storage.ts`(被 `extraction.ts:147` 调用,需在 search.ts 重导出或引用同模块)
- **Why**: 已经实现 cosine 距离 + 类型过滤 + archived 排除的 KNN,无需重写。
- **Risk**: 当前 `extraction.ts:147` 用 `0.92` 阈值,新路径必须沿用同一阈值(已在 extraction 测试覆盖)。
- **Decision**: reuse

### Reuse: `computeFingerprint`
- **Path**: `extensions/personal-assistant/extraction.ts:127`
- **Why**: sha256 content fingerprint,PATCH 路径应同样跳过完全重复内容(supersede 之前的便宜检查)。
- **Risk**: 已经稳定,无破坏性改动。
- **Decision**: reuse

### Reuse: `rrfFuse`
- **Path**: `extensions/personal-assistant/search.ts:154`
- **Why**: 已经实现 RRF 融合,scoring 改动只在 `scored.push` 的 `score` 字段,不影响 `rrfScore` 字段或融合逻辑。
- **Risk**: 必须保证 `rrfScore` 排序仍然主导,新加法项只影响 `score` 字段(back-compat)。
- **Decision**: reuse(只读其排序输出)

### Reuse: `STRENGTH_WEIGHT` / `IMPORTANCE_WEIGHT`
- **Path**: `extensions/personal-assistant/search.ts:108-109`
- **Why**: 加权常量已经存在,新公式保留这两个常量,只新增 `TAG_OVERLAP_WEIGHT = 0.10` / `FRESHNESS_WEIGHT = 0.05`。
- **Risk**: 既有测试 `hybrid-recall.test.ts` 校验 score 数值,新加法项会改变数值,需要更新测试的断言或调整容差。
- **Decision**: extend(新增两个常量,既有值不变)

### Reuse: `MemoryDeps` 注册函数模式
- **Path**: `packages/webui/server/routes/memory.ts:90/147/216/392/469/553`(registerXxxMemory pattern)
- **Why**: 每个路由用 `registerXxxMemory(app, deps)` 单独注册,新 SSE 路由沿用 `registerStreamMemoryById` 同模式。
- **Risk**: `MemoryDeps` 接口已扩展(`settings`, `callLlm` 在测试编译失败中可见),新路由需要满足新接口。
- **Decision**: reuse pattern

### Reuse: SSE 注释帧写法
- **Path**: `packages/webui/server/ws-handler.ts`(存在但需读源)
- **Why**: 已有 WebSocket handler,SSE 注释帧(以 `:` 开头)约定保持一致。
- **Risk**: ws-handler 是 WebSocket 实现,SSE 只需 `res.write(": ping\\n\\n")`,无复用 ws-handler 代码本身,但注释帧格式约定一致。
- **Decision**: 单独写 SSE(无现成 helper 可直接 reuse)

### Reuse: `extract` route 注册模式
- **Path**: `packages/webui/server/routes/memory.ts:553`
- **Why**: `POST /api/memory/extract` 的 register 模式 + 异步 + try/finally + `index.close()` 清理,新 PATCH 改动沿用同一 shape。
- **Risk**: 既有路由用 `req.body` 字段而非 `If-Match` 头,需要在 PATCH handler 里加 `req.headers['if-match']` 解析。
- **Decision**: reuse try/finally pattern,新增 header 解析分支

### Reuse: `useAutoSave` debounce
- **Path**: `packages/webui/web/src/lib/useAutoSave.ts`(被 MemoryDetail.tsx:80 调用)
- **Why**: 3 秒 debounce + 失败重试已经在用,CAS 失败时只需在 `onSave` 里 catch 409 并提示用户,无需替换 hook。
- **Risk**: 当前 `onSave` 不区分错误类型,需要扩展为识别 `e.status === 409`。
- **Decision**: extend(在 `onSave` 加 409 处理分支)

### Reuse: `MemoryAtom` 类型
- **Path**: `extensions/personal-assistant/types.ts:26` / `packages/webui/web/src/lib/api.ts:88`
- **Why**: server / extension / webui 三处共享类型,新增字段 `tagOverlap` / `freshness` 必须加到 RecallResult(扩展类型)而非 MemoryAtom。
- **Risk**: RecallResult 在搜索响应里,新增字段需要 webui 端 SearchResult 类型同步(可能扩 `MemorySearchTester.tsx:9-18`)。
- **Decision**: extend RecallResult + SearchResult(只为 debug 显示,不影响业务逻辑)

## Risks / Trade-offs

| Risk | Mitigation |
|---|---|
| SSE 订阅表内存泄漏(客户端断开但未移除) | `res.on('close')` 监听,断开时从 Set 删除;心跳超时(60s)主动清理 |
| cosine supersede 在 ollama down 时跳过,webui 路径退化 | 沿用 `extraction.ts:147` 的 graceful degradation,fallback 到原 PATCH 流程,日志记 warn |
| `If-Match` 头被某些反向代理剥离 | 在 server 启动时打印 warning 日志,`req.headers['if-match']` 取不到时按 400 处理 |
| 新 scoring 公式破坏既有 `hybrid-recall.test.ts` 的 score 数值断言 | 既有断言用容差 `toBeCloseTo(..., 2)` 即可吸收小变化;tag_overlap/freshness 项只在 query 命中 tag 或 atom 新鲜时贡献,绝大多数测试不触发 |
| `tag_aliases` 缺失/格式错 | `normalizeTags` 在 `aliases` undefined / 非对象时直接返回 `Array.from(new Set(input))`,graceful degradation |
| SSE 与 3 秒轮询并存时,`MemoryDetail` 同时收到两路更新 | 先实现 SSE,然后删轮询;过渡期用 feature flag(`useSSE` 默认 false) |
| `supersedeIfSimilar` 抽出后 `extraction.ts:122-162` 重构 | 重构后 `executeItem` 调用新函数,既有 `extraction.test.ts` 覆盖不变 |

## Testing Strategy

- **单元测试**:
  - `extensions/personal-assistant/test/tag-alias.test.ts`: 归一化(写入侧)、query 归一化(检索侧)、alias 映射、空输入、alias 缺失
  - `extensions/personal-assistant/test/scoring.test.ts`: `computeTagOverlap` / `computeFreshness` / `normalizeQueryTags` 数值正确性 + 三路 score 公式
  - `extensions/personal-assistant/test/dedup.test.ts`: `supersedeIfSimilar` 抽出后的纯函数测试(用现有 `MemoryIndex` fixture)
- **集成测试**:
  - `packages/webui/server/test/memory-routes.test.ts` 新增:
    - PATCH 带 `If-Match` 200 + 不带 400 + version mismatch 409
    - PATCH 命中 cosine > 0.92 时触发 supersede(用 `charBag` mock embedder 控制距离)
    - SSE: 客户端订阅 → 另一个客户端 PATCH → 第一客户端收到 `event: atom` 帧
    - 心跳: 25s 注释帧(测试用更短间隔 + vi.useFakeTimers)
  - `extensions/personal-assistant/test/hybrid-recall.test.ts`:
    - score 公式扩展后 `tagOverlap/freshness` 字段正确填充
    - back-compat: 旧 score 数值在 `tagOverlap=0, freshness=0` 时与新公式一致
- **边界条件**:
  - SSE 连接断开重连:`vi.useFakeTimers` + 模拟 `res.close`
  - `settings.memory.tagAliases` 缺失/非对象: 归一化跳过,直接 Set 去重
  - cosine = 0.92 边界:`>=` 比较,等同 `extraction.ts:147`

## Implementation Notes

**依赖顺序**(TDD 推进):

1. `tag-alias.ts` + `tag-alias.test.ts`(无依赖,先做)
2. `scoring.ts`(computeTagOverlap / computeFreshness)+ `scoring.test.ts`
3. `dedup.ts`(`supersedeIfSimilar`) + `dedup.test.ts`,然后 `extraction.ts:122-162` 重构调用
4. PATCH route 修改:supersede + tag 归一化 + If-Match 校验(用步骤 1/3 的 helper)
5. SSE route + 订阅表 + PATCH 广播
6. `MemoryDetail.tsx` EventSource 替换 setInterval + `api.memory.patch` 带 If-Match
7. `MemoryEditor.tsx` tag 输入归一化
8. `hybrid-recall.test.ts` 既有 score 断言调整

**注意事项**:

- `If-Match` 头格式是 `"5"`(带引号的 ETag-style),不是裸 `5`。Express 解析后是字符串,直接 `===` 比较。
- SSE 注释帧必须以 `\n\n` 结尾(空行作为帧终止);事件帧 `event: atom\ndata: {...}\n\n`。
- `supersedeIfSimilar` 抽出时必须保留 `markSupersededTx` 的 audit log 写入(extraction.ts 间接依赖)。
- server 端的 SSE 订阅表用 module-level `Map<id, Set<Response>>`,要避免 hot reload 泄漏(vitest watch 模式);简单方案:测试每个 case 独立 `createApp`。
- `settings.memory.tagAliases` 写入路径:走既有 `PATCH /api/settings`(settings.ts:86) deep-merge,无需新建接口;`MemoryDeps.settings`(memory.ts:57)在 PATCH handler 里直接读取。
- `MemoryDeps` 当前要求 `settings, callLlm`(测试编译错误暴露),新代码沿用即可,无需扩展接口。

**验证清单对应 scenarios.md**: 每个 Scenario 必须有对应测试,verification-checklist 在 write_plan 阶段生成。
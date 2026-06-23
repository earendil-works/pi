# Design: memory-search-get-decoupling

## Context

memory-v2 当前(2026-06-23)实现了一整套纯向量召回的 pipeline,但 search / get / importance 三个动作在语义上纠缠在一起,导致 agent 端的 recall→act 闭环不清晰:

- `recallAtoms` 返回 `file_path`,agent 用 `read(file_path)` 读全文,但 `read()` 不向记忆系统反馈"这个 atom 真的被用到了"
- `recallAtoms` 在 search 阶段就调 `index.updateAccess(id)`,`access_count` 反映的是"被看到过几次",不是"被实际用过几次"
- `recallAtoms` 排序仅按 cosine desc,**完全忽略** `strength` 和 `importance` 两个元数据字段,导致 strength 高(近期被用过)或 importance 高(rule 类型)的 atom 在 cosine 接近时仍可能排在后面
- `EXTRACT_PROMPT_V2` 让 LLM 自主打 importance,但**没有**任何关于用户语气强度的 hint,LLM 容易给保守打分(0.5-0.7)
- 单 KNN 全局 top-10,可能 8 rule + 2 fact 偏斜,process 完全漏掉
- 现有的 `runDecay` 已经在做"遗忘" — strength 随时间衰减,低于阈值时归档,但 search 排序公式没有利用这个信号,导致"越用越显"的反馈循环是单向的(get → strength → archive 影响),排序侧不体现。

本变更通过 3 个独立子动作解耦:
1. search 纯向量、不 bump、返 id(让 LLM 知道可调 memory_get)
2. memory_get tool 是 strength feedback 唯一程序入口
3. tone scoring 给 extraction LLM 提供 importance hint

## Goals / Non-Goals

**Goals**:
- search / get 在 DB 层语义分离,strength 只反映"agent 实际调用 get 的次数"
- LLM 拿到 search 结果后,通过 `memory_get(id)` 拿全文,显式使用记录到 strength
- recall 保证 type 多样性(rule / fact / process 都有机会出现),不被单一 type 偏斜淹没
- search 排序使用乘法 boost 公式 `score = cosine × (1 + 0.3 × strength + 0.2 × importance)`,cosine 是主乘数,strength/importance 持续参与每次排序
- "越用越显"反馈循环: get → strength 高 → score 高 → 排名靠前 → 更频繁被 recall
- "遗忘 → 清理"完整链条: runDecay → strength 低 → score 低 → 排名下降 → 进一步 decay → 最终 archive
- importance 由 extraction LLM 在看到用户语气强度 hint 后**自主**判断,词表扫描只决定 hint 等级
- 测试覆盖所有路径,`npm run check` 绿

**Non-Goals**:
- search 排序**不引入**线性加权公式(`α*cosine + β*strength + γ*importance`)— 会让不相关 atom 反超相关 atom,违反"必须相关"原则。改用乘法 boost 保证 cosine 是绝对主键。
- search 排序**不**用多键 strict-equality 排序 — 在实际浮点 cosine 上 strict equality 几乎永远不触发二级键,等于纯 cosine。
- 不改 agent 端 `read()` 工具 — agent 用 `memory_get(id)` 替代 `read(path)`,不再需要 `read()` 拦截 hook。
- 不改 webui MemoryEditor 自动 preview — 用户在 UI 看 atom 详情**不**算"get",不 bump strength(programmatic get only)。
- 不重新实现 extraction 其他阶段(dedup / supersede / write)
- 不引入新依赖,所有改动用现有 better-sqlite3 + sqlite-vec + zod + typebox

## Decisions

### 1. search 返 id 不返 path,bump 路径完全分离
**Decision**: search response 不含 `file_path`,`recallAtoms` 内部不调 `updateAccess`。LLM 拿到 results 后只能通过 `memory_get(id)` tool 拿全文并 bump strength。

**Rationale**: search 是 discovery,get 是 feedback。两者必须在 DB 层分开,否则 strength 反映的是"被看到过"而不是"被用过"。这是 memory-v2 引入 strength decay 后一直没补上的闭环。

**Alternatives considered**:
- A. search 返 path + agent 用 `read(path)` + read 拦截 hook bump(用户早期提议) — 拒绝,read 拦截需要 ExtensionContext hook on tool execution,侵入 pi-mono 内部 API,且不能区分"读了文件但没用上 vs 读了且用了"
- B. search 返 id,LLM 通过内部 fetch 调 HTTP endpoint(无 tool) — 拒绝,LLM 没有 HTTP fetch tool,需要引入新 tool
- C. **本方案:search 返 id,memory_get tool 显式 bump** — 选这个,语义清晰,ExtensionContext 已有 `registerTool` API

### 2. recall 按 type 分层 top-3
**Decision**: `recallAtoms` 内部跑 3 次 `vectorSearch`(per type),各取 cosine top-3。稀疏 type 自动降到 1,绝不强行凑 3。

**Rationale**: 单 KNN 全局排序的偏斜问题是真实存在的 — top-10 经常是 8 rule + 2 fact,完全漏掉 process。per-type top-3 保证多样性,让 LLM 看到 3 种不同类型的 atom。

**Alternatives considered**:
- A. 单 query 取 top-30 → JS 端分组 → 各取 top-3(用户提的"宽查询分组") — 拒绝,需要 higher K(>= 30)才能保证每 type 有 3 个,sqlite-vec KNN 大 K 时精度会下降
- B. 3×3 + 余量给最强 type — 拒绝,增加复杂度,边际收益小
- C. **本方案:3 个独立 vectorSearch,各取 top-3 + 稀疏 fallback** — 选这个,简单且语义清晰

### 3. formatMemoryBlock 输出 id 不输出 file_path
**Decision**: 块格式从 `[type] title\nsummary\nfile: <path>\nTags: ...` 改成 `[type] title\nsummary\nid: <uuid>\nTags: ...`。

**Rationale**: LLM 看到 id 才能调 `memory_get(id)` 拿全文。如果 LLM 只看到 summary 不看到 id,需要再调一次 search 才能拿到 id,多一轮 token。

**Alternatives considered**:
- A. block 不含 id,LLM 依赖 search 响应里的 id 自行关联 — 拒绝,context injection 与 search response 是两个调用,LLM 不一定能稳定 cross-reference
- B. block 同时含 id 和 file_path — 拒绝,file_path 没用了(LLM 不该自己 read 文件),多此一举
- C. **本方案:block 只含 id** — 选这个,context 注入信息熵最大、长度最小

### 4. importance 由 extraction LLM 自主判断,tone 只给 hint
**Decision**: `scoreUserTone(messages)` 返回 `{level, score}`,作为 hint 段 `<user_tone level="..." score="...">` 注入 EXTRACT_PROMPT_V2。LLM 看到 hint 后**自己**决定 importance,词表扫描**不**直接覆写。

**Rationale**: LLM 有上下文判断能力(消息中其他语气、对话氛围、atom 内容),纯词表规则无法匹敌。但 LLM 在没提示时容易给保守打分(0.5-0.7),hint 可以把它推向正确区间(强语气 → 0.9+)。

**Alternatives considered**:
- A. tone score 直接覆写 LLM importance — 拒绝,失去 LLM 上下文判断能力,且用户不同意
- B. 加权混合 `0.6*LLM + 0.4*tone` — 拒绝,需要调权重,泛化性差
- C. **本方案:tone 作为 hint,LLM 自主判断** — 选这个,符合用户明确指示

### 5. 中英语气词词表,纯匹配
**Decision**: 4 档词表(STRONG / HABIT / WEAK / NEUTRAL),~20 词覆盖中文("千万 / 务必 / 必须 / 一定 / 总是 / 永远 / 可能 / 也许")和英文("must / always / never / maybe")。只看最近一条 user 消息,微秒级,无 LLM 调用。

**Rationale**: 词表匹配足够捕捉用户显式语气,误判成本低(LLM 还有一次机会修正),且零额外延迟。如果未来需要更高精度,可以加 LLM 二次 prompt,但当前阶段 YAGNI。

**Alternatives considered**:
- A. 独立 LLM call 判断 tone — 拒绝,每次 extraction 多 1 次 LLM 调用,成本高
- B. 只中文 — 拒绝,虽然项目以中文为主,但双语覆盖几乎零成本
- C. **本方案:双语词表,纯匹配** — 选这个,简单且足够

### 6. memory_get tool 注册在 extension,而非 webui server
**Decision**: `memory_get` 是 agent LLM-facing tool,只在 personal-assistant extension 注册(`pi.registerTool({...})`)。webui server **不**暴露等价 endpoint,bump 路径完全在 agent 进程内。

**Rationale**: 
- memory_get 是 agent 调用 → 触发 bump → 更新 DB → 未来 search 时 strength 反映出来
- webui 的 `GET /api/memory/:id` 仅供 UI 预览用,**不** bump,因为 UI 看到的不能等价于"agent 用了"
- 这两条路径严格区分,避免"UI 浏览"和"agent usage"混淆

**Alternatives considered**:
- A. webui 也提供 bump endpoint — 拒绝,UI preview 不该算 usage feedback
- B. agent 端走 read hook 而不是 memory_get tool — 拒绝,read hook 难写且不能区分"读了 vs 用了"
- C. **本方案:memory_get 是 agent-only tool,webui GET /:id 不 bump** — 选这个,语义干净

### 7. webui GET /:id 不 bump(预览路径)
**Decision**: `GET /api/memory/:id` 端点**不**调 `index.updateAccess(id)`,仅返回 atom 详情供 MemoryEditor 显示。

**Rationale**: 用户明确指示"UI 不 bump,只有程序 get bump"。preview-only endpoint 不向 strength 提供 feedback,严格区分 UI 浏览 vs agent 实际使用。

**Alternatives considered**:
- A. GET /:id 加 query param `?feedback=true` — 拒绝,过度设计,UI 永远不传
- B. GET /:id 永远 bump — 拒绝,违反"UI 不 bump"
- C. **本方案:GET /:id 不 bump** — 选这个,与 memory_get tool 形成清晰分工

### 8. per-type top-3 加权公式 + round-robin 交错
**Decision**: 召回算法分两层,组内用**加权公式**计算 score,组间 round-robin 交错:

**Score 公式**:
```
score = cosine * (1 + 0.3 * strength + 0.2 * importance)
```

**组内(per-type)**: 每个 type 独立 `vectorSearch`,然后:
1. cosine ≥ 0.5 过滤(全局 threshold)
2. 计算 `score = cosine * (1 + 0.3 * strength + 0.2 * importance)`
3. 按 score DESC 排序,取前 3 条(稀疏 type 自动降到 1)
4. `score` 字段写入 `RecallResult`(给 UI / 调试用)

**组间(cross-type)**: 三个 type 的 top-3 用 round-robin 交错拼接:
- `[rule[0], fact[0], process[0], rule[1], fact[1], process[1], rule[2], fact[2], process[2]]`
- 稀疏 type 跳过对应槽位

**Rationale**:
- **cosine 仍是主键** — 公式用乘法结构 `cosine * (...)`,cosine 趋近 0 时 score 必趋近 0,**不相关 atom 不可能被 boost 反超**
- **strength boost (0-0.3)**: 反映"近期被用过 + 没衰减",直接进入 feedback 循环
  - atom 被 `memory_get` → strength 高 → score 高 → 排名靠前 → 更容易被未来 recall 看到 → 更容易被 get
  - atom 长期不用 → runDecay 把 strength 拉低 → score 降 → 排名降 → 更慢被 recall → 进一步 decay → 触发归档
- **importance boost (0-0.2)**: 反映"作者/LLM 给的静态优先级"
  - rule type importance 永远 ≥ fact/process,所以 rule 在 cosine + strength 相同时自然胜出
  - 高 importance atom 即使 strength 低也能保留(因为 importance 是静态,不衰减)
- **权重 α=0.3, β=0.2 的边界**: max boost = 0.5,所以 score ∈ [0, 1.5 * cosine_max]
  - cosine 必须 ≥ 0.667x 才能仅靠 cosine 嬴(boost 极限)
  - 实际差距: cosine=0.6/strength=1.0/importance=1.0 → score=0.9;cosine=0.85/strength=0.1/importance=0.1 → score=0.8925 — 后者仍然嬴,因为 cosine 0.85 的差距大于 boost 带来的差距
- **对比旧设计(多键排序 strict equality)**: 在实际浮点 cosine 上,strict `b.cosine !== a.cosine` 几乎永远 true,二级键永远不触发,等于纯 cosine。新公式让 strength/importance **持续参与**每次排序
- **与现有 `runDecay` 配合**: `runDecay` 持续调低 strength → score 持续降 → 排名降 → 自然形成"遗忘 → 清理"链条,与现有 archive 阈值 (0.1) 形成完整 feedback
- `formatMemoryContext` 注入 prompt 时再做一次全局 distance asc 排序(只看 cosine 主键),所以 score **影响** search response,**不影响** LLM prompt 内容
- 顺序确定性:同 query 多次调用结果完全一致(便于调试、测试 snapshot)

**Alternatives considered**:
- A. 多键排序 `cosine → strength → importance`(strict equality)— **拒绝**,在实际浮点 cosine 上 strict equality 几乎永远 true,等于纯 cosine
- B. 线性加权 `α*cosine + β*strength + γ*importance` — 拒绝,strength=1.0 且 cosine=0.5 时 score=0.8,可能赢过 cosine=0.7 的 atom,违反"必须相关"原则
- C. **本方案:乘法 boost** — 选这个,cosine 是绝对的最小乘数,strength/importance 持续参与,formula 一行可解释

**算法伪代码**:
```ts
const TYPES = ["rule", "fact", "process"] as const;
const PER_TYPE_CAP = 3;
const THRESHOLD = 0.5;
const RAW_BUFFER = 6;  // 3 cap × 2 headroom
const STRENGTH_WEIGHT = 0.3;
const IMPORTANCE_WEIGHT = 0.2;

function computeScore(cosine: number, strength: number, importance: number): number {
  return cosine * (1 + STRENGTH_WEIGHT * strength + IMPORTANCE_WEIGHT * importance);
}

async function recallAtoms(index, query, atomsDir, options) {
  const emb = await embedText(query);
  if (!emb) return [];

  const perType: Record<MemoryAtomType, RecallResult[]> = { rule: [], fact: [], process: [] };
  for (const type of TYPES) {
    if (options.filter?.type && options.filter.type !== type) continue;
    const raw = index.vectorSearch(emb, RAW_BUFFER, { type, isLatestOnly: true, archived: false });
    for (const { id, distance } of raw) {
      const atom = index.getAtom(id);
      if (!atom) continue;
      const cosine = 1 - (distance * distance) / 2;
      if (cosine < THRESHOLD) continue;
      const score = computeScore(cosine, atom.strength, atom.importance);
      perType[type].push({ atom, distance, cosine, score });
    }
    perType[type].sort((a, b) => b.score - a.score);  // score DESC
    perType[type] = perType[type].slice(0, PER_TYPE_CAP);
  }

  // Round-robin interleave (sparse types skipped)
  const result: RecallResult[] = [];
  for (let i = 0; i < PER_TYPE_CAP; i++) {
    for (const type of TYPES) {
      const item = perType[type][i];
      if (item) result.push(item);
    }
  }
  return result;
}
```

**注意**:
- `formatMemoryContext` 后续再做 `sorted = [...results].sort((a, b) => a.distance - b.distance)`(distance asc),所以**最终注入 LLM prompt 的顺序按 cosine 单键**(等价于 score,因为 cosine 是主乘数,prompt 里无法看到 strength/importance 影响)。score **仅影响** search response(给 UI / 调试看)。
- rule type 的 strength 永远 = importance(永不衰减),所以 rule 的 score 公式可以简化为 `cosine * (1 + 0.5 * importance)`,但代码里用通用公式即可,简化在 fact/process 上才体现价值。
- 权重 α=0.3, β=0.2 暂时 hardcode。未来如果需要调整,改成 `RecallOptions` 的可调参数,默认值同上。
- **新加字段**: `RecallResult.score: number` 暴露给 search response(给 UI / debug / 测试 snapshot 用)。LLM 看不到(不在 `formatMemoryBlock` 里)。

### 9. runDecay 现有行为不变,作为"遗忘强度 → 清理"的后台机制
**Decision**: 不修改 `runDecay` 的现有公式或阈值:
- `baseDecay = 0.05`, `archiveThreshold = 0.1`
- `strength_new = strength_old * exp(-λ * deltaDays / max(0.1, importance))`
- rule type 永不 archive
- 非 rule type: strength < 0.1 时 archive

**Rationale**: 
- 现有的 decay 公式已经实现了"遗忘 → 清理"完整链条
- `runDecay` 1 小时 throttle 一次,不会频繁 hit DB
- 新的加权公式(score = cosine × (1 + 0.3×strength + 0.2×importance))自然利用 strength 衰减信号 — strength 下降 → score 下降 → search 排名下降 → 进一步 decay → 最终 archive
- **重要:score 公式让 `strength` 的衰减有了"显式可见"的效果** — search ranking 反映遗忘进度,不只是后台默默归档
- 用户明确指示"保持现有 runDecay 不动",所以本 change 不修改 decay 逻辑

**Alternatives considered**:
- A. 提高 archiveThreshold 到 0.2 — 拒绝,用户已选保持现状
- B. 加 importance 阈值 — 拒绝,用户已选保持现状
- C. **本方案:runDecay 完全不动** — 选这个,新 score 公式自动利用 strength 信号,feedback 循环自然形成

## Architecture

### 组件

```
┌──────────────────────────────────────────────────────────────┐
│                   Agent Process (TUI/CLI)                    │
│                                                              │
│  ┌──────────────┐     ┌──────────────────┐                   │
│  │ LLM Agent    │────▶│ memory_get tool  │                   │
│  │              │◀────│ (registerTool)   │                   │
│  └──────┬───────┘     └─────────┬────────┘                   │
│         │                       │                            │
│         │                       │ updateAccess + readAtom    │
│         ▼                       ▼                            │
│  ┌──────────────┐     ┌──────────────────┐                   │
│  │ before_agent │     │ MemoryIndex +    │                   │
│  │ _start hook  │     │ better-sqlite3   │                   │
│  │              │     │ + sqlite-vec     │                   │
│  │ recallAtoms  │     └──────────────────┘                   │
│  │ (no bump)    │                                           │
│  └──────┬───────┘                                           │
│         │ formatMemoryContext                                │
│         ▼                                                   │
│  ┌──────────────┐                                           │
│  │ context hook │──▶ [User message with memory context]     │
│  └──────────────┘                                           │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │ ~/.pi/agent/     │
                    │ memory/memory.db │
                    │ + atoms/<type>/  │
                    │   <id>.md        │
                    └──────────────────┘
                              ▲
                              │
┌─────────────────────────────┴───────────────────────────────┐
│                   WebUI Process (8742)                      │
│                                                              │
│  ┌──────────────┐     ┌──────────────────┐                   │
│  │ React UI     │────▶│ GET /:id         │── preview only,   │
│  │ MemoryEditor │◀────│ (no updateAccess)│   no bump         │
│  └──────────────┘     └──────────────────┘                   │
│                                                              │
│  ┌──────────────┐     ┌──────────────────┐                   │
│  │ SearchTester │────▶│ POST /search     │── no bump,        │
│  │              │◀────│ (no file_path)   │   no feedback      │
│  └──────────────┘     └──────────────────┘                   │
└──────────────────────────────────────────────────────────────┘
```

### 关键类型变更

```ts
// extensions/personal-assistant/types.ts (DELETE file_path, ADD score to RecallResult)
export interface RecallResult {
  atom: MemoryAtom;
  distance: number;
  cosine: number;
  /**
   * 加权综合分 = cosine × (1 + 0.3 × strength + 0.2 × importance)。
   * 用于 per-type 内部排序 + search response 暴露给 UI/debug。
   * 不注入 LLM prompt —— `formatMemoryContext` 后续按 distance asc 全局排序,
   * 相当于只看 cosine 主键。
   */
  score: number;
  // file_path: string;  // REMOVED — LLM uses memory_get(id) instead
}
```

```ts
// extensions/personal-assistant/search.ts (NEW signature)
export async function recallAtoms(
  index: MemoryIndex,
  query: string,
  atomsDir: string,  // kept for compatibility but unused now
  options: RecallOptions = {},
): Promise<RecallResult[]> {
  // Per-type KNN: 3 × vectorSearch(embedding, topK*2, {type: X})
  // Each type → top-3 by score = cosine × (1 + 0.3×strength + 0.2×importance)
  // Round-robin interleave, sparse types skipped
  // NO updateAccess (search is pure retrieval)
  // NO file_path in result, ADD score in result
}
```

```ts
// extensions/personal-assistant/memory.ts (NEW tool registration)
pi.registerTool({
  name: "memory_get",
  label: "Memory Get",
  description: "Fetch full content of a memory atom by id. Use after recall surfaces a relevant atom to read the complete body. Triggers strength feedback.",
  parameters: Type.Object({
    id: Type.String({ format: "uuid" }),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<unknown>> {
    const index = new MemoryIndex(dbPath);
    await index.init();
    try {
      const atom = index.getAtom(params.id);
      if (!atom) {
        return {
          content: [{ type: "text", text: "atom not found" }],
          details: { error: "atom not found", id: params.id },
        };
      }
      index.updateAccess(params.id);  // ← the ONE bump entry point
      const file = await readAtomFromFile(
        path.join(atomsDir, atom.type, `${atom.id}.md`),
        atom.content_fingerprint,
      );
      return {
        content: [{ type: "text", text: JSON.stringify({ ...atom, content: file?.atom.content ?? "" }) }],
        details: { id: params.id, bumped: true },
      };
    } finally {
      index.close();
    }
  },
});
```

```ts
// extensions/personal-assistant/format.ts (CHANGE block layout)
export function formatMemoryBlock(result: RecallResult): string {
  const { atom } = result;
  return `[${atom.type}] ${atom.title}\n${atom.summary}\nid: ${atom.id}\nTags: ${atom.tags.join(", ")}`;
}
```

```ts
// extensions/personal-assistant/extraction.ts (NEW scoreUserTone + prompt injection)
const STRONG_WORDS = ["千万", "务必", "必须", "一定", "绝对", "切记", "严禁", "禁止", "must", "always", "never"];
const HABIT_WORDS  = ["总是", "永远", "一直", "不要", "记得", "每次", "别"];
const WEAK_WORDS   = ["可能", "也许", "大概", "试试", "如果", "maybe", "perhaps"];

export function scoreUserTone(messages: Array<{ role: string; content: string }>): { level: "strong" | "habit" | "neutral" | "weak"; score: number } {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const text = lastUser?.content ?? "";
  if (STRONG_WORDS.some((w) => text.includes(w))) return { level: "strong", score: 0.95 };
  if (HABIT_WORDS.some((w) => text.includes(w))) return { level: "habit", score: 0.85 };
  if (WEAK_WORDS.some((w) => text.includes(w))) return { level: "weak", score: 0.35 };
  return { level: "neutral", score: 0.5 };
}

function buildExtractionPrompt(messages) {
  const tone = scoreUserTone(messages);
  const toneHint = `\n\n<user_tone level="${tone.level}" score="${tone.score}">\n` +
    (tone.level === "strong" ? "User's message contains emphatic language. Atoms reflecting these emphatic preferences should have importance >= 0.9." :
     tone.level === "habit" ? "User's message contains habit-style language. Atoms reflecting habitual patterns should have importance >= 0.7." :
     tone.level === "weak" ? "User's message contains tentative language. Atoms should have importance <= 0.5." :
     "No strong tone indicators. Default importance 0.5.") +
    "\n</user_tone>";
  return `${EXTRACT_PROMPT_V2}${toneHint}\n\n## Messages\n\n${messagesText}\n\n## Output (JSON only)`;
}
```

### 数据流

**Search 路径** (无 bump):
```
LLM: search("lima 拆分有问题")
   ↓
recallAtoms(index, query, atomsDir)
   ↓
3 × vectorSearch(embedding, topK*2, {type: X})
   ↓ (per type: top-3 cosine ≥ 0.5)
9 RecallResult [{id, type, title, summary, tags, distance, cosine}]
   ↓
POST /api/memory/search response
   ↓
LLM 看到 candidates + id,选感兴趣的
```

**Get 路径** (bump):
```
LLM: memory_get({id: "abc-123"})
   ↓
memory_get tool execute
   ↓
index.getAtom(id) + index.updateAccess(id) + readAtomFromFile(...)
   ↓
{...atom, content: "..."} 返回给 LLM
   ↓
DB: access_count += 1, last_access = now
```

**Tone 路径** (extraction 时):
```
extraction trigger (session_before_compact or POST /extract)
   ↓
buildExtractionPrompt(messages)
   ↓
scoreUserTone(messages) → {level, score}
   ↓
EXTRACT_PROMPT_V2 + <user_tone>...</user_tone> + messages
   ↓
LLM 看到 hint,自主决定 importance
   ↓
importance: 0.85+ (强语气) | 0.5 (中性) | 0.3-0.4 (弱语气)
   ↓
executePlan → atom 写入 DB
```

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| search 删 `file_path` 是 breaking change,旧代码/测试引用会报错 | 一次性同步改 search.ts / types.ts / format.ts / routes/memory.ts / SearchTester.tsx + 4 个测试文件,不留中间态 |
| Agent 不一定会用 `memory_get`,可能继续用 `read(path)` | EXTRACT_PROMPT_V2 不变,但 `system prompt` 由 pi 列出所有 tool 时会包含 memory_get,LLM 会看到。后续观察 LLM 使用习惯,必要时在 system prompt 加 hint |
| `scoreUserTone` 纯词表匹配,某些上下文会误判(如"如果"在"如果下雨"和"如果你能帮我"中不同) | 当前接受这层精度损失,LLM 还有一次机会修正 importance。如果未来需要更高精度,加 LLM 二次 prompt 评分 |
| 3 个独立 `vectorSearch` 比 1 个稍慢 | 每个 vectorSearch 是毫秒级,3 个总和 < 5ms,实测可接受 |
| `memory_get` tool 只在 extension 注册,TUI 用户能直接用,但如果某天 webui 也想 bump,需要新加端点 | 当前不做,YAGNI;后续有需求再加 `POST /api/memory/:id/feedback` 端点 |
| `scoreUserTone` 用 `text.includes(w)` 简单匹配,长字符串 + 短词容易误触(如"也许"出现在"也不许"中) | 当前接受,词表精简到 ~20 词,且只有 STRONG/HABIT 档才有实际权重影响(都 ≥ 0.7) |
| 加权公式 score = cosine × (1 + 0.3×strength + 0.2×importance) 的权重 α=0.3 β=0.2 是 hardcode 的经验值,可能不是全局最优 | 当前接受,YAGNI;如未来需要调,改成 `RecallOptions` 可调参数,默认值同上。score 字段已经在 response 里,便于 A/B 调权重 |
| 加权公式让 rule type 在 search 中更显(rule importance 普遍 ≥ fact/process),可能让 rule 过度代表 | 接受(符合"用户偏好/约束是最高优先级"的直觉);如果发现 rule 偏斜过度,可降低 β(importance weight)或单独调权重 |
| `score` 字段暴露在 search response 里,但 LLM 看不见 — 字段可能让 API 消费者误以为 LLM 也能用 | 在 search route 的 doc comment 和 types.ts 的 JSDoc 明确说 "score 仅给 UI/debug,LLM 不通过 prompt 看到" |
| 新加权公式与现有 `runDecay` 的交互未充分测试 — 不同 strength/importance 组合下的 score 行为需要回归验证 | 测试覆盖 5+ 个 weighted formula scenarios(见 scenarios.md),包括正常 / 边界 / 极端值 |

## Testing Strategy

**单元测试**:
- `extensions/personal-assistant/test/search.test.ts`:
  - search 不调用 `updateAccess`(mock 后断言 0 次调用)
  - per-type top-3 在 6 atom DB(2 rule + 3 fact + 1 process)上 → 返回 6 个(2+3+1,稀疏 process 自动降到 1)
  - per-type 全空 → 该 type 不出现在 results
  - response 不含 `file_path` 字段,**含** `score` 字段
  - **加权公式 score = cosine × (1 + 0.3×strength + 0.2×importance)**:5 个测试用例覆盖正常 / 边界 / 极端值
  - **round-robin 交错**:3 type × 3 cap 满员时位置正确,稀疏 type 跳过对应槽位
  - **加权公式覆盖**:
    - atom A(cosine=0.7, strength=1.0, importance=1.0)→ score = 0.7 × 1.5 = 1.05
    - atom B(cosine=0.7, strength=0.0, importance=0.0)→ score = 0.7 × 1.0 = 0.7
    - cosine=0 → score=0(无论 strength/importance 多高)
    - cosine=1 → score=1.5(满分 atom 上限)
  - **加权公式 vs cosine 主导性**: cosine 0.6/strength=1.0/importance=1.0 (score=0.9) vs cosine 0.85/strength=0.1/importance=0.1 (score=0.8925) — 后者嬴,验证 cosine 仍是主键
- `extensions/personal-assistant/test/format.test.ts`:
  - `formatMemoryBlock` 输出含 `id:` 行,**不**含 `file:` 行
  - `formatMemoryContext` 仍按 distance 排序,token budget 限制生效
- `extensions/personal-assistant/test/extraction.test.ts`(新增):
  - `scoreUserTone` 5 个测试消息:强("千万记住")/习惯("总是")/中性("今天做下")/弱("试试看")/空 → 各自返回正确 `{level, score}`
  - `buildExtractionPrompt` 注入 `<user_tone>` 段
- `extensions/personal-assistant/test/memory-tool.test.ts`(新增):
  - `memory_get` tool 注册成功(`pi.registerTool` 被调用 1 次,参数含 `name: "memory_get"`)
  - tool execute 成功:index.updateAccess 被调用 1 次 + 返回 atom + content
  - tool execute 失败:id 不存在时返回 error,index.updateAccess 不调用
- `extensions/personal-assistant/test/types.test.ts`: 删除 `tier` 相关断言,加 `file_path` 不存在的断言

**集成测试**:
- `packages/webui/server/test/memory-routes.test.ts`:
  - `POST /api/memory/search` response shape 验证(无 `file_path` / `formattedText` / `tier`)
  - `GET /api/memory/:id` 2 次调用,DB 中 `access_count` 保持 0(验证 webui preview 不 bump)
  - 已有 45 个 case 全部继续通过

**回归**:
- `npm run check` 绿(657 files biome check)
- 348 个 personal-assistant 单元测试全过(已通过 18/18 format + search + types 已验证)
- 216 个 webui server 测试全过(已验证)

**E2E**(可选,若时间允许):
- 用 chromedevtools 在 webui 触发 search,确认 UI 不展示 file_path
- 模拟 agent 调 memory_get,验证 DB `access_count` +1

## Implementation Notes

**依赖顺序**(sdd-develop 阶段按此顺序实现):
1. `types.ts` — 删 `RecallResult.file_path`
2. `search.ts` — 改 per-type top-3,删 `updateAccess`
3. `format.ts` — block 改 `id:` 行
4. `extraction.ts` — 加 `scoreUserTone` + 注入 prompt
5. `memory.ts` — 注册 `memory_get` tool + context hook 调用方式调整
6. `routes/memory.ts` — search response 删 `file_path`,GET /:id 不 bump
7. `SearchTester.tsx` — 删 file_path 展示
8. 4 个 test 文件同步改 + 2 个新 test 文件

**风险点**:
- `pi.registerTool` 的 signature 需要看 `packages/coding-agent/src/core/extensions/types.ts:1170` 确认 `parameters` 用 TypeBox Type.Object
- tool execute 返回格式必须符合 `AgentToolResult<T>` = `{content: (TextContent|ImageContent)[], details: T}`,需要 `import type { AgentToolResult } from "@earendil-works/pi-agent-core"`(参考 `packages/coding-agent/examples/extensions/subagent/index.ts:19`)
- tool execute 签名是 `(toolCallId, params, signal, onUpdate, ctx) => Promise<AgentToolResult<T>>`,不需要 streaming 时可以 throw away `toolCallId/signal/onUpdate/ctx`(_前缀)
- extraction.ts 现有 `buildExtractionPrompt` 是 private function,需要 export 或加 wrapper 以便测试

**TDD 节奏**:
- 每个 source file 改之前先写测试(RED),改之后让测试过(GREEN),最后 refactor
- tests 不能跳过:这个 change 有 breaking API,test 是防止回归的关键

**CHANGELOG 更新**(sdd-archive 阶段):
- `extensions/personal-assistant/CHANGELOG.md`:Breaking Changes 段(删 file_path、新增 memory_get tool、search 不 bump)
- `packages/webui/CHANGELOG.md`:Changed 段(SearchTester 不显示 file_path,GET /:id 不 bump) + Breaking Changes(同上)
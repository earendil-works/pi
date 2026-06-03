# Delta 规格: Pi 个人助手

## MODIFIED

### packages/coding-agent/src/core/settings-manager.ts
**变更**: 新增 `PersonalAssistantConfig` 接口族
```typescript
interface PersonalAssistantAgentConfig {
  provider?: string;      // "" = 继承 Pi 默认
  model?: string;
  thinking?: string;
  max_tokens?: number;
  temperature?: number;
}

interface PersonalAssistantConfig {
  agent?: PersonalAssistantAgentConfig;
  subagent?: {
    provider?: string;
    model?: string;
    max_iterations?: number;
    max_parallel?: number;
  };
  memory?: {
    enabled?: boolean;
    query_rewrite?: { provider?: string; model?: string };
    extraction?: { provider?: string; model?: string };
    embedding?: { model?: string; api_base?: string };
    decay?: { base_decay?: number; archive_threshold?: number };
    injection?: { max_count?: number };
  };
  search?: {
    provider?: string;    // "tavily" | "duckduckgo" | "brave" | "searxng" | "jina" | "kagi"
    api_key?: string;
    max_results?: number;
    timeout?: number;
    base_url?: string;
  };
  persona?: {
    soul_path?: string;   // "" = <fork>/SOUL.md
    user_path?: string;   // "" = <fork>/USER.md
  };
}

// Settings 接口追加
interface Settings {
  // ... 现有字段 ...
  personalAssistant?: PersonalAssistantConfig;
}
```
所有字段 optional, 空 = 继承 Pi 默认。merge 规则: 全局 -> 项目 (已有 deepMergeSettings)。

### packages/coding-agent/src/core/extensions/loader.ts
**变更**: `discoverAndLoadExtensions()` 新增第 4 个 discovery 源
**行为**:
- 从 loader.ts `__dirname` 向上推算 repo root
- 若 `<repo-root>/extensions/` 存在, 扫描其中的扩展
- 发现规则同 `.pi/extensions/`: 单文件 `*.ts` / `index.ts` / `package.json pi manifest`
- 优先级: `repo-extensions < project < global < explicit`

### ~/.pi/agent/settings.json
**变更**: 新增可选 `personalAssistant` 段

---

## ADDED

### extensions/personal-assistant/index.ts
**主入口**: 导出 `[memoryExtension, toolsExtension, cronExtension]`
**规则**: 每个 extension 导出 default function, 按 Pi 扩展规范

### extensions/personal-assistant/memory.ts
**来源**: `nanobot/memory/atom.py + memory_index.py + inject.py + query.py + memory_extractor.py + decay_task.py`
**不注册任何工具**。

**事件订阅**:

| 事件 | 处理 |
|------|------|
| `session_start` | init SQLite WAL, 运行衰减检查 (>6h) |
| `before_agent_start` | SOUL+USER 注入 + 记忆注入 |
| `session_before_compact` | 记忆提取 |

**数据模型**:

```
MemoryAtom {
  id: string (uuid)
  type: "constraint" | "preference" | "workflow" | "knowledge" | "event" | "solution" | "insight"
  title: string        // <=10 字
  summary: string      // <=150 tokens
  content: string      // 完整 MD body
  tags: string[]
  importance: float    // 0-1
  strength: float      // 0-1, default 1
  access_count: int
  last_access: datetime
  created_at: datetime
  updated_at: datetime
  version: int
  source_msg_ids: string[]
}
```

**文件布局**:

```
~/.pi/agent/data/
├── memory.db                    # SQLite: memory_index + memory_fts
└── memory/
    ├── atoms/{type}/{slug}.md   # YAML frontmatter + MD body
    ├── reports/
    │   ├── extract-{ts}.md     # 提取报告
    │   └── decay-{ts}.md       # 衰减报告
    └── archive/{type}/{slug}.md # 归档记忆
```

**检索算法**:

```
1. FTS5 BM25: memory_fts MATCH "kw1" "kw2" + type filter -> BM25 score
2. Embedding (可选): POST Ollama /api/embeddings -> cosine similarity
3. Hybrid = (0.5 x FTS5_norm + 0.5 x cosine_norm) x (0.5 + 0.3 x strength + 0.2 x importance)
4. 按 hybrid 降序取 top_k
5. _update_access() 更新 access_count + last_access
```

**衰减公式**:

```
lambda = base_decay x (1 - importance)
denominator = 1 + 0.3 x ln(1 + access_count + 2)
strength_new = strength x exp(-lambda x delta_days / denominator)
archive if: type != "constraint" AND strength_new < archive_threshold
```

### extensions/personal-assistant/tools.ts
**来源**: `nanobot/agent/todo.py + tools/search.py + tools/web.py`

| 工具 | 参数 | 功能 |
|------|------|------|
| `todo_write` | `{todos: [{action,content?,id?,priority?,category?}], merge: bool}` | 待办批量管理 |
| `web_search` | `{query, max_results?}` | 网页搜索 |
| `web_fetch` | `{url, max_length?}` | 网页抓取 |

### extensions/personal-assistant/cron.ts
**来源**: `nanobot/cron/service.py + types.py`

| 工具 | 参数 | 功能 |
|------|------|------|
| `cron_write` | `{operations: [{action,name?,schedule?,prompt?,id?,enabled?}], merge: bool}` | 定时任务批量管理 |

**schedule 格式**: `{kind:"at",time:"09:00"}` | `{kind:"every",interval:3600}` | `{kind:"cron",expr:"0 9 * * 1-5",tz:"Asia/Shanghai"}`

### SOUL.md
**来源**: `nanobot/templates/SOUL.md`
**位置**: `<fork>/SOUL.md`
**内容**: 助手身份 + 核心原则 + 执行规则

### USER.md
**来源**: `nanobot/templates/USER.md`
**位置**: `<fork>/USER.md`
**内容**: 用户信息 + 偏好 + 工作上下文

### skills/ (可选)
**来源**: `nanobot/skills/`
**位置**: `<fork>/skills/`
**包含**: weather, frontend-slides, frontend-design, skill-creator

### prompts/ (可选)
**位置**: `<fork>/prompts/`
**包含**: remember.md, todo.md, weekly.md, summary.md

## REMOVED
(无)

# Pi Agent 定制化指南

> 本文档介绍如何基于 Pi Agent 进行个性化定制，使其成为你的专属 AI 编程助手。

---

## 目录

1. [定制化体系概览](#1-定制化体系概览)
2. [扩展 (Extensions)](#2-扩展-extensions)
3. [技能 (Skills)](#3-技能-skills)
4. [提示模板 (Prompt Templates)](#4-提示模板-prompt-templates)
5. [主题 (Themes)](#5-主题-themes)
6. [自定义模型 (Custom Models)](#6-自定义模型-custom-models)
7. [自定义 Provider](#7-自定义-provider)
8. [Pi 包 (Pi Packages)](#8-pi-包-pi-packages)
9. [实战示例](#9-实战示例)
10. [最佳实践](#10-最佳实践)

---

## 1. 定制化体系概览

Pi Agent 的定制化分为以下几个层次：

```
┌─────────────────────────────────────────┐
│           最高层：SDK 集成               │
│      (把 pi 嵌入你的应用程序)              │
├─────────────────────────────────────────┤
│           Pi 包 (分发格式)                │
│      (打包扩展/技能/模板/主题)             │
├─────────────────────────────────────────┤
│         自定义 Provider                   │
│      (自定义 API 实现/OAuth)              │
├─────────────────────────────────────────┤
│           自定义模型                      │
│        (添加本地模型/Ollama)              │
├─────────────────────────────────────────┤
│           扩展 (Extensions)              │
│    (核心定制：工具/命令/事件拦截)           │
├─────────────────────────────────────────┤
│         技能 (Skills)                    │
│         (专业工作流包)                    │
├─────────────────────────────────────────┤
│         提示模板 (Templates)             │
│         (快捷提示片段)                    │
├─────────────────────────────────────────┤
│         主题 (Themes)                    │
│         (外观颜色定制)                    │
└─────────────────────────────────────────┘
```

### 资源加载顺序

Pi 按以下顺序查找资源（后者覆盖前者）：

| 顺序 | 位置 | 说明 |
|------|------|------|
| 1 | 内置资源 | pi 内置的工具、模板 |
| 2 | 全局资源 | `~/.pi/agent/` |
| 3 | 项目资源 | `.pi/` |

---

## 2. 扩展 (Extensions)

扩展是 Pi 定制化的**核心方式**，可以：
- 订阅生命周期事件
- 注册自定义工具
- 注册命令
- 拦截和修改工具调用
- 与 UI 交互

### 2.1 快速开始

创建文件 `~/.pi/agent/extensions/my-extension.ts`：

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  // 监听 session 启动
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("扩展已加载!", "info");
  });

  // 注册工具
  pi.registerTool({
    name: "greet",
    label: "打招呼",
    description: "向某人打招呼",
    parameters: Type.Object({
      name: Type.String({ description: "要打招呼的名字" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return {
        content: [{ type: "text", text: `你好, ${params.name}!` }],
        details: {},
      };
    },
  });

  // 注册命令
  pi.registerCommand("hello", {
    description: "打招呼命令",
    handler: async (args, ctx) => {
      ctx.ui.notify(`你好 ${args || "世界"}!`, "info");
    },
  });

  // 拦截危险操作
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
      const ok = await ctx.ui.confirm("危险操作", "确定要执行 rm -rf 吗？");
      if (!ok) return { block: true, reason: "被用户阻止" };
    }
  });
}
```

**测试方式：**

```bash
# 临时测试
pi -e ./my-extension.ts

# 永久生效（放入扩展目录后）
pi
# 或重启 pi 后自动加载
```

### 2.2 扩展位置

| 位置 | 范围 |
|------|------|
| `~/.pi/agent/extensions/*.ts` | 全局（所有项目） |
| `.pi/extensions/*.ts` | 项目本地 |
| `pi -e ./path.ts` | 临时测试 |

**目录结构（多文件扩展）：**

```
~/.pi/agent/extensions/
└── my-extension/
    ├── index.ts        # 入口（导出默认函数）
    ├── tools.ts        # 工具定义
    └── utils.ts        # 工具函数
```

### 2.3 可用导入

| 包 | 用途 |
|----|------|
| `@earendil-works/pi-coding-agent` | 扩展类型（ExtensionAPI、ExtensionContext、事件） |
| `typebox` | 工具参数 schema 定义 |
| `@earendil-works/pi-ai` | AI 工具（StringEnum 等） |
| `@earendil-works/pi-tui` | TUI 组件（自定义渲染） |

### 2.4 事件系统

#### 生命周期流程图

```
pi 启动
  │
  ├─► session_start { reason: "startup" }
  └─► resources_discover
  
用户发送 prompt ──────────────────────────────────────────┐
  │                                                        │
  ├─► (扩展命令优先检查)                                  │
  ├─► input (可拦截/转换/处理)                            │
  ├─► before_agent_start (可注入消息/修改系统提示)        │
  ├─► agent_start                                        │
  ├─► message_start / message_update / message_end        │
  │                                                        │
  │   ┌─── turn (LLM 调用工具时重复) ───────────────┐    │
  │   │                                            │      │
  │   ├─► turn_start                              │      │
  │   ├─► context (可修改消息)                     │      │
  │   ├─► before_provider_request                 │      │
  │   ├─► after_provider_response                │      │
  │   │   LLM 响应，可能调用工具：                │      │
  │   │     ├─► tool_execution_start             │      │
  │   │     ├─► tool_call (可阻止)              │      │
  │   │     ├─► tool_execution_update           │      │
  │   │     ├─► tool_result (可修改结果)        │      │
  │   │     └─► tool_execution_end              │      │
  │   └─► turn_end                              │      │
  └─► agent_end                                          │
                                                          │
用户发送下一个 prompt ◄────────────────────────────────────┘
```

#### 事件分类表

| 类别 | 事件 | 说明 |
|------|------|------|
| **Session** | `session_start` | 会话启动 |
| | `session_before_switch` | 切换会话前（可取消） |
| | `session_before_fork` | Fork 会话前（可取消） |
| | `session_before_compact` | 压缩前（可取消/自定义） |
| | `session_compact` | 压缩完成 |
| | `session_before_tree` | 树导航前（可取消） |
| | `session_tree` | 树导航完成 |
| | `session_shutdown` | 会话关闭 |
| **Agent** | `before_agent_start` | Agent 启动前（可注入消息） |
| | `agent_start` | Agent 启动 |
| | `agent_end` | Agent 结束 |
| | `turn_start` | Turn 开始 |
| | `turn_end` | Turn 结束 |
| | `context` | 每次 LLM 调用前（可修改消息） |
| | `before_provider_request` | 发送请求前 |
| | `after_provider_response` | 收到响应后 |
| **Message** | `message_start` | 消息开始 |
| | `message_update` | 消息更新（流式） |
| | `message_end` | 消息结束（可替换） |
| **Tool** | `tool_execution_start` | 工具开始执行 |
| | `tool_execution_update` | 工具执行更新 |
| | `tool_call` | 工具调用前（可阻止） |
| | `tool_result` | 工具结果（可修改） |
| | `tool_execution_end` | 工具执行结束 |
| **Model** | `model_select` | 模型选择 |
| | `thinking_level_select` | 思考级别选择 |
| **Input** | `input` | 用户输入（可拦截/转换） |
| | `user_bash` | 用户执行 bash（`!` 或 `!!`） |
| **Resource** | `resources_discover` | 资源发现 |

### 2.5 ExtensionContext

所有事件处理器接收的上下文对象。

```typescript
interface ExtensionContext {
  // UI 交互
  ui: ExtensionUIContext;
  
  // 是否有 UI（print/RPC 模式为 false）
  hasUI: boolean;
  
  // 当前工作目录
  cwd: string;
  
  // 会话状态访问（只读）
  sessionManager: ReadonlySessionManager;
  
  // 模型注册表
  modelRegistry: ModelRegistry;
  
  // 当前模型
  model: Model | undefined;
  
  // === 控制流 ===
  isIdle(): boolean;               // Agent 是否空闲
  signal: AbortSignal | undefined; // 当前 abort 信号
  abort(): void;                   // 中止当前操作
  hasPendingMessages(): boolean;    // 是否有待处理消息
  
  shutdown(): void;                // 请求关闭 pi
  getContextUsage(): ContextUsage | undefined;  // 上下文使用量
  compact(options?: CompactOptions): void;     // 触发压缩
  getSystemPrompt(): string;       // 获取当前系统提示
}
```

### 2.6 ExtensionCommandContext

命令处理器接收的上下文，继承自 ExtensionContext，并增加会话控制方法。

```typescript
interface ExtensionCommandContext extends ExtensionContext {
  waitForIdle(): Promise<void>;   // 等待 Agent 空闲
  newSession(options?): Promise<{ cancelled: boolean }>;  // 新建会话
  fork(entryId: string, options?): Promise<{ cancelled: boolean }>;  // Fork
  navigateTree(targetId: string, options?): Promise<{ cancelled: boolean }>;  // 树导航
  switchSession(sessionPath: string, options?): Promise<{ cancelled: boolean }>;  // 切换会话
  reload(): Promise<void>;        // 重新加载扩展
}
```

### 2.7 ExtensionAPI

扩展的入口对象，提供所有注册方法。

```typescript
interface ExtensionAPI {
  // === 事件订阅 ===
  on(event: string, handler: ExtensionHandler): void;
  
  // === 注册 ===
  registerTool(definition: ToolDefinition): void;
  registerCommand(name: string, options: CommandOptions): void;
  registerShortcut(shortcut: string, options: ShortcutOptions): void;
  registerFlag(name: string, options: FlagOptions): void;
  
  // === 消息渲染 ===
  registerMessageRenderer(customType: string, renderer: MessageRenderer): void;
  
  // === 动作 ===
  sendMessage(message, options?): void;
  sendUserMessage(content, options?): void;
  appendEntry(customType: string, data?): void;
  
  // === 会话元数据 ===
  setSessionName(name: string): void;
  setLabel(entryId: string, label: string): void;
  
  // === 工具控制 ===
  getActiveTools(): string[];
  getAllTools(): ToolInfo[];
  setActiveTools(toolNames: string[]): void;
  
  // === 模型控制 ===
  setModel(model: Model): Promise<boolean>;
  getThinkingLevel(): ThinkingLevel;
  setThinkingLevel(level: ThinkingLevel): void;
  
  // === Provider 注册 ===
  registerProvider(name: string, config: ProviderConfig): void;
  unregisterProvider(name: string): void;
  
  // === 共享事件总线 ===
  events: EventBus;
}
```

### 2.8 ctx.ui 方法

UI 交互 API。

```typescript
interface ExtensionUIContext {
  // 对话框
  select(title: string, options: string[], opts?): Promise<string | undefined>;
  confirm(title: string, message: string, opts?): Promise<boolean>;
  input(title: string, placeholder?, opts?): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  
  // 状态显示
  setStatus(key: string, text: string | undefined): void;
  setWidget(key: string, content: string[]): void;
  setTitle(title: string): void;
  
  // 自定义 TUI 组件
  custom(factory: (tui, theme, kb, done) => CustomComponent, options?): Promise<any>;
  
  // 编辑器
  pasteToEditor(text: string): void;
  setEditorText(text: string): void;
  getEditorText(): string;
  editor(title: string, prefill?): Promise<string | undefined>;
  
  // 主题
  theme: Theme;
  getAllThemes(): { name: string; path: string | undefined }[];
  getTheme(name: string): Theme | undefined;
  setTheme(theme: string | Theme): { success: boolean; error?: string };
  
  // 工具箱
  getToolsExpanded(): boolean;
  setToolsExpanded(expanded: boolean): void;
}
```

### 2.9 完整示例：安全增强扩展

```typescript
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const PROTECTED_PATHS = [".env", "node_modules/", ".git/", "secrets/"];
const DANGEROUS_COMMANDS = ["rm -rf", "sudo", "chmod 777", "mkfs"];

export default function (pi: ExtensionAPI) {
  // 1. Session 启动通知
  pi.on("session_start", async (event, ctx) => {
    ctx.ui.notify(`会话已启动: ${event.reason}`, "info");
  });

  // 2. 拦截危险命令
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    const cmd = event.input.command;

    // 检查危险命令
    for (const dangerous of DANGEROUS_COMMANDS) {
      if (cmd.includes(dangerous)) {
        const ok = await ctx.ui.confirm(
          "⚠️ 危险命令",
          `命令包含 "${dangerous}"，确定要执行吗？`
        );
        if (!ok) return { block: true, reason: "被安全扩展阻止" };
      }
    }

    // 检查受保护路径
    for (const path of PROTECTED_PATHS) {
      if (cmd.includes(path)) {
        const ok = await ctx.ui.confirm(
          "🔒 保护路径",
          `命令涉及受保护路径 "${path}"，确定要执行吗？`
        );
        if (!ok) return { block: true, reason: "受保护路径" };
      }
    }
  });

  // 3. 记录工具执行
  pi.on("tool_execution_start", async (event, ctx) => {
    ctx.ui.setStatus("tool", `执行: ${event.toolName}`);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    ctx.ui.setStatus("tool", undefined);
  });

  // 4. 修改工具结果
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === "read") {
      // 可以在这里处理读取结果
      console.log("读取完成");
    }
  });

  // 5. 模型切换通知
  pi.on("model_select", async (event, ctx) => {
    const prev = event.previousModel?.id || "无";
    const next = event.model.id;
    ctx.ui.notify(`模型切换: ${prev} → ${next}`, "info");
  });

  // 6. 注册自定义工具
  pi.registerTool({
    name: "security-check",
    label: "安全检查",
    description: "检查命令安全性",
    parameters: Type.Object({
      command: Type.String({ description: "要检查的命令" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cmd = params.command;
      const risks: string[] = [];

      for (const dangerous of DANGEROUS_COMMANDS) {
        if (cmd.includes(dangerous)) {
          risks.push(`危险命令: ${dangerous}`);
        }
      }

      for (const path of PROTECTED_PATHS) {
        if (cmd.includes(path)) {
          risks.push(`受保护路径: ${path}`);
        }
      }

      return {
        content: [{
          type: "text",
          text: risks.length === 0 
            ? "✅ 命令看起来安全" 
            : `⚠️ 风险:\n${risks.join("\n")}`
        }],
        details: { risks, safe: risks.length === 0 },
      };
    },
  });

  // 7. 注册命令
  pi.registerCommand("security-status", {
    description: "显示安全状态",
    handler: async (args, ctx) => {
      ctx.ui.notify(
        `保护路径: ${PROTECTED_PATHS.join(", ")}\n危险命令: ${DANGEROUS_COMMANDS.join(", ")}`,
        "info"
      );
    },
  });

  // 8. 上下文使用量监控
  pi.on("turn_end", async (event, ctx) => {
    const usage = ctx.getContextUsage();
    if (usage && usage.tokens > 80000) {
      ctx.ui.notify(`上下文使用量较高: ${usage.tokens} tokens`, "warning");
    }
  });
}
```

---

## 3. 技能 (Skills)

技能是**自包含的专业工作流包**，在需要时按需加载。

### 3.1 概念

- 技能提供专业化的工作流、设置说明和参考文档
- 只在描述始终在上下文中，完整说明按需加载
- 实现 [Agent Skills 标准](https://agentskills.io/specification)

### 3.2 目录结构

```
my-skill/
├── SKILL.md              # 必需：frontmatter + 指令
├── scripts/              # 辅助脚本
│   └── process.sh
├── references/           # 按需加载的详细文档
│   └── api-reference.md
└── assets/
    └── template.json
```

### 3.3 SKILL.md 格式

````markdown
---
name: brave-search
description: 通过 Brave Search API 进行网页搜索和内容提取。当需要搜索文档、查找事实或任何网页内容时使用。
---

# Brave Search

## Setup

首次使用前运行：
```bash
cd /path/to/brave-search && npm install
```

## 搜索

```bash
./search.js "查询内容"              # 基本搜索
./search.js "查询内容" --content    # 包含页面内容
```

## 提取页面内容

```bash
./content.js https://example.com
```
````

### 3.4 Frontmatter 字段

| 字段 | 必需 | 说明 |
|------|------|------|
| `name` | 是 | 1-64 字符，小写字母、数字、连字符 |
| `description` | 是 | 最多 1024 字符，描述技能用途和使用场景 |
| `license` | 否 | 许可证名称 |
| `compatibility` | 否 | 环境要求 |
| `metadata` | 否 | 任意键值对 |
| `allowed-tools` | 否 | 预批准工具列表（空格分隔） |
| `disable-model-invocation` | 否 | `true` 时对模型隐藏，只能用 `/skill:name` 调用 |

### 3.5 描述最佳实践

**好的描述：**
```yaml
description: 从 PDF 文件提取文本和表格，填写 PDF 表单，合并多个 PDF。处理 PDF 文档时使用。
```

**差的描述：**
```yaml
description: 帮助处理 PDF。
```

### 3.6 位置

| 位置 | 说明 |
|------|------|
| `~/.pi/agent/skills/` | 全局 |
| `~/.agents/skills/` | 全局（兼容其他 harness） |
| `.pi/skills/` | 项目 |
| `.agents/skills/` | 项目（向上搜索到 git 根目录） |
| npm 包 `skills/` 目录 | 包内 |

### 3.7 使用技能

```bash
/skill:brave-search           # 加载并执行
/skill:pdf-tools extract       # 加载并传参数
```

参数会追加为 `User: <args>`。

### 3.8 复用其他 Harness 的技能

在 `settings.json` 中添加：

```json
{
  "skills": [
    "~/.claude/skills",
    "~/.codex/skills"
  ]
}
```

---

## 4. 提示模板 (Prompt Templates)

模板是 Markdown 片段，输入 `/模板名` 展开为完整提示。

### 4.1 位置

| 位置 | 说明 |
|------|------|
| `~/.pi/agent/prompts/*.md` | 全局 |
| `.pi/prompts/*.md` | 项目 |
| npm 包 `prompts/` 目录 | 包内 |

### 4.2 格式

```markdown
---
description: 审查暂存的 git 变更
argument-hint: "<PR-URL>"
---
Review the staged changes (`git diff --cached`). Focus on:
- Bugs and logic errors
- Security issues
- Error handling gaps
```

- 文件名（不含扩展名）成为命令名：`review.md` → `/review`
- `argument-hint` 显示参数提示：`"<PR-URL>"` 必需参数 `"[instructions]"` 可选参数

### 4.3 参数支持

| 语法 | 说明 |
|------|------|
| `$1`, `$2`, ... | 位置参数 |
| `$@` 或 `$ARGUMENTS` | 所有参数连接 |
| `${@:N}` | 从第 N 个位置开始的参数 |
| `${@:N:L}` | 从第 N 个开始的 L 个参数 |

**示例：**

```markdown
---
description: 创建 React 组件
---
Create a React component named $1 with features: $@
```

使用：`/component Button "onClick handler" "disabled support"`

### 4.4 使用

```
/review                           # 展开 review.md
/component Button                 # 展开并传参数
/component Button "click handler" # 多个参数
```

---

## 5. 主题 (Themes)

主题是 JSON 文件，定义 TUI 的所有颜色。

### 5.1 位置

| 位置 | 说明 |
|------|------|
| `dark`, `light` | 内置主题 |
| `~/.pi/agent/themes/*.json` | 全局 |
| `.pi/themes/*.json` | 项目 |
| npm 包 `themes/` 目录 | 包内 |

### 5.2 创建主题

```bash
mkdir -p ~/.pi/agent/themes
vim ~/.pi/agent/themes/my-theme.json
```

```json
{
  "$schema": "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
  "name": "my-theme",
  "vars": {
    "primary": "#00aaff",
    "secondary": 242
  },
  "colors": {
    "accent": "primary",
    "border": "primary",
    "borderAccent": "#00ffff",
    "success": "#00ff00",
    "error": "#ff0000",
    "warning": "#ffff00",
    "muted": "secondary",
    "dim": 240,
    "text": "",
    "thinkingText": "secondary",
    "selectedBg": "#2d2d30",
    "userMessageBg": "#2d2d30",
    "userMessageText": "",
    "customMessageBg": "#2d2d30",
    "customMessageText": "",
    "customMessageLabel": "primary",
    "toolPendingBg": "#1e1e2e",
    "toolSuccessBg": "#1e2e1e",
    "toolErrorBg": "#2e1e1e",
    "toolTitle": "primary",
    "toolOutput": "",
    "mdHeading": "#ffaa00",
    "mdLink": "primary",
    "mdCode": "#00ffff",
    "mdCodeBlock": "",
    "mdCodeBlockBorder": "secondary",
    "mdQuote": "secondary",
    "toolDiffAdded": "#00ff00",
    "toolDiffRemoved": "#ff0000",
    "syntaxComment": "secondary",
    "syntaxKeyword": "primary",
    "syntaxFunction": "#00aaff",
    "syntaxString": "#00ff00",
    "thinkingOff": "secondary",
    "thinkingMinimal": "primary",
    "thinkingLow": "#00aaff",
    "thinkingMedium": "#00ffff",
    "thinkingHigh": "#ff00ff",
    "thinkingXhigh": "#ff0000",
    "bashMode": "#ffaa00"
  }
}
```

### 5.3 颜色格式

支持四种格式：

| 格式 | 示例 | 说明 |
|------|------|------|
| Hex | `"#ff0000"` | 6位 RGB |
| 256色 | `39` | xterm 256 色索引 |
| 变量引用 | `"primary"` | 引用 vars 中的定义 |
| 默认 | `""` | 终端默认色 |

### 5.4 选择主题

**方式一：** `/settings` 命令

**方式二：** `settings.json`

```json
{
  "theme": "my-theme"
}
```

**方式三：** 热重载

编辑当前激活的自定义主题文件，pi 会自动重载。

---

## 6. 自定义模型 (Custom Models)

通过 `~/.pi/agent/models.json` 添加本地模型或第三方 API。

### 6.1 最小配置（Ollama）

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "llama3.1:8b" },
        { "id": "qwen2.5-coder:7b" }
      ]
    }
  }
}
```

### 6.2 完整配置

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "llama3.1:8b",
          "name": "Llama 3.1 8B (本地)",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 32000,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

### 6.3 支持的 API 类型

| API | 说明 |
|-----|------|
| `openai-completions` | OpenAI 聊天补全（最兼容） |
| `openai-responses` | OpenAI Responses API |
| `anthropic-messages` | Anthropic Messages API |
| `google-generative-ai` | Google Generative AI |

### 6.4 Google AI Studio 示例

```json
{
  "providers": {
    "my-google": {
      "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
      "api": "google-generative-ai",
      "apiKey": "GEMINI_API_KEY",
      "models": [
        {
          "id": "gemma-4-31b-it",
          "name": "Gemma 4 31B",
          "input": ["text", "image"],
          "contextWindow": 262144,
          "reasoning": true
        }
      ]
    }
  }
}
```

### 6.5 API Key 配置

支持三种格式：

```json
{
  "apiKey": "sk-..."              // 字面值
  "apiKey": "MY_API_KEY"           // 环境变量
  "apiKey": "!security find-generic-password -ws 'anthropic'"  // Shell 命令
}
```

### 6.6 思考级别映射

```json
{
  "id": "deepseek-v4-pro",
  "reasoning": true,
  "thinkingLevelMap": {
    "minimal": null,      // 不支持
    "low": null,          // 不支持
    "medium": null,        // 不支持
    "high": "high",        // 支持
    "xhigh": "max"         // 支持
  }
}
```

---

## 7. 自定义 Provider

通过扩展的 `pi.registerProvider()` 注册自定义 Provider。

### 7.1 覆盖现有 Provider

```typescript
// 路由到代理
pi.registerProvider("anthropic", {
  baseUrl: "https://proxy.example.com"
});

// 添加自定义头
pi.registerProvider("openai", {
  headers: {
    "X-Custom-Header": "value"
  }
});
```

### 7.2 注册新 Provider

```typescript
pi.registerProvider("my-llm", {
  baseUrl: "https://api.my-llm.com/v1",
  apiKey: "MY_LLM_API_KEY",
  api: "openai-completions",
  models: [
    {
      id: "my-llm-large",
      name: "My LLM Large",
      reasoning: true,
      input: ["text", "image"],
      cost: { "input": 3.0, "output": 15.0, "cacheRead": 0.3, "cacheWrite": 3.75 },
      contextWindow: 200000,
      maxTokens: 16384
    }
  ]
});
```

### 7.3 异步工厂函数

用于动态发现模型：

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function (pi: ExtensionAPI) {
  const response = await fetch("http://localhost:1234/v1/models");
  const payload = (await response.json()) as {
    data: Array<{
      id: string;
      name?: string;
      context_window?: number;
      max_tokens?: number;
    }>;
  };

  pi.registerProvider("local-openai", {
    baseUrl: "http://localhost:1234/v1",
    apiKey: "LOCAL_OPENAI_API_KEY",
    api: "openai-completions",
    models: payload.data.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.context_window ?? 128000,
      maxTokens: model.max_tokens ?? 4096,
    })),
  });
}
```

### 7.4 OAuth 支持

```typescript
pi.registerProvider("corporate-ai", {
  baseUrl: "https://ai.corp.com/v1",
  api: "openai-responses",
  models: [...],
  oauth: {
    name: "Corporate AI (SSO)",
    async login(callbacks) {
      const method = await callbacks.onSelect({
        message: "选择登录方式:",
        options: [
          { id: "browser", label: "浏览器 OAuth" },
          { id: "device", label: "设备码" }
        ]
      });
      // ... 认证逻辑
    },
    async refreshToken(credentials) {
      // 刷新 token
    },
    getApiKey(credentials) {
      return credentials.access;
    }
  }
});
```

---

## 8. Pi 包 (Pi Packages)

将扩展、技能、模板、主题打包成分发单元。

### 8.1 创建 Pi 包

**方式一：package.json manifest**

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

**方式二：约定目录**

如果没有 `pi` manifest，pi 自动发现：
- `extensions/` → .ts/.js 文件
- `skills/` → 含 SKILL.md 的目录
- `prompts/` → .md 文件
- `themes/` → .json 文件

### 8.2 安装包

```bash
pi install npm:@foo/bar@1.0.0
pi install git:github.com/user/repo@v1
pi install /absolute/path/to/package
pi install ./relative/path/to/package

pi remove npm:@foo/bar
pi list
pi update
```

### 8.3 包过滤

```json
{
  "packages": [
    "npm:simple-pkg",
    {
      "source": "npm:my-package",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"],
      "themes": ["+themes/legacy.json"]
    }
  ]
}
```

---

## 9. 实战示例

### 9.1 企业内部 AI 助手

**需求：**
- 集成企业内部 API
- 敏感操作需要审批
- 使用公司主题

**实现：**

```
~/.pi/agent/
├── extensions/
│   └── enterprise/
│       ├── index.ts
│       ├── tools.ts
│       └── approval.ts
├── themes/
│   └── corporate.json
├── skills/
│   └── api-docs/
│       └── SKILL.md
└── prompts/
    └── code-review.md
```

**扩展代码（enterprise/index.ts）：**

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // 注册内部 API 工具
  pi.registerTool({
    name: "internal-search",
    label: "内部搜索",
    description: "搜索企业内部文档",
    parameters: Type.Object({
      query: Type.String(),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const results = await internalSearch(params.query);
      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
        details: {},
      };
    },
  });

  // 审批流程
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash") {
      const cmd = event.input.command;
      if (cmd.includes("deploy") || cmd.includes("delete")) {
        const approved = await ctx.ui.confirm(
          "需要审批",
          `执行命令需要审批:\n${cmd}`
        );
        if (!approved) {
          return { block: true, reason: "需要审批" };
        }
      }
    }
  });
}
```

### 9.2 教学/练习环境

**需求：**
- 限制危险操作
- 内置编程练习技能
- 简单明亮主题

**扩展（safe-learning/index.ts）：**

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BLOCKED_PATTERNS = [
  "rm -rf /",
  "dd if=",
  ":(){:|:&};:",  // Fork bomb
  "chmod -R 777",
];

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash") {
      const cmd = event.input.command;
      for (const pattern of BLOCKED_PATTERNS) {
        if (cmd.includes(pattern)) {
          return { block: true, reason: "该命令在教学环境中被禁用" };
        }
      }
      // 限制超时
      if (!event.input.timeout) {
        event.input.timeout = 60; // 默认 60 秒超时
      }
    }
  });

  pi.registerCommand("exercise", {
    description: "开始编程练习",
    handler: async (args, ctx) => {
      ctx.ui.notify("选择练习主题开始学习！", "info");
    },
  });
}
```

### 9.3 DevOps 自动化助手

**需求：**
- 集成 kubectl、Docker
- CI/CD 流水线工具
- K8s 资源操作审批

**扩展（devops/index.ts）：**

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DANGEROUS_OPS = [
  "kubectl delete",
  "kubectl drain",
  "docker system prune",
  "kubectl scale to 0",
];

export default function (pi: ExtensionAPI) {
  // 注册 DevOps 工具
  pi.registerTool({
    name: "k8s-status",
    label: "K8s 状态",
    description: "查看 Kubernetes 集群状态",
    parameters: Type.Object({
      namespace: Type.Optional(Type.String()),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const result = await exec(`kubectl get pods ${params.namespace ? `-n ${params.namespace}` : ""}`);
      return {
        content: [{ type: "text", text: result }],
        details: {},
      };
    },
  });

  // 生产环境危险操作审批
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash") {
      for (const op of DANGEROUS_OPS) {
        if (event.input.command.includes(op)) {
          // 检查是否是生产环境
          if (event.input.command.includes("production") || 
              event.input.command.includes("prod")) {
            const confirmed = await ctx.ui.confirm(
              "⚠️ 生产环境操作",
              `即将在生产环境执行: ${op}\n确定要继续吗？`
            );
            if (!confirmed) {
              return { block: true, reason: "生产环境操作需要明确确认" };
            }
          }
        }
      }
    }
  });

  // 部署后通知
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === "bash" && 
        event.input.command.includes("kubectl apply") ||
        event.input.command.includes("helm install")) {
      ctx.ui.notify("部署完成！", "success");
    }
  });
}
```

---

## 10. 最佳实践

### 10.1 扩展组织

```
~/.pi/agent/
├── extensions/
│   ├── index.ts           # 主入口（可导入其他扩展）
│   ├── security/          # 安全相关
│   ├── tools/             # 工具注册
│   └── ui/                # UI 相关
└── ...
```

**主入口示例（index.ts）：**

```typescript
import securityExtension from "./security";
import toolsExtension from "./tools";
import uiExtension from "./ui";

export default [
  securityExtension,
  toolsExtension,
  uiExtension,
];
```

### 10.2 命名规范

| 类型 | 规范 | 示例 |
|------|------|------|
| 扩展名 | kebab-case | `my-extension.ts` |
| 工具名 | snake_case | `my_tool` |
| 命令名 | kebab-case | `/my-command` |
| 技能名 | kebab-case | `code-review` |
| 主题名 | kebab-case | `nord-theme.json` |

### 10.3 错误处理

```typescript
pi.on("tool_call", async (event, ctx) => {
  try {
    // 操作
  } catch (error) {
    ctx.ui.notify(`错误: ${error.message}`, "error");
    return { block: true, reason: error.message };
  }
});
```

### 10.4 性能考虑

- 避免在事件处理器中执行耗时操作
- 使用 `ctx.signal` 支持取消
- 工具执行使用流式更新 (`onUpdate`)

```typescript
async execute(toolCallId, params, signal, onUpdate, ctx) {
  const response = await fetch(url, { signal });
  
  for await (const chunk of response.body) {
    onUpdate({ text: chunk });
  }
  
  return { content: [...], details: {} };
}
```

### 10.5 安全建议

1. **永远不信任用户输入**
2. **危险操作前始终确认**
3. **记录操作日志**
4. **限制工具能力**
5. **定期更新扩展**

### 10.6 调试技巧

```typescript
// 启用详细日志
pi.on("tool_call", async (event, ctx) => {
  console.log("[DEBUG] tool_call:", event.toolName, event.input);
});

// 在 UI 显示调试信息
ctx.ui.setStatus("debug", `Processing: ${event.toolName}`);
```

### 10.7 热重载

放入自动发现目录的扩展支持热重载：

```
/reload
```

无需重启 pi 即可重新加载扩展。

---

## 附录：常用资源位置

| 资源 | 位置 |
|------|------|
| 全局配置 | `~/.pi/agent/settings.json` |
| 自定义模型 | `~/.pi/agent/models.json` |
| 认证信息 | `~/.pi/agent/auth.json` |
| 扩展 | `~/.pi/agent/extensions/` |
| 技能 | `~/.pi/agent/skills/` |
| 模板 | `~/.pi/agent/prompts/` |
| 主题 | `~/.pi/agent/themes/` |
| 会话 | `~/.pi/agent/sessions/` |

---

## 相关文档

- [官方扩展文档](https://pi.dev/docs/latest/extensions)
- [官方技能文档](https://pi.dev/docs/latest/skills)
- [官方模板文档](https://pi.dev/docs/latest/prompt-templates)
- [官方主题文档](https://pi.dev/docs/latest/themes)
- [官方模型文档](https://pi.dev/docs/latest/models)
- [官方 Provider 文档](https://pi.dev/docs/latest/custom-provider)
- [官方包文档](https://pi.dev/docs/latest/packages)

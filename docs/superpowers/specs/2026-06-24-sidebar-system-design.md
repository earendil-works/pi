# Sidebar System Design

**Date:** 2026-06-24
**Status:** Draft
**Scope:** `packages/tui` only

## Motivation

The existing split layout implementation provides a basic two-panel view with a fixed right panel. It lacks support for multiple switchable panels (tabs), its rendering cache is based on left-panel content (wrong optimization target), and there is no mechanism for panel content to proactively trigger re-renders.

This design introduces a sidebar system that is:

- **Self-contained** within `packages/tui` — zero changes to `packages/coding-agent` or other packages
- **Tab-based** — multiple panels switchable via a top tab bar
- **Proactive refresh** — each panel controls its own update timing via `requestRender`
- **Configurable from within** — a built-in Settings panel lets users toggle and reorder tabs at runtime

## Architecture

```
TUI (tui.ts)
  ├── children: Component[]         ← 左侧主内容
  └── splitConfig.rightPanel
       └── SidebarContainer          ← packages/tui/src/sidebar.ts
             ├── Tab Bar             ← 顶部标签行
             ├── Active Panel        ← 当前激活的组件
             │    ├── SettingsPanel  ← 内置，管理 Tab 配置
             │    └── Ext Panels     ← 通过 SidebarRegistry 注册
             └── requestRender       ← 回调 → TUI.requestRender()
```

### File Changes

```
packages/tui/src/
  ├── tui.ts        ← 删 splitViewportCache, SplitLayoutConfig 加 requestRender
  ├── sidebar.ts    ← 新建: SidebarContainer + SettingPanel + SidebarRegistry
  └── index.ts      ← +3 导出

packages/tui/test/
  ├── split-layout.test.ts  ← 更新 (移除缓存后验证)
  └── sidebar.test.ts       ← 新建
```

## Detailed Design

### 1. SidebarRegistry (静态注册表)

Extensions (loaded by coding-agent) register available sidebar panels here before the UI starts.

```typescript
export interface PanelRegistration {
  id: string;
  label: string;
  create: () => Component;
}

export class SidebarRegistry {
  private static panels = new Map<string, PanelRegistration>();

  /** Register a panel. Later registrations with the same id overwrite earlier ones. */
  static register(registration: PanelRegistration): void {
    SidebarRegistry.panels.set(registration.id, registration);
  }

  /** Get all registered panels. */
  static getAll(): PanelRegistration[] {
    return [...SidebarRegistry.panels.values()];
  }

  /** Clear all registrations (for testing). */
  static clear(): void {
    SidebarRegistry.panels.clear();
  }
}
```

Usage in an extension:

```typescript
import { SidebarRegistry } from "@earendil-works/pi-tui";
import { FileTreePanel } from "./file-tree.ts";

SidebarRegistry.register({
  id: "files",
  label: "📁 文件",
  create: () => new FileTreePanel(),
});
```

### 2. TabDefinition — 配置接口

```typescript
export interface TabDefinition {
  id: string;
  label: string;
  icon?: string;
  component: Component;
}
```

### 3. SidebarContainer — 渲染容器

```typescript
export class SidebarContainer implements Component {
  private tabs: TabDefinition[] = [];
  private activeId: string | null = null;
  private requestRender: () => void;

  constructor(requestRender: () => void);

  /** Replace all tabs with a new configuration. */
  updateConfig(tabs: TabDefinition[]): void;

  /** Switch to a tab by id. No-op if id is not found. */
  switchTo(id: string): void;

  /** Get id of the currently active tab, or null if empty. */
  getActiveId(): string | null;

  // Component interface
  render(width: number): string[];
  invalidate(): void;
}
```

**Render output structure:**

```
Line 0: [ Tab1 ] │ [ Tab2 ] │ [ Tab3 ]     ← 只有 tabs.length > 1 时显示
Line 1: ─────────────────────────────         ← 分隔线
Line 2+: activeTab.component.render(width)    ← Panel 内容
```

- When only 1 tab: skip the tab bar, render content directly
- Active tab rendered with inverted/highlighted style
- Tab labels truncated if total width exceeds available space
- Tab switching via `switchTo()` triggers `invalidate()` → `requestRender()`

### 4. SettingsPanel — 内置配置面板

A built-in Panel registered by default in the library:

```typescript
export class SettingsPanel implements Component {
  constructor(
    private container: SidebarContainer,
    private requestRender: () => void
  );
}
```

- Reads `SidebarRegistry.getAll()` to discover all available panels
- Renders a list of panels with checkboxes (enabled/disabled) and ordering
- User changes take effect by calling `container.updateConfig(selectedTabs)`
- SettingsPanel is NOT registered via `SidebarRegistry`; it's a special case that always appears when the sidebar is active

**Initialization flow:**

```
SidebarRegistry  ← 扩展注册面板
       ↓
读取注册表 + 用户配置 (sidebar-config.json)
       ↓ updateConfig()
SidebarContainer  ← 开始渲染
       ↓ (SettingsPanel 作为内置 tab 加入)
用户点击 ⚙️ 设置 → switchTo("__settings__")
       ↓
SettingsPanel.render()  ← 显示配置界面
       ↓ 用户修改 → 更新配置
SidebarContainer.updateConfig(newTabs)
```

### 5. Panel Proactive Refresh

Each Panel component can receive a `requestRender` callback:

```typescript
// Via TabDefinition when building tabs
const panel = new ChatPanel();
panel.requestRender = () => { container.requestRender(); };

// Panel internally
class ChatPanel implements Component {
  requestRender?: () => void;

  onNewMessage(msg: string) {
    this.messages.push(msg);
    this.requestRender?.();  // 主动触发 TUI 重绘
  }
}
```

The callback chain:
```
panel.requestRender() → SidebarContainer.requestRender → TUI.requestRender() → doRender()
```

TUI's line-by-line diff ensures only changed rows are written to the terminal.

### 6. tui.ts Changes

**SplitLayoutConfig:**

```typescript
export interface SplitLayoutConfig {
  rightPanel: Component;
  ratio: number;
  requestRender?: () => void;  // ← 新增
}
```

**Removed:**

- `splitViewportCache` field (5 lines)
- `splitViewportCache` read/write in `applySplitToViewport` (~10 lines)
- `this.splitViewportCache = null` in `clearSplitLayout` (1 line)

**Modified:**

- `setSplitLayout(ratio, rightPanel, requestRender?)`: store `requestRender`
- `applySplitToViewport`: remove cache lookup and update, always render right panel fresh

**Net change:** ~12 lines removed, ~3 lines added.

### 7. SidebarConfig Persistence (outside tui)

The user's tab configuration can be persisted in a JSON file. The file path and read/write logic lives in the caller (e.g., coding-agent), not in tui.

Example format:

```json
{
  "version": 1,
  "tabs": [
    { "id": "files", "enabled": true },
    { "id": "chat", "enabled": true },
    { "id": "settings", "enabled": true, "builtin": true }
  ],
  "activeTab": "chat",
  "ratio": 0.6
}
```

Caller reads this, resolves enabled ids against `SidebarRegistry`, creates Component instances, and calls `container.updateConfig(selected)`.

## Data Flow Summary

```
启动时:
  Extension → SidebarRegistry.register(panel)
  Caller → new SidebarContainer(callback)
  Caller → container.updateConfig(resolvedTabs)
  Caller → tui.setSplitLayout(ratio, container, callback)

运行时:
  User clicks Tab → container.switchTo(id) → invalidate → TUI重绘
  Panel有新数据 → panel.requestRender?.() → 回调链 → TUI重绘
  用户打开设置 → switchTo("__settings__") → 修改 → updateConfig → TUI重绘

渲染循环:
  TUI.doRender()
    → render(width)        ← 左侧内容
    → applySplitToViewport  ← 合并左右, 无缓存
    → 行级 diff            ← 只写变化行
```

## Testing

### sidebar.test.ts

| Test | Description |
|------|-------------|
| SidebarContainer empty config | `render()` returns `[]` |
| Single tab | No tab bar rendered, content directly visible |
| Multiple tabs | Tab bar rendered with correct labels, active highlight |
| switchTo | Changes active tab, re-renders content |
| switchTo unknown id | No-op |
| updateConfig replaces all | Old tabs gone, new ones shown |
| Tab label truncation | Long labels are truncated with ellipsis |
| requestRender callback | Test that callback is invoked |

### SidebarRegistry tests

| Test | Description |
|------|-------------|
| register/getAll | Returns registered panels |
| Duplicate id overwrites | Later registration wins |
| clear | Empties registry |

### split-layout.test.ts updates

- Verify split layout works correctly without the cache
- Verify right panel content is rendered fresh each frame

## Future Considerations

- **Drag-to-reorder tabs**: The SettingsPanel could support drag/arrow-key reordering
- **Per-panel persistent state**: Each panel could store its own state across sessions
- **Panel lifecycle hooks**: `onActivate`/`onDeactivate` callbacks when switching tabs
- **Nested tabs**: Sub-tabs within a panel (unlikely needed)
- **Keyboard navigation**: Left/right arrow keys to switch tabs when sidebar has focus

# Architecture Proposal

## Summary
Implement spec mode as an extension in `~/.mu/agent/extensions/spec-mode/` using existing extension primitives. The extension uses `registerCommand` for slash commands, extension state storage for persistence, and context hooks for prompt injection. Visual feedback uses confirmation messages and optional footer indicator API.

## Core Extension API Additions (Minimal)

### 1. Extension State Storage
Durable per-extension state that survives reloads:

```typescript
// ExtensionApi
getExtensionState<T>(key: string): T | undefined;
setExtensionState<T>(key: string, state: T): void;
// State persisted to ~/.mu/agent/extensions/<extension-name>/state.json
```

### 2. Footer Indicator API (Optional)
Allow extensions to register footer badges:

```typescript
// ExtensionApi
registerExtensionIndicator(options: {
  id: string;                    // Unique per-extension
  label: string;               // Display text e.g., "[SPEC]"
  color: 'accent' | 'warning' | 'muted' | 'error' | 'success';
  priority?: number;           // Display order (optional)
}): void;

updateExtensionIndicator(id: string, options: Partial<IndicatorOptions>): void;
removeExtensionIndicator(id: string): void;
```

**Integration with TUI:** FooterComponent reads indicators from ExtensionManager and renders them in the footer status area.

## Extension: spec-mode

**Location:** `~/.mu/agent/extensions/spec-mode/`

**Files:**
- `index.ts` - Extension factory, registers commands, restores state
- `reminders.ts` - Mode reminder templates (spec and problem discovery)
- `verifier.ts` - Verifier agent integration (optional)

**Behavior:**
1. On load: restores previous mode from extension state storage
2. Registers three slash commands (/spec, /discover, /normal) via `registerCommand`
3. Each command handler:
   - Sets mode in extension state via `setExtensionState('mode', 'spec')`
   - Prints confirmation message to chat via `print()`
   - Registers or updates footer indicator via `registerExtensionIndicator`
4. Registers context hook to append reminder to system prompt when mode is active
5. Optional: beforeToolCall hook to warn on destructive operations in spec/discover mode

**Pattern:**
```typescript
export default function specModeExtension(api: ExtensionApi) {
  // Restore previous mode
  const savedMode = api.getExtensionState<'normal' | 'spec' | 'discover'>('mode') ?? 'normal';
  
  // Track current mode
  let currentMode = savedMode;
  
  // Register context hook for prompt injection
  api.context((messages) => {
    if (currentMode === 'normal') return messages;
    // Append reminder to system prompt
    return injectReminder(messages, currentMode);
  });
  
  // Register indicator if mode is active
  if (currentMode !== 'normal') {
    api.registerExtensionIndicator({
      id: 'spec-mode',
      label: currentMode === 'spec' ? '[SPEC]' : '[DISCOVER]',
      color: currentMode === 'spec' ? 'accent' : 'warning'
    });
  }
  
  // Register slash commands
  api.registerCommand({
    name: 'spec',
    description: 'Enter spec mode - planning only, structured output',
    execute: () => {
      currentMode = 'spec';
      api.setExtensionState('mode', 'spec');
      api.print('Spec mode active. Assistant will produce structured specification output.', { color: 'accent' });
      api.registerExtensionIndicator({ id: 'spec-mode', label: '[SPEC]', color: 'accent' });
    }
  });
  
  // Similar for /discover and /normal
}
```

## Proposed Boundaries
- Core changes minimal: ExtensionApi additions only in packages/coding-agent/src/extensions/
  - types.ts: add getExtensionState/setExtensionState signatures
  - types.ts: add registerExtensionIndicator/updateExtensionIndicator/removeExtensionIndicator signatures
  - manager.ts: implement state storage (JSON file per extension)
  - manager.ts: implement indicator registry
  - TuiRenderer: render indicators from ExtensionManager in footer
- Implementation lives in `~/.mu/agent/extensions/spec-mode/`
- Extension uses existing registerCommand, context hook APIs
- No new "persistent command" primitive - uses existing primitives

## Key Abstractions
- Extension state storage: durable per-extension key-value store
- Extension indicator: footer badge registered by extension
- Mode: mutually exclusive states (normal/spec/discover) stored in extension state
- Slash command: standard registerCommand with mode-changing handler

## Tradeoffs
- Extension-first vs core-first: Extension-first in ~/.mu/agent/extensions/
- Existing primitives vs new primitive: Use existing registerCommand + state storage
- Footer indicator vs confirmation only: Add indicator API for visual persistence
- State storage location: ~/.mu/agent/extensions/<name>/state.json vs elsewhere

## Integration Points
1. **Extension loading**: loader.ts discovers from ~/.mu/agent/extensions/
2. **Command registration**: Extension calls registerCommand, appears in slash overlay via TuiRenderer
3. **State storage**: Extension calls getExtensionState/setExtensionState, manager persists to JSON
4. **Context hook**: Extension registers context hook, appends reminder to system prompt
5. **Indicator rendering**: FooterComponent reads from ExtensionManager, renders badges

## What Matters Most
- Minimal core API additions (state storage + optional indicators)
- Extension demonstrates pattern without core knowledge
- State persists across reloads
- Visual feedback is clear
- No regression in existing extension behavior
- Real integration points acknowledged (TuiRenderer, FooterComponent)

## Approval Requested
- Please approve or adjust the architecture
- Confirm extension path: ~/.mu/agent/extensions/spec-mode/
- Approve core API additions: extension state storage, optional indicator API
- Approve integration: TuiRenderer for commands, FooterComponent for indicators

## Approved By
- Human approved extension-first architecture on 2026-04-01

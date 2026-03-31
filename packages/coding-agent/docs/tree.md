# Session Tree Navigation

The `/tree` command provides tree-based navigation of the session history.

## Overview

Sessions are stored as trees where each entry has an `id` and `parentId`. The "leaf" pointer tracks the current position. `/tree` lets you navigate to any point and optionally summarize the branch you're leaving.

### Comparison with `/fork`

| Feature | `/fork` | `/tree` |
|---------|---------|---------|
| View | Flat list of user messages | Full tree structure |
| Action | Extracts path to **new session file** | Changes leaf in **same session** |
| Summary | Never | Optional (user prompted) |
| Events | `session_before_fork` / `session_fork` | `session_before_tree` / `session_tree` |

## Tree UI

```
├─ user: "Hello, can you help..."
│  └─ assistant: "Of course! I can..."
│     ├─ user: "Let's try approach A..."
│     │  └─ assistant: "For approach A..."
│     │     └─ [compaction: 12k tokens]
│     │        └─ user: "That worked..."  ← active
│     └─ user: "Actually, approach B..."
│        └─ assistant: "For approach B..."
```

### Controls

| Key | Action |
|-----|--------|
| ↑/↓ | Navigate (depth-first order) |
| ←/→ | Page up/down |
| Ctrl+←/Ctrl+→ or Alt+←/Alt+→ | Fold/unfold and jump between branch segments |
| Shift+L | Set or clear a label on the selected node |
| Shift+T | Toggle label timestamps |
| Enter | Select node |
| Escape/Ctrl+C | Cancel |
| Ctrl+U | Toggle: user messages only |
| Ctrl+O | Toggle: show all (including custom/label entries) |

`Ctrl+←` or `Alt+←` folds the current node if it is foldable. Foldable nodes are roots and branch segment starts that have visible children. If the current node is not foldable, or is already folded, the selection jumps up to the previous visible branch segment start.

`Ctrl+→` or `Alt+→` unfolds the current node if it is folded. Otherwise, the selection jumps down to the next visible branch segment start, or to the branch end when there is no further branch point.

### Display

- Height: half terminal height
- Current leaf marked with `← active`
- Labels shown inline: `[label-name]`
- `Shift+T` shows the latest label-change timestamp next to labeled nodes
- Foldable branch starts show `⊟` in the connector. Folded branches show `⊞`
- Active path marker `•` appears after the fold indicator when applicable
- Search and filter changes reset all folds
- Default filter hides `label` and `custom` entries (shown in Ctrl+O mode)
- At each branch point, the active subtree is shown first; other sibling branches are sorted by timestamp (oldest first)

## Selection Behavior

### User Message or Custom Message
1. Leaf set to **parent** of selected node (or `null` if root)
2. Message text placed in **editor** for re-submission
3. User edits and submits, creating a new branch

### Non-User Message (assistant, compaction, etc.)
1. Leaf set to **selected node**
2. Editor stays empty
3. User continues from that point

### Selecting Root User Message
If user selects the very first message (has no parent):
1. Leaf reset to `null` (empty conversation)
2. Message text placed in editor
3. User effectively restarts from scratch

## Branch Summarization

When switching branches, user is presented with three options:

1. **No summary** - Switch immediately without summarizing
2. **Summarize** - Generate a summary using the default prompt
3. **Summarize with custom prompt** - Opens an editor to enter additional focus instructions that are appended to the default summarization prompt

### What Gets Summarized

Path from old leaf back to common ancestor with target:

```
A → B → C → D → E → F  ← old leaf
        ↘ G → H        ← target
```

Abandoned path: D → E → F (summarized)

Summarization stops at:
1. Common ancestor (always)
2. Compaction node (if encountered first)

### Summary Storage

Stored as `BranchSummaryEntry`:

```typescript
interface BranchSummaryEntry {
  type: "branch_summary";
  id: string;
  parentId: string;      // New leaf position
  timestamp: string;
  fromId: string;        // Old leaf we abandoned
  summary: string;       // LLM-generated summary
  details?: unknown;     // Optional hook data
}
```

## Implementation

### AgentSession.navigateTree()

```typescript
async navigateTree(
  targetId: string,
  options?: {
    summarize?: boolean;
    customInstructions?: string;
    replaceInstructions?: boolean;
    label?: string;
  }
): Promise<{ editorText?: string; cancelled: boolean }>
```

Options:
- `summarize`: Whether to generate a summary of the abandoned branch
- `customInstructions`: Custom instructions for the summarizer
- `replaceInstructions`: If true, `customInstructions` replaces the default prompt instead of being appended
- `label`: Label to attach to the branch summary entry (or target entry if not summarizing)

Flow:
1. Validate target, check no-op (target === current leaf)
2. Find common ancestor between old leaf and target
3. Collect entries to summarize (if requested)
4. Fire `session_before_tree` event (hook can cancel or provide summary)
5. Run default summarizer if needed
6. Switch leaf via `branch()` or `branchWithSummary()`
7. Update agent: `agent.state.messages = sessionManager.buildSessionContext().messages`
8. Fire `session_tree` event
9. Notify custom tools via session event
10. Return result with `editorText` if user message was selected

### SessionManager

- `getLeafUuid(): string | null` - Current leaf (null if empty)
- `resetLeaf(): void` - Set leaf to null (for root user message navigation)
- `getTree(): SessionTreeNode[]` - Full tree with children sorted by timestamp
- `branch(id)` - Change leaf pointer
- `branchWithSummary(id, summary)` - Change leaf and create summary entry

### InteractiveMode

`/tree` command shows `TreeSelectorComponent`, then:
1. Prompt for summarization
2. Call `session.navigateTree()`
3. Clear and re-render chat
4. Set editor text if applicable

## Hook Events

### `session_before_tree`

```typescript
interface TreePreparation {
  targetId: string;
  oldLeafId: string | null;
  commonAncestorId: string | null;
  entriesToSummarize: SessionEntry[];
  userWantsSummary: boolean;
  customInstructions?: string;
  replaceInstructions?: boolean;
  label?: string;
}

interface SessionBeforeTreeEvent {
  type: "session_before_tree";
  preparation: TreePreparation;
  signal: AbortSignal;
}

interface SessionBeforeTreeResult {
  cancel?: boolean;
  summary?: { summary: string; details?: unknown };
  customInstructions?: string;    // Override custom instructions
  replaceInstructions?: boolean;  // Override replace mode
  label?: string;                 // Override label
}
```

Extensions can override `customInstructions`, `replaceInstructions`, and `label` by returning them from the `session_before_tree` handler.

### `session_tree`

```typescript
interface SessionTreeEvent {
  type: "session_tree";
  newLeafId: string | null;
  oldLeafId: string | null;
  summaryEntry?: BranchSummaryEntry;
  fromHook?: boolean;
}
```

### Example: Custom Summarizer

```typescript
export default function(pi: HookAPI) {
  pi.on("session_before_tree", async (event, ctx) => {
    if (!event.preparation.userWantsSummary) return;
    if (event.preparation.entriesToSummarize.length === 0) return;
    
    const summary = await myCustomSummarizer(event.preparation.entriesToSummarize);
    return { summary: { summary, details: { custom: true } } };
  });
}
```

## Error Handling

- Summarization failure: cancels navigation, shows error
- User abort (Escape): cancels navigation
- Hook returns `cancel: true`: cancels navigation silently

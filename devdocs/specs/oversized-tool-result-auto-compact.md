# Specification: Auto-Compact on Context Overflow from Oversized Tool Results

## Summary & Recommendation

Implement automatic context overflow recovery that:
1. Detects when a tool result causes context window overflow
2. Removes the oversized tool result from history
3. Uses Morph compaction API to compact the remaining context
4. Retries with compacted context, passing a goal derived from the current task

**Recommendation**: Hybrid approach - detect overflow in `agent-loop.ts`, handle recovery via a callback in the Agent class that invokes the compaction infrastructure. This balances proximity to error detection with access to compaction tools.

---

## What Must Be True

1. **Context overflow detection** must be reliable:
   - Detect `stopReason === "length"` from provider responses
   - Detect provider-specific error codes (e.g., `context_length_exceeded`)
   - Only trigger recovery when the last message added was a tool result

2. **Rollback must be safe**:
   - Remove only the last tool result message from history
   - The corresponding tool call in the assistant message remains (for transparency)
   - History remains consistent for the next LLM call

3. **Compaction must succeed before retry**:
   - Morph compaction API must be available (MORPH_API_KEY set)
   - Goal must be derived from current task context
   - Compaction must produce valid replacement history

4. **Retry must be bounded**:
   - Maximum 1 auto-compaction attempt per overflow
   - If overflow persists after compaction, return error to user
   - User can manually trigger `/compact` if needed

---

## What Must Never Happen

1. **Never enter infinite retry loop** - max 1 auto-compaction per overflow
2. **Never remove user messages** - only remove tool result messages
3. **Never compact on non-context-overflow errors** - only trigger for `stopReason === "length"` or context-specific error codes
4. **Never retry without compaction** - must compact first
5. **Never hide the original error** - if recovery fails, show original error to user

---

## Inputs / Outputs

### Inputs

| Input | Type | Description |
|-------|------|-------------|
| `stopReason` | `"length"` \| `"error"` | From provider response |
| `errorMessage` | `string` | Error message containing context overflow details |
| `messages` | `Message[]` | Current conversation history |
| `lastAddedMessage` | `ToolResultMessage \| null` | The most recently added message |

### Outputs

| Output | Type | Description |
|--------|------|-------------|
| `recoveryAttempted` | `boolean` | Whether recovery was attempted |
| `recoverySuccess` | `boolean` | Whether recovery succeeded |
| `compactionDetails` | `HandoffDetails \| null` | Details of the compaction performed |
| `retryContext` | `Message[]` | Compacted history for retry |
| `userMessage` | `string` | Message to display to user about recovery |

---

## Edge Cases

1. **Multiple tool results in one turn**: Only remove the last tool result, keep earlier ones
2. **Tool result is empty or already truncated**: Skip rollback, proceed directly to compaction
3. **Morph API unavailable**: Fall back to existing compact tool logic (OpenAI native or local)
4. **Compaction fails**: Return original error to user, don't retry
5. **Context still exceeds window after compaction**: Return error, user must manually intervene
6. **User aborts during compaction**: Stop recovery, return control to user
7. **First message in history is a tool result**: Edge case - remove it and compact empty history

---

## Constraints

1. **Performance**: Recovery attempt should complete within 30 seconds
2. **Memory**: Compaction should not duplicate message history in memory
3. **API costs**: Morph API charges per request - minimize unnecessary calls
4. **User experience**: Show progress indicator during compaction
5. **Session integrity**: Session file must reflect the compacted state after recovery

---

## Definition of Done

### Verification Contract

1. **Unit tests** (in `packages/ai/src/agent/agent-loop.test.ts`):
   ```typescript
   // Red test: Context overflow triggers recovery
   it("should attempt auto-compact when stopReason is 'length'", async () => {
     // Setup: messages that would exceed context after tool result
     // Execute: agentLoop with oversized tool result
     // Assert: recovery callback was invoked
     // Assert: last tool result was removed
     // Assert: compaction was called with derived goal
   });
   
   // Red test: No recovery for other errors
   it("should NOT attempt recovery for non-overflow errors", async () => {
     // Setup: error with stopReason !== "length"
     // Execute: agentLoop
     // Assert: recovery callback was NOT invoked
   });
   ```

2. **Integration tests** (in `packages/coding-agent/test/`):
   ```typescript
   // Red test: Full recovery flow
   it("should recover from oversized tool result", async () => {
     // Setup: Agent with messages near context limit
     // Execute: Tool that returns oversized result
     // Assert: Context overflow detected
     // Assert: Tool result removed
     // Assert: Morph compaction called
     // Assert: Agent continues with compacted context
   });
   ```

3. **Manual verification**:
   - Trigger context overflow with large `bash` output
   - Verify TUI shows "Compacting..." status
   - Verify recovery succeeds and agent continues
   - Verify session file contains compacted history

4. **Diff verification**:
   - Before: `messages` contains oversized tool result
   - After: `messages` has tool result removed, followed by compaction summary
   - Verify token count reduced below threshold

---

## Implementation Plan

### Phase 1: Detection in agent-loop.ts

**File**: `packages/ai/src/agent/agent-loop.ts`

Add overflow detection after the `streamAssistantResponse` call:

```typescript
// After line ~90
if (message.stopReason === "length" || isContextOverflowError(message.errorMessage)) {
  // Call recovery callback if provided
  if (config.onContextOverflow && lastAddedMessageType === "toolResult") {
    const recovery = await config.onContextOverflow({
      messages: currentContext.messages,
      lastToolResult: lastAddedToolResult,
      errorMessage: message.errorMessage,
    });
    
    if (recovery.shouldRetry) {
      // Replace messages with compacted version
      currentContext.messages = recovery.compactedMessages;
      // Continue loop with compacted context
      continue;
    }
  }
  
  // Original behavior: stop on error
  stream.push({ type: "turn_end", message, toolResults: [] });
  const cleanedMessages = stripThinkingFromMessages(newMessages);
  stream.push({ type: "agent_end", messages: cleanedMessages });
  stream.end(cleanedMessages);
  return;
}
```

### Phase 2: Recovery callback in Agent class

**File**: `packages/agent/src/agent.ts`

Add new callback to `AgentRunConfig`:

```typescript
export interface AgentRunConfig {
  // ... existing fields
  
  /**
   * Callback for context overflow recovery.
   * Called when stopReason === "length" and last message was a tool result.
   */
  onContextOverflow?: (params: {
    messages: Message[];
    lastToolResult: ToolResultMessage;
    errorMessage: string;
  }) => Promise<{
    shouldRetry: boolean;
    compactedMessages: Message[];
    goal: string;
  }>;
}
```

### Phase 3: Compaction handler in coding-agent

**File**: `packages/coding-agent/src/context-overflow-recovery.ts` (new file)

```typescript
import { executeExplicitCompactionStrategy } from "./morph-compaction-explicit.js";
import type { Message, ToolResultMessage } from "@kennyfrc/mu-ai";

export async function handleContextOverflow(params: {
  messages: Message[];
  lastToolResult: ToolResultMessage;
  errorMessage: string;
  model: Model;
}): Promise<{
  shouldRetry: boolean;
  compactedMessages: Message[];
  goal: string;
}> {
  // 1. Remove last tool result
  const messagesWithoutLast = params.messages.slice(0, -1);
  
  // 2. Derive goal from recent context
  const goal = deriveGoalFromMessages(messagesWithoutLast);
  
  // 3. Execute Morph compaction
  const result = await executeExplicitCompactionStrategy({
    messages: messagesWithoutLast,
    goal,
    model: params.model,
    // ... other params
  });
  
  if (result.kind === "success") {
    return {
      shouldRetry: true,
      compactedMessages: result.replacementMessages,
      goal,
    };
  }
  
  return { shouldRetry: false, compactedMessages: [], goal: "" };
}

function deriveGoalFromMessages(messages: Message[]): string {
  // Extract goal from last user message or assistant thinking
  const lastUserMessage = [...messages].reverse().find(m => m.role === "user");
  // ... implementation
}
```

### Phase 4: Wire up in TuiRenderer

**File**: `packages/coding-agent/src/tui/tui-renderer.ts`

Pass recovery handler to Agent:

```typescript
const onContextOverflow = async (params) => {
  this.showStatus("Compacting context after overflow...");
  const result = await handleContextOverflow({
    ...params,
    model: this.agent.state.model,
  });
  return result;
};

// In agent.run() config
config.onContextOverflow = onContextOverflow;
```

---

## Verification Scripts

### Script 1: Test overflow detection

```typescript
// /tmp/test-overflow-detection.ts
import { agentLoop } from "@kennyfrc/mu-ai";
import { createStubTransport } from "./test-helpers.js";

// Hypothesis: stopReason "length" triggers recovery callback
let recoveryCalled = false;

const transport = createStubTransport({
  stopReason: "length",
  errorMessage: "context_length_exceeded",
});

const config = {
  onContextOverflow: async () => {
    recoveryCalled = true;
    return { shouldRetry: false, compactedMessages: [], goal: "" };
  },
};

await agentLoop(/* ... */);
console.assert(recoveryCalled, "Recovery callback should be called for stopReason=length");
```

### Script 2: Test goal derivation

```typescript
// /tmp/test-goal-derivation.ts
import { deriveGoalFromMessages } from "./context-overflow-recovery.js";

// Hypothesis: Goal is correctly derived from recent messages
const messages = [
  { role: "user", content: "Fix the bug in login.ts" },
  { role: "assistant", content: "I'll read the file" },
];

const goal = deriveGoalFromMessages(messages);
console.assert(goal.includes("Fix the bug"), "Goal should contain user intent");
```

### Script 3: Test Morph compaction

```typescript
// /tmp/test-morph-compaction.ts
import { executeExplicitCompactionStrategy } from "./morph-compaction-explicit.js";

// Hypothesis: Morph compaction produces valid replacement messages
const result = await executeExplicitCompactionStrategy({
  messages: testMessages,
  goal: "Fix the bug",
  model: testModel,
});

console.assert(result.kind === "success", "Morph compaction should succeed");
console.assert(result.replacementMessages.length < testMessages.length, "Compacted messages should be shorter");
```

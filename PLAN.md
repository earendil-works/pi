# Implementation Plan: RAG-Style `read_thread` Tool

This plan details the refactoring of the `read_thread` tool to support semantic extraction using an LLM (Claude Sonnet 4.5) when a `goal` parameter is provided, while maintaining backward compatibility for raw retrieval.

## 1. Analysis & Requirements

### Objectives
1. **Add Semantic Extraction**: Allow the agent to search for specific information within a thread using natural language (`goal`).
2. **Integrate LLM**: Use `complete()` with `claude-sonnet-4-20250514` to process thread content.
3. **Maintain Compatibility**: Keep the existing raw dump behavior when `goal` is absent.
4. **Manage Context**: Handle large threads by retrieving more messages when a goal is present, but truncating to fit the extraction model's context window.

### Architecture Impact
- **Dependencies**: The tool will now depend on the `mu-ai` generic model invocation functions (`complete`, `getModel`, `Context`).
- **State**: No new state is persisted; the operation is stateless.
- **Configuration**: Requires `ANTHROPIC_API_KEY` to be available in the environment (standard for `mu-ai`).

## 2. Modified Files

| File | Purpose | Changes |
| :--- | :--- | :--- |
| `packages/coding-agent/src/tools/read-thread.ts` | Tool Implementation | Update schema, import LLM utilities, implement branching logic for RAG. |
| `packages/coding-agent/src/prompts/tools.yaml` | Tool Documentation | Update description to inform the Agent about the new `goal` capability. |

## 3. Detailed Implementation Steps

### Step 1: Update Tool Schema (`read-thread.ts`)

Modify `readThreadSchema` to include the optional `goal` parameter.

```typescript
const readThreadSchema = Type.Object({
    id: Type.String({ description: "The thread ID to read" }),
    projectPath: Type.Optional(
        Type.String({ description: "Path to the project directory where the thread is located" }),
    ),
    // New parameter
    goal: Type.Optional(
        Type.String({ description: "The specific information or answer you are looking for in this thread. If provided, an AI will read the thread and extract only relevant info." })
    ),
    max_messages: Type.Optional(Type.Number({ description: "Max messages to return (default: 50, or 500 if goal is set)" })),
    start_index: Type.Optional(Type.Number({ description: "Message index to start from (default: 0)" })),
    detailed: Type.Optional(Type.Boolean({ description: "Include tool execution details (default: false)" })),
});
```

### Step 2: Update Tool Execution Logic (`read-thread.ts`)

Refactor the `execute` function to handle the branching logic.

**Logic Flow:**
1. **Determine Limits**: If `goal` is present and `max_messages` is undefined, default `max_messages` to `500` (instead of 50) to capture more context for the RAG.
2. **Fetch Content**: Call `SessionManager.getThreadContent`.
3. **Branch**:
   - **Case A (No Goal)**: Return existing wrapped content.
   - **Case B (Goal Present)**:
     - Truncate content to a safe limit (e.g., 100k characters) to avoid context overflow.
     - Call helper `extractRelevantInfo(content, goal)`.
     - Return the extracted summary wrapped in specific tags (e.g., `<thread_extract>`).

**Imports needed:**
```typescript
import { complete, getModel, type Context } from "@kennyfrc/mu-ai";
```

### Step 3: Implement Extraction Helper (`read-thread.ts`)

Create a private helper function to handle the LLM interaction.

**Helper Signature:**
```typescript
async function extractRelevantInfo(
    content: string,
    goal: string,
    threadId: string
): Promise<string>
```

**Implementation Details:**
- **Model**: `getModel('anthropic', 'claude-sonnet-4-20250514')`.
- **Prompt Strategy**:
  - Role: System prompt defining the extraction task.
  - Context: The raw thread content.
  - Instruction: The user's `goal`.
- **Error Handling**: Wrap the `complete` call in try/catch. If it fails, return the raw content with a warning prepended.

**Prompt Draft:**
```text
System: You are an expert researcher. You will be given a conversation transcript from a coding session.
Your task is to extract information relevant to a specific GOAL.
- Quote key technical decisions, file paths, or code snippets if relevant.
- Summarize context if the goal requires understanding the state of the project.
- If the information is not found, state that clearly.
- Be concise.

Transcript:
{content}

User: Extract information relevant to this goal: {goal}
```

### Step 4: Update Description (`prompts/tools.yaml`)

Update the YAML to explain the RAG capability to the Agent using the tool.

```yaml
read_thread: |
  Read the conversation history of a specific thread.
  
  MODES:
  1. RAG Mode (Recommended): Provide a 'goal' argument describing what you are looking for. An AI will search the thread and return only the relevant excerpts and context.
  2. Raw Mode: Omit 'goal'. Returns the raw transcript with pagination.
  
  Returns content wrapped in <reference_thread> (raw) or <thread_extract> (RAG).
```

## 4. Risks & Considerations

### Token Limits
- **Risk**: A very long thread (>100k tokens) might exceed the context window of the extraction model.
- **Mitigation**:
  - Default `max_messages` to 500 when `goal` is used (covers most sessions).
  - Hard truncate the string passed to the LLM (e.g., to ~400,000 characters ~100k tokens) to ensure the prompt fits within Sonnet's 200k limit.

### Recursive Loops
- **Risk**: The tool calling itself or the extraction model triggering tools.
- **Mitigation**: The `Context` passed to `complete()` inside the tool will **not** include any tools definition. It is a pure text-in/text-out operation.

### Latency
- **Impact**: Semantic extraction adds latency (LLM generation time).
- **Mitigation**: Acceptable trade-off for higher quality retrieval. The Agent waits for the tool result anyway.

### API Keys
- **Requirement**: The environment running `coding-agent` must have `ANTHROPIC_API_KEY` set.
- **Fallback**: If the key is missing, `complete` throws. The tool should catch this and fall back to returning the raw transcript with an error note attached.

## 5. Testing Plan

Since this is a refactor of an existing tool:

1. **Manual Verification**:
   - Run the agent.
   - Ask: "What did we discuss in thread [ID]?" (Should use raw mode or default).
   - Ask: "Check thread [ID] and tell me what the database schema decision was." (Should trigger `goal` parameter).
2. **Verify Output**:
   - Ensure "Raw Mode" still returns `<reference_thread>`.
   - Ensure "RAG Mode" returns relevant summaries without massive raw dumps.

## 6. Implementation Checklist

- [ ] Update `readThreadSchema` with `goal` parameter
- [ ] Add imports for `complete`, `getModel`, `Context` from `@kennyfrc/mu-ai`
- [ ] Implement `extractRelevantInfo()` helper function
- [ ] Update `execute()` with branching logic
- [ ] Update `tools.yaml` description
- [ ] Test raw mode (backward compatibility)
- [ ] Test RAG mode with goal parameter
- [ ] Run `npm run check` to verify types

# Spec: Reasoning Guidelines in System Prompt

## Summary & Recommendation

Add a `<reasoning_guidelines>` section appended after `</metadata>` in the system prompt. It maps the user's selected `ThinkingLevel` to a concrete token budget N, directly instructing the model on reasoning length. The section is rebuilt on every thinking level change (full system prompt rebuild, accepted cache break).

## What Must be True

- When thinking is "off", no `<reasoning_guidelines>` section appears.
- For non-off levels, the system prompt ends with `<reasoning_guidelines>` containing the mapped N.
- N values match the user-facing `/thinking` selector descriptions (1k/2k/8k/16k/32k).
- When the user changes thinking level (Tab/Shift+Tab, `/thinking`), the system prompt is rebuilt and `agent.setSystemPrompt()` is called.

## What Must Never Happen

- `<reasoning_guidelines>` must never appear when thinking is "off".
- N must never exceed the API budget ceiling (verified: all N values are within Anthropic budgets).

## Inputs / Outputs

**Input**: `ThinkingLevel` from `agent.state.thinkingLevel`

**Mapping**:

| ThinkingLevel | N     |
|---------------|-------|
| off           | *(none, section omitted)* |
| minimal       | 1,000 |
| low           | 2,000 |
| medium        | 8,000 |
| high          | 16,000|
| xhigh         | 32,000|

**Output**: System prompt with appended `<reasoning_guidelines>` block:

```xml
<reasoning_guidelines>
Keep your reasoning concise. Use less than 8000 tokens for internal thinking. Proceed directly through reasoning.
</reasoning_guidelines>
```

## Edge Cases

- **Google Flash minimal (128 API budget)**: Prompt N=1000 exceeds API budget of 128. Acceptable — prompt is soft guidance, API enforces the hard ceiling.
- **Non-reasoning model**: `thinkingLevel` is already clamped to "off", so no section appears.

## Constraints

- `<reasoning_guidelines>` is appended after `</metadata>` at the end of the system prompt.
- Full system prompt rebuild on thinking level change (simpler, accepted cache break).

## Definition of Done

1. `getReasoningGuidelines(thinkingLevel: ThinkingLevel): string | null` exists in `packages/coding-agent/src/prompts/index.ts`.
2. `buildSystemPromptSections` accepts optional `thinkingLevel` and appends guidelines to metadata section.
3. `buildSystemPrompt` in `main.ts` passes initial thinking level.
4. Thinking level change handlers in `tui-renderer.ts` rebuild the system prompt via `systemPromptBuilder` + `setSystemPrompt`.
5. `prompt-cache-replay.ts` also passes thinking level (if applicable, or defaults to "off").
6. Tests: `buildSystemPrompt` output contains `<reasoning_guidelines>` with correct N for "medium", and no section for "off".
7. `npm run check` passes.

## Implementation Steps

### 1. Add `getReasoningGuidelines()` to `packages/coding-agent/src/prompts/index.ts`

Pure function:

```ts
export function getReasoningGuidelines(thinkingLevel: ThinkingLevel): string | null {
  if (thinkingLevel === "off") return null;
  const budgets: Record<Exclude<ThinkingLevel, "off">, number> = {
    minimal: 1000,
    low: 2000,
    medium: 8000,
    high: 16000,
    xhigh: 32000,
  };
  const n = budgets[thinkingLevel];
  return `<reasoning_guidelines>\nKeep your reasoning concise. Use less than ${n} tokens for internal thinking. Proceed directly through reasoning.\n</reasoning_guidelines>`;
}
```

### 2. Modify `buildSystemPromptSections` and `buildSystemPrompt`

Add optional `thinkingLevel` parameter. Append the guidelines block to the `metadata` section (after file tree / cwd).

### 3. Update `buildSystemPrompt()` in `main.ts`

Pass `agent.state.thinkingLevel` (or `initialThinking`) when building the prompt.

### 4. Update thinking level change handlers in `tui-renderer.ts`

After every `this.agent.setThinkingLevel()`, rebuild the system prompt:

```ts
const systemPrompt = await this.systemPromptBuilder(currentTools);
this.agent.setSystemPrompt(systemPrompt);
```

This follows the same pattern as `refreshToolsForCurrentMode()`.

### 5. Update `prompt-cache-replay.ts`

Pass `thinkingLevel: "off"` (or restore from replay metadata if available).

### 6. Add tests

- Unit test for `getReasoningGuidelines()` (off → null, medium → contains "8000", xhigh → contains "32000").
- Integration test for `buildSystemPrompt` with thinkingLevel (section appears, correct N).

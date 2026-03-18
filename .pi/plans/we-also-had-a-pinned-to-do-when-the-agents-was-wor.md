# Plan: we also had a pinned to-do when the agents was working,is it back too

**Date:** 2026-03-18

**Found the bug.** Here's what's happening:

1. The Prometheus prompt tells the agent to **write the plan to `.pi/plans/` using the `write` tool** (not in the chat message)
2. The `agent_end` handler reads `getTextContent(lastAssistant)` — which is the **assistant's chat message**, NOT the file content
3. The assistant message says something like *"Plan saved to .pi/plans/xyz.md"* — a summary, not the actual plan with `## TODOs` and `- [ ] 1.` items
4. `extractWavePlan()` gets this summary text → finds no `## TODOs` → returns null → `todoCount=0`
5. No widget, no auto-checking, nothing

The plan **file** has the correct format. The assistant **message** doesn't contain it. The code reads from the wrong place.

The debug log confirms it — every single session shows `todoCount=0` at plan-generation `agent_end`.

Do you want me to create a plan to fix both issues?

1. **Fix todo extraction**: Read from the `.pi/plans/*.md` file instead of (or in addition to) the assistant message
2. **Smart menu choices**: Auto-select "Start Work" for trivial/simple intents, only show Momus option for complex

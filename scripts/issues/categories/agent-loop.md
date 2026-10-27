---
owner: vegarsti
---
# agent-loop

Turn execution in packages/agent and AgentSession.

In:
- Turn lifecycle and settlement.
- Tool call dispatch, parallel tool batches.
- Orphaned or unmatched tool calls, results lost after abort or crash.
- Abort and cancellation.
- Steering and follow-up queue, prompt() semantics.
- Session-level retry, stalls where the loop never finishes.

Not here:
- Provider stream parsing: providers.
- Context limits and summarization: compaction.
- "Event X is not emitted" or "a hook cannot do Y": extensions.

Examples: #7053, #9306, #9986, #8331, #10017, #10289, #9783.

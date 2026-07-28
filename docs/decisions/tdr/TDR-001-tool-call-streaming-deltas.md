# TDR-001: Tool Call Streaming Reports Argument Deltas, Not Partial JSON

**Date:** 2025-09-09
**Source:** Commit `98a876f3`

**Related to:** [ADR-006](006-asynciterable-streaming-api.md)

Tool call streaming reports argument string deltas — raw string fragments appended to the argument text — instead of partially parsed JSON objects. This means downstream consumers that want to render or validate tool calls incrementally must either buffer the raw string and parse it at the end, or implement their own partial JSON parser. The commit message explicitly calls this out as "preliminary." A proper streaming JSON parser for tool call arguments was deferred.

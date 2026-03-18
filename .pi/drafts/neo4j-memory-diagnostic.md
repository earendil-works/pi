# Neo4j Memory Agent — Diagnostic Report

## Status Summary

| Component | Status | Details |
|-----------|--------|---------|
| Neo4j Server | ✅ RUNNING | `bolt://localhost:7687` — accepting connections |
| Neo4j HTTP API | ✅ WORKING | `curl localhost:7474` returns data correctly |
| Neo4j MCP Binary | ✅ EXISTS | `/Users/besi/.cache/neo4j-mcp/neo4j-mcp-v1.4.6` executable |
| MCP Config | ✅ CONFIGURED | `mcp.json` has neo4j entry with correct env vars |
| MCP Cache | ❌ MISSING | `mcp-cache.json` has 6 servers cached — neo4j is NOT one of them |
| Memory Agent | ❌ CRASHING | Exits with code 1 before doing anything |

---

## Root Causes (3 blocking issues found)

### 🔴 BLOCKER 1: API Key Not Found (Fatal Crash)

**The actual crash error from session logs:**
```
Error: No API key found for anthropic.
```

**Chain of failure:**
1. `memory.md` declares `model: claude-sonnet-4-6`
2. Subagent spawns: `pi --mode json -p --no-session --model claude-sonnet-4-6`
3. Model `claude-sonnet-4-6` resolves to provider: `anthropic`
4. Process looks for `ANTHROPIC_API_KEY` env var → not set
5. Process checks `auth.json` OAuth credentials → has `factory-anthropic` OAuth, NOT direct `anthropic`
6. **CRASH** — no API key for the `anthropic` provider

**Why the parent works:** `settings.json` uses `defaultProvider: "factory-anthropic"` with OAuth auth. The spawned subprocess tries direct `anthropic` provider instead.

**Fix:** Change memory.md model to `factory-anthropic/claude-sonnet-4-6` so it routes through the factory provider that has working OAuth credentials.

### 🔴 BLOCKER 2: `neo4j` Tool Rejected by CLI

**The warning from session logs:**
```
Warning: Unknown tool "neo4j". Valid tools: read, bash, edit, write, grep, find, ls
Warning: Unknown tool "neo4j". Valid tools: read, bash, edit, write, grep, find, ls
```

**Chain of failure:**
1. `memory.md` frontmatter: `tools: bash, read, neo4j`
2. Subagent extension parses this → passes `--tools bash,read,neo4j`
3. `args.ts` (line 102-106) validates against `allTools` registry
4. `allTools` = `{read, bash, edit, write, grep, find, ls}` — 7 built-in tools only
5. `neo4j` is rejected as unknown

**Why this is wrong:** MCP tools (`read-cypher`, `write-cypher`, `get-schema`) are NOT built-in tools. They come from MCP server connections, not the `--tools` flag. Listing `neo4j` in the frontmatter tools field is meaningless.

**Fix:** Remove `neo4j` from memory.md tools. Change to `tools: bash, read`.

### 🟡 BLOCKER 3: Neo4j MCP Server Never Connected

**Evidence:** `mcp-cache.json` contains cached schemas for 6 servers:
- `chrome-devtools`, `context7`, `exa`, `grep_app`, `websearch`, `pencil`
- **`neo4j` is absent**

This means the MCP framework has never successfully initialized the neo4j MCP server and cached its tool definitions. Even if Blockers 1 and 2 are fixed, the MCP tools (`read-cypher`, `write-cypher`, `get-schema`) may not be available to the memory agent.

**Potential sub-causes:**
- The neo4j MCP server may have failed its first connection attempt and was never retried
- Subagent processes spawned with `--mode json -p --no-session` may not inherit/initialize MCP servers
- The MCP cache may need to be refreshed/rebuilt

**Fix:** Force MCP cache refresh. Verify subagent MCP inheritance. As fallback, the memory agent already has a curl-based fallback path.

---

## Session Log Evidence

From: `2026-03-16T22-44-42-405Z_*.jsonl`
```
exitCode: 1
messages: [] (empty — agent never produced output)
stderr: "Warning: Unknown tool \"neo4j\"... Error: No API key found for anthropic."
model: "claude-sonnet-4-6"
```

Multiple sessions show identical failure pattern.

---

## Scope

### IN SCOPE
- Fix memory.md frontmatter (tools, model)
- Verify/fix MCP cache for neo4j
- Verify MCP tool availability in subagent processes
- Ensure curl fallback works as safety net
- Test end-to-end memory recall

### OUT OF SCOPE
- Changing Neo4j graph schema
- Modifying the subagent extension's tool validation logic
- Adding neo4j as a built-in tool to allTools registry

### DECISIONS
- Use `factory-anthropic` provider prefix for subagent models (matches parent auth)
- Remove `neo4j` from tools field (MCP tools aren't controlled there)
- Keep curl fallback as safety net in memory agent prompt

# Fix Neo4j Memory Agent — Connection & Configuration

## TL;DR
> **Quick Summary**: Memory agent crashes on every invocation due to 2 config bugs in `memory.md`: wrong model provider prefix and invalid tool name. A third agent (`tla-precheck.md`) has the same model bug. Neo4j itself is running fine.
> **Deliverables**: Working memory agent that can read/write Neo4j knowledge graph via MCP tools
> **Estimated Effort**: Quick (15-30 min)
> **Parallel Execution**: YES — 2 waves
> **Critical Path**: Task 1 (fix configs) → Task 3 (verify end-to-end)

## Context

### Original Request
User reported that agents cannot read from the Neo4j memory knowledge graph. The memory subagent was failing silently during plan generation.

### Investigation Summary
Diagnostic revealed Neo4j server is healthy (`bolt://localhost:7687` responding, HTTP API at `:7474` returns data). The memory agent crashes before it can do anything due to configuration mismatches in its frontmatter.

Three root causes identified:

**🔴 BLOCKER 1 — Fatal Crash: API Key Not Found**
- `memory.md` declares `model: claude-sonnet-4-6` (bare model name)
- Spawned subprocess resolves this to provider `anthropic`
- No `ANTHROPIC_API_KEY` env var exists; parent process uses `factory-anthropic` provider via OAuth (`auth.json`)
- Process crashes: `Error: No API key found for anthropic.`
- Session log evidence: `2026-03-16T22-44-42-405Z_*.jsonl` — `exitCode: 1, messages: []`

**🔴 BLOCKER 2 — Tool Rejection Warning**
- `memory.md` declares `tools: bash, read, neo4j`
- Subagent passes `--tools bash,read,neo4j` to spawned `pi` process
- `args.ts` validates against `allTools` = `{read, bash, edit, write, grep, find, ls}`
- `neo4j` rejected: `Warning: Unknown tool "neo4j"`
- MCP tools are NOT built-in tools — they're loaded via the `pi-mcp-adapter` extension package and don't need `--tools` declaration

**🟡 ISSUE 3 — Neo4j MCP Not Cached**
- `mcp-cache.json` lists 6 cached servers; neo4j is absent
- Likely failed on first connection attempt and was never retried
- Expected to auto-resolve once the agent process starts successfully (MCP adapter loads in all modes including print-mode used by subagents)

**Bonus Finding**: `tla-precheck.md` has identical model bug: `model: claude-sonnet-4-6` (no factory prefix)

### Architecture Understanding
- MCP is loaded via `pi-mcp-adapter` extension package (declared in `settings.json` as `packages: ["npm:pi-mcp-adapter"]`)
- The adapter reads `~/.pi/agent/mcp.json`, connects to configured servers, injects tools
- Print mode (used by subagents: `--mode json -p`) calls `session.bindExtensions()` → extensions load → MCP tools become available
- All other agents (explore, metis, devops, etc.) correctly use `factory-anthropic/` or `factory-openai/` prefixed models
- Memory agent's curl fallback path works as confirmed by direct test

### Metis Review
Metis consultation returned partial response. Gaps self-identified:
- Verified ALL 12 agent definitions — only `memory.md` and `tla-precheck.md` have bare model names
- Confirmed MCP adapter loads in print-mode via `bindExtensions()` in `print-mode.ts`
- Confirmed `spawn("pi", args)` inherits `process.env` (no explicit env override)

### Memory Recall
Memory recall failed (bootstrapping paradox — the memory agent IS the broken component). No prior context available.

### State Machine Assessment
No stateful workflows identified — skipped. This is a configuration fix, not a state machine problem.

## Work Objectives

### Core Objective
Make the memory agent functional so all agents (prometheus, explore, etc.) can read/write the Neo4j knowledge graph.

### Concrete Deliverables
1. Fixed `~/.pi/agent/agents/memory.md` — correct model provider, valid tools
2. Fixed `~/.pi/agent/agents/tla-precheck.md` — correct model provider
3. Neo4j MCP tools available and cached
4. Verified end-to-end memory recall/remember working

### Definition of Done
- `memory recall "test query"` via subagent returns Neo4j data (not crash)
- `mcp-cache.json` contains `neo4j` server entry
- No `Warning: Unknown tool` in stderr
- No `Error: No API key found` in stderr

### Must Have
- Factory-prefixed model in memory.md matching parent auth strategy
- Valid built-in tools only in frontmatter tools field
- MCP tools loaded automatically via pi-mcp-adapter (no frontmatter needed)
- Fallback model specified (all other agents have one)

### Must NOT Have (Guardrails)
- Do NOT add `neo4j` to the `allTools` registry in source code — MCP tools are extension-provided
- Do NOT modify `mcp.json` — the Neo4j config is correct
- Do NOT modify the subagent extension's tool validation logic
- Do NOT modify `args.ts` or `tools/index.ts` — the validation is working as designed
- Do NOT change the memory agent's system prompt graph schema or commands
- Do NOT set `ANTHROPIC_API_KEY` env var — use factory provider to match existing auth pattern

## Verification Strategy

### Test Decision
Manual verification via subagent invocation. No unit tests needed — this is a config-only fix.

### QA Policy
1. Verify agent starts without warnings/errors
2. Verify MCP tools are available (neo4j cached)
3. Verify read query returns data
4. Verify write query persists data

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — config fixes):
├── Task 1: Fix memory.md frontmatter
├── Task 2: Fix tla-precheck.md frontmatter

Wave 2 (After Wave 1 — verification):
├── Task 3: Verify Neo4j MCP connection & cache
├── Task 4: End-to-end memory agent test
├── Task 5: Verify other agents can call memory

Wave 3 (Final — record fix):
├── Task 6: Record learning in Neo4j (self-test + knowledge capture)
```

### Dependency Matrix
```
Task 1 ──┬──→ Task 3 ──→ Task 4 ──→ Task 5 ──→ Task 6
Task 2 ──┘
```

## TODOs

- [ ] 1. Fix memory.md frontmatter
  **What to do**:
  1. Open `~/.pi/agent/agents/memory.md`
  2. Change frontmatter `model: claude-sonnet-4-6` → `model: factory-anthropic/claude-sonnet-4-6`
  3. Change frontmatter `tools: bash, read, neo4j` → `tools: bash, read`
  4. Add fallback model: `fallback-model: factory-openai/gpt-5.4:xhigh` (matches pattern of other agents)
  **Must NOT do**: Do not change the system prompt body (graph schema, commands, curl fallback). Do not add `neo4j` back as a tool.
  **Parallelization**:
    - Can Run In Parallel: YES
    - Parallel Group: Wave 1
    - Blocks: Task 3, Task 4, Task 5, Task 6
    - Blocked By: None
  **References**:
    - `~/.pi/agent/agents/memory.md` lines 1-5 (frontmatter)
    - `~/.pi/agent/agents/explore.md` lines 1-6 (reference pattern: `model: factory-anthropic/claude-opus-4-6:xhigh`)
    - `~/.pi/agent/agents/devops.md` lines 1-6 (reference pattern with fallback-model)
  **Acceptance Criteria**:
    - `grep "^model:" ~/.pi/agent/agents/memory.md` outputs `model: factory-anthropic/claude-sonnet-4-6`
    - `grep "^tools:" ~/.pi/agent/agents/memory.md` outputs `tools: bash, read`
    - `grep "^fallback-model:" ~/.pi/agent/agents/memory.md` outputs a factory-prefixed model
    - No occurrence of string `neo4j` in the frontmatter block (between `---` markers)
  **QA Scenarios**:
    Scenario: Frontmatter validates correctly
      Tool: Bash
      Steps: `head -10 ~/.pi/agent/agents/memory.md`
      Expected Result: model has `factory-` prefix, tools only list `bash, read`, fallback-model present

- [ ] 2. Fix tla-precheck.md frontmatter
  **What to do**:
  1. Open `~/.pi/agent/agents/tla-precheck.md`
  2. Change frontmatter `model: claude-sonnet-4-6` → `model: factory-anthropic/claude-sonnet-4-6`
  3. Add fallback model: `fallback-model: factory-openai/gpt-5.4:xhigh`
  **Must NOT do**: Do not change the system prompt body.
  **Parallelization**:
    - Can Run In Parallel: YES
    - Parallel Group: Wave 1
    - Blocks: Task 3
    - Blocked By: None
  **References**:
    - `~/.pi/agent/agents/tla-precheck.md` lines 1-5 (frontmatter)
  **Acceptance Criteria**:
    - `grep "^model:" ~/.pi/agent/agents/tla-precheck.md` outputs `model: factory-anthropic/claude-sonnet-4-6`
    - `grep "^fallback-model:" ~/.pi/agent/agents/tla-precheck.md` outputs a factory-prefixed model
  **QA Scenarios**:
    Scenario: Frontmatter validates correctly
      Tool: Bash
      Steps: `head -10 ~/.pi/agent/agents/tla-precheck.md`
      Expected Result: model has `factory-` prefix, fallback-model present

- [ ] 3. Verify Neo4j MCP connection & cache
  **What to do**:
  1. After Task 1 is complete, invoke the memory agent with a minimal task to force MCP initialization
  2. Check `~/.pi/agent/mcp-cache.json` — verify `neo4j` now appears in the `servers` object
  3. If neo4j NOT in cache after invocation:
     a. Check if neo4j is still running: `nc -z localhost 7687`
     b. Check if the MCP binary works: run it with env vars and send JSON-RPC initialize
     c. Check pi-mcp-adapter logs for connection errors
  4. Verify the MCP tools are: `read-cypher`, `write-cypher`, `get-schema` (as documented in memory.md system prompt)
  **Must NOT do**: Do not modify mcp.json. Do not modify the mcp-cache.json manually.
  **Parallelization**:
    - Can Run In Parallel: NO
    - Parallel Group: Wave 2
    - Blocks: Task 4
    - Blocked By: Task 1, Task 2
  **References**:
    - `~/.pi/agent/mcp.json` lines 24-32 (neo4j server config)
    - `~/.pi/agent/mcp-cache.json` (should gain neo4j entry)
    - `/Users/besi/npm-global/lib/node_modules/pi-mcp-adapter/init.ts` (MCP initialization)
    - `/Users/besi/.cache/neo4j-mcp/neo4j-mcp-v1.4.6` (MCP binary)
  **Acceptance Criteria**:
    - `cat ~/.pi/agent/mcp-cache.json | python3 -c "import json,sys; print('neo4j' in json.load(sys.stdin).get('servers',{}))"` outputs `True`
    - The cached tools include `read-cypher` and `write-cypher`
  **QA Scenarios**:
    Scenario: MCP cache populated after first successful run
      Tool: Bash
      Steps: Run memory agent, then check mcp-cache.json
      Expected Result: `neo4j` key present in `servers` object with tool definitions
    Scenario: MCP binary unreachable
      Tool: Bash
      Steps: `ls -la /Users/besi/.cache/neo4j-mcp/neo4j-mcp-v1.4.6`
      Expected Result: File exists and is executable (-rwxr-xr-x)

- [ ] 4. End-to-end memory agent test — READ
  **What to do**:
  1. Use subagent to invoke memory agent with a read query:
     Task: `"Recall: run a simple MATCH (n) RETURN labels(n), count(*) query to show what's in the graph. If the graph is empty, say so. Use MCP tools if available, curl fallback if not."`
  2. Verify the agent:
     a. Starts without errors (no API key crash, no unknown tool warning)
     b. Successfully connects to Neo4j (via MCP or curl)
     c. Returns query results or "empty graph" message
  3. Check stderr for any warnings
  **Must NOT do**: Do not consider a curl-fallback success as "MCP working" — note which path was used.
  **Parallelization**:
    - Can Run In Parallel: NO
    - Parallel Group: Wave 2
    - Blocks: Task 5
    - Blocked By: Task 3
  **References**:
    - `~/.pi/agent/agents/memory.md` (full system prompt — MCP tools + curl fallback)
  **Acceptance Criteria**:
    - Agent exits with code 0
    - Agent produces non-empty output (messages array is not [])
    - Stderr does NOT contain `Error: No API key found`
    - Stderr does NOT contain `Unknown tool "neo4j"`
    - Output contains Neo4j query results OR explicit "empty graph" statement
  **QA Scenarios**:
    Scenario: Happy path — MCP read works
      Tool: Subagent (memory agent)
      Steps: Send recall task for simple Cypher query
      Expected Result: Returns query results, exitCode 0, no errors in stderr
    Scenario: Fallback path — curl used when MCP unavailable
      Tool: Subagent (memory agent)
      Steps: If MCP tools not available, agent should use curl fallback
      Expected Result: Still returns data, but note this as degraded mode

- [ ] 5. End-to-end memory agent test — WRITE + READ
  **What to do**:
  1. Use subagent to invoke memory agent with a write task:
     Task: `"Remember: Record a learning — title: 'neo4j-memory-fix', insight: 'Agent frontmatter model field must use factory-prefixed provider (factory-anthropic/model-name) to match OAuth auth. Bare model names resolve to direct provider which has no API key in subagent processes.', confidence: 'proven', tags: ['agent-config', 'mcp', 'neo4j', 'subagent'], concept: 'agent-provider-resolution'"`
  2. Verify write succeeded (agent confirms creation)
  3. Use subagent to invoke memory agent with a read task:
     Task: `"Recall: Find the learning titled 'neo4j-memory-fix' and return its full content"`
  4. Verify read returns the learning that was just written
  **Must NOT do**: Do not skip the read-back verification. Both write AND read must succeed.
  **Parallelization**:
    - Can Run In Parallel: NO
    - Parallel Group: Wave 2
    - Blocks: Task 6
    - Blocked By: Task 4
  **References**:
    - `~/.pi/agent/agents/memory.md` — "Remember" and "Recall" command sections
  **Acceptance Criteria**:
    - Write invocation exits code 0 with confirmation message
    - Read invocation exits code 0 and returns the learning with matching title and insight text
    - Round-trip proves both MCP write-cypher and read-cypher work (or curl fallback works for both)
  **QA Scenarios**:
    Scenario: Write then read round-trip
      Tool: Subagent (memory agent) — two sequential calls
      Steps: (1) Remember a learning, (2) Recall it by title
      Expected Result: Second call returns the data written by first call

- [ ] 6. Record diagnostic as learning in Neo4j
  **What to do**:
  1. After Task 5 confirms write works, use memory agent to record this diagnostic:
     - Error: title `'subagent-model-provider-mismatch'`, symptoms `'memory agent crashes with Error No API key found for anthropic, subagent exits code 1 with empty messages'`, rootCause `'Agent frontmatter used bare model name (claude-sonnet-4-6) which resolves to direct anthropic provider. Subagent processes inherit env but no ANTHROPIC_API_KEY is set. Parent uses factory-anthropic OAuth.'`, impact `'All memory operations fail — knowledge graph completely inaccessible to all agents'`
     - Solution: `'Prefix model with factory provider: factory-anthropic/claude-sonnet-4-6. Remove non-built-in tool names from tools field. MCP tools load automatically via pi-mcp-adapter extension.'`
     - Learning: title `'mcp-tools-not-in-frontmatter'`, insight `'MCP tools (read-cypher, write-cypher etc) are loaded by the pi-mcp-adapter extension package, not via the --tools CLI flag. The frontmatter tools field only controls built-in tools (read, bash, edit, write, grep, find, ls). Listing MCP server names in tools causes Unknown tool warnings.'`, confidence `'proven'`
  2. Verify the records exist with a recall query
  **Must NOT do**: Do not skip this — it prevents the same mistake from recurring.
  **Parallelization**:
    - Can Run In Parallel: NO
    - Parallel Group: Wave 3
    - Blocks: None
    - Blocked By: Task 5
  **References**:
    - `~/.pi/agent/agents/memory.md` — Error/Solution/Learning schemas
  **Acceptance Criteria**:
    - Error node with title `subagent-model-provider-mismatch` exists in graph
    - Solution linked to the error exists
    - Learning node with title `mcp-tools-not-in-frontmatter` exists
    - All have ISO 8601 timestamps
  **QA Scenarios**:
    Scenario: Knowledge captured for future prevention
      Tool: Subagent (memory agent)
      Steps: Recall errors related to 'subagent' or 'provider'
      Expected Result: Returns the recorded error with linked solution

## Final Verification Wave

- [ ] F1. Plan Compliance Audit
  Verify all 6 tasks completed. Check each acceptance criterion.

- [ ] F2. Code Quality Review
  N/A — no source code changes. Only agent config (markdown frontmatter) modified.

- [ ] F3. Real Manual QA
  Trigger a planning session (which calls memory recall as pre-generation step) and confirm memory agent responds instead of crashing.

- [ ] F4. Scope Fidelity Check
  Verify ONLY these files were modified:
  - `~/.pi/agent/agents/memory.md` (frontmatter only)
  - `~/.pi/agent/agents/tla-precheck.md` (frontmatter only)
  No source code, no mcp.json, no mcp-cache.json manual edits.

## Success Criteria

1. Memory agent invocation returns data (not crash) — verified in Task 4
2. Write+Read round-trip works — verified in Task 5
3. Zero warnings in stderr — verified in Task 4
4. Neo4j MCP cached — verified in Task 3
5. Diagnostic recorded for future prevention — verified in Task 6
6. No source code modified — verified in F4

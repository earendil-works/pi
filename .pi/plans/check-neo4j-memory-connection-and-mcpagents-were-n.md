# Plan: check neo4j memory connection and mcp,agents were not able to read from memory

**Date:** 2026-03-16

### Post-Plan Self-Review Checklist

| Check | Status |
|-------|--------|
| All TODO items have concrete acceptance criteria? | ✅ All 6 tasks + 4 final have grep/query-verifiable criteria |
| All file references exist in codebase? | ✅ All 9 referenced files validated |
| No assumptions about business logic without evidence? | ✅ All findings based on session logs + code inspection |
| Guardrails from Metis review incorporated? | ✅ (Metis partial — self-identified gaps covered) |
| Scope boundaries clearly defined? | ✅ Must NOT Have section explicit |
| Every task has QA Scenarios (happy path + failure case)? | ✅ All 6 tasks have scenarios |
| Zero acceptance criteria require human intervention? | ✅ All grep/subagent/bash verifiable |

---

## Plan Generated: fix-neo4j-memory-agent

**Key Decisions Made:**
- Use `factory-anthropic/` prefix (matches all 10 other working agents' auth pattern)
- Remove `neo4j` from tools (MCP tools load automatically via pi-mcp-adapter extension — don't need frontmatter declaration)
- Add `fallback-model` to memory.md (every other agent has one)

**Scope:**
- IN: `memory.md` frontmatter, `tla-precheck.md` frontmatter, MCP cache verification, end-to-end testing
- OUT: Source code changes, mcp.json edits, allTools registry changes, system prompt changes

**Guardrails Applied:**
- No source code modifications — config-only fix
- Factory provider pattern enforced (not raw API key)
- MCP tools stay extension-managed (not built-in)

**Auto-Resolved (minor gaps fixed):**
- `tla-precheck.md` has same model bug → added to Wave 1 as Task 2
- No fallback-model on memory.md → plan includes adding one

**Defaults Applied (override if needed):**
- Fallback model: `factory-openai/gpt-5.4:xhigh` (matches majority of agents)
- Memory agent stays on Sonnet (not upgraded to Opus) — cost efficiency for graph queries

**Decisions Needed:** None — all choices evidence-based.

Plan saved to: `.pi/plans/fix-neo4j-memory-agent.md`

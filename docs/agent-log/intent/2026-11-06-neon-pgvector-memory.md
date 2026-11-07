# NLT-Pi Intent Record

**Date:** 2026-11-06  
**Agent / session:** Kiro CLI (kiro-cli chat)  
**OTOI:** NLT-PI-DEV-OTOI-1.0.1  
**Thread:** NLTPI-MEM-003  

## Intended action

Implement the Neon + pgvector memory layer as specified in
`docs/superpowers/specs/2026-11-06-neon-pgvector-memory-design.md`, approved by the
owner on 2026-11-06.

Scope of changes:

1. **`src/memory/neon-store.ts`** — new `MemoryStore` backed by Neon Postgres. Schema
   (`memories` table, `vector` extension, `pg_trgm` extension, `hnsw` + `gin` indexes)
   created on first use. All statements parameterised and owner-scoped. `save` fires
   background embed; `search` uses pgvector cosine with pg_trgm fallback.

2. **`src/memory/sandbox-embed.ts`** — `EmbedRunner` that runs `embed.py` inside a
   `SandboxLike`, parses the 384-dim output vector, validates it, returns `null` on
   any failure (caller falls back to trigram).

3. **`src/memory/embed-route.ts`** + **`api/embed.ts`** — owner-only `POST /api/embed`
   route. Looks up a `NULL`-embedding row by id, acquires the sandbox lock with a
   0-second wait (returns 503 if busy), runs the embed script, updates the row. Off
   unless `NLT_MEMORY_ENABLED=1`.

4. **`mvp/vercel.json`** — add `api/embed.ts` with `maxDuration: 30`.

5. **`src/memory/store.ts`** — remove `createMem0Store`. Keep `fakeMemoryStore` and
   the `MemoryStore` interface.

6. **`src/memory/client.ts`** — deleted (Mem0 HTTP client no longer used).

7. **`api/memories.ts`** — replace `createMem0Store(memoryClient(env))` with
   `createNeonMemoryStore(neonSql)`. Remove all Mem0 imports.

8. **`src/agent/runner.ts`** — replace `recall` dep with `recallFactory` (receives
   the locked sandbox handle, returns a recall function). Wire recall into the agent
   turn after the crisis gate.

9. **`api/agent.ts`** — replace the Mem0 recall lambda with a Neon+pgvector recall
   factory that calls `neonStore.search` using the sandbox-backed embed runner.

10. **Tests** — `test/neon-memory-store.test.ts`, `test/sandbox-embed.test.ts`,
    `test/embed-route.test.ts`, additions to `test/agent-runner.test.ts`. All offline.
    Existing `test/memory-route.test.ts` passes without modification.

11. **`docs/active-threads.md`** — update NLTPI-MEM-003, add registration + handoff refs.

12. **`mvp/README.md`** — update Memory section and platform table (Neon replaces Mem0).

## Rationale

Mem0 was blocked because its free plan trains on stored data (owner decision 2026-11-06:
keep `NLT_MEMORY_ENABLED` disabled). Neon + pgvector uses infrastructure already in the
project, keeps all data under owner control, eliminates the training concern, and adds no
new provider or API key. The embedding model (`BAAI/bge-small-en-v1.5` ONNX int8, MIT)
runs in the existing persistent sandbox — no Vercel function size constraint, no external
inference API, no cost per call.

## Risks and trust boundaries

- **New persistence boundary:** the `memories` table is a new Neon table in the existing
  project. Owner-scoped by `owner_sub` on every statement. No new provider.
- **Sandbox use outside an agent turn:** `/api/embed` calls `withAgentSandbox` with a
  0-second lock wait. If an agent turn is running, it returns 503 immediately — no
  interference. The sandbox is not an authority; it executes what the server directs.
- **Model pre-install:** the model files are installed once by the owner into the
  persistent sandbox. A sandbox reset loses them; the owner re-runs the install. No
  automatic re-download — avoids adding `huggingface.co` to the permanent egress preset.
- **Embed script stdin injection:** text is passed via stdin to the Python script, not
  as a shell argument. The `runCommand` interface uses `cmd` + `args` arrays, so no
  shell interpolation occurs.
- **Recall invariant preserved:** no code reachable from `runAgentTurn` can write to the
  memory store. The embed runner only reads from the sandbox and writes to Neon (embedding
  column only, scoped to the row id returned by the store's own insert).
- **ASFDK checks unchanged:** `writeChecks` on save and `recallChecks` on each hit are
  untouched. A blocked prompt never reaches the embed runner or the Neon search.
- **`MemoryStore` interface unchanged:** all existing route tests pass without
  modification. The fake store used by `test/memory-route.test.ts` is unaffected.
- **Layering:** this is an AgentOS execution and persistence change. It does not touch
  the ASFDK development, foundation, harness, or MCP layers.

## Decisions deferred / not in scope

- TOI/OTOI standing terms (NLTPI-MEM-002): unchanged, still awaiting owner decisions.
- Mem0 env vars: kept in Vercel (inert), not removed from the environment.
- `embed.py` install: owner's one-time manual action; not automated in code.
- Re-embed on model update: not in scope for phase 1.

## Rollback

Revert the branch. `NLT_MEMORY_ENABLED` stays unset in production during development,
so no live data is affected until the owner sets the flag.

# Neon + pgvector memory layer — design (NLTPI-MEM-003)

**Date:** 2026-11-06  
**Owner:** Joshua W. Dorsey, Sr.  
**Status:** approved by owner (2026-11-06, Kiro CLI session); implementation in progress  
**Scope:** `mvp/` (NLT Coding Agent MVP on Vercel, project `nlt-pi-mvp`)  
**Supersedes:** NLTPI-MEM-001 (Mem0 memory layer) — blocked on Mem0 free-plan training-data concern  
**Thread:** NLTPI-MEM-003

## 1. Intent

Replace Mem0 with a self-hosted memory store: short approved facts in Neon Postgres, semantic recall via pgvector cosine similarity, embeddings produced by `BAAI/bge-small-en-v1.5` (ONNX int8, 33 MB, MIT license) running inside the owner's existing persistent Vercel Sandbox (`nlt-agent`).

- **Outcome:** the agent recalls relevant approved facts across conversations, without sending data to a third-party memory provider.
- **For whom:** the signed-in owner only.
- **No new provider, no new API key.** The model lives in the sandbox filesystem. Neon is already in use.
- **No training concern.** The owner controls all data.

### Decisions (owner, 2026-11-06)

| Question | Decision |
|---|---|
| Memory provider | Neon + pgvector (replaces Mem0) |
| Embedding model | `BAAI/bge-small-en-v1.5` ONNX int8 (384-dim, MIT) |
| How the model is installed | Pre-installed manually by the owner into the persistent sandbox once. Never re-downloaded automatically. |
| Embedding location | Inside the persistent Vercel Sandbox (`nlt-agent`), called as a host tool from the embed route and from inside agent turns. |
| Mem0 env vars | Kept in Vercel for now (inert while `NLT_MEMORY_ENABLED=0`); removed from code. |

## 2. Architecture

### 2.1 Two embedding paths

The sandbox lock is held for exactly one agent turn at a time. The memory save route (`POST /api/memories`) runs outside any agent turn — it must not block on the lock. Two paths therefore exist:

**Path A — background embed (save time):**
`POST /api/memories` saves the row to Neon immediately (embedding `NULL`) and responds to the owner at once. It then fires a background request to `/api/embed` (no await). `/api/embed` acquires the sandbox lock with a short timeout (5 s); if the sandbox is busy with an agent turn, it returns 503 and the row stays `NULL`. The chat page ignores the embed result — the save already succeeded.

**Path B — in-turn embed (recall time):**
Inside `runAgentTurn`, after the crisis gate and before the Neon search, the runner embeds the query using the sandbox already locked for that turn (no second lock needed — the runner already holds it). It then runs the pgvector cosine search. Any memory rows still `NULL` at recall time are covered by the `pg_trgm` fallback.

This means:
- Every save is instant from the owner's perspective.
- Embeddings are eventually consistent: a memory saved during an active turn gets embedded on the next `/api/embed` call or the next recall, whichever comes first.
- Recall always works: pgvector for embedded rows, trigram for the rest.

### 2.2 Model location in the sandbox

```
/vercel/sandbox/models/bge-small/
  model.onnx        # ONNX int8 weights (~33 MB)
  tokenizer.json
  tokenizer_config.json
  vocab.txt
  special_tokens_map.json
  config.json
```

The runner script lives at `/vercel/sandbox/models/bge-small/embed.py` (installed with the model). It accepts one line of text on stdin, writes a JSON array of 384 floats to stdout.

### 2.3 Embed script

```python
#!/usr/bin/env python3
# embed.py — reads one text line from stdin, writes a 384-dim JSON vector to stdout.
# Requires: onnxruntime, numpy, transformers (tokenizer only)
import sys, json, numpy as np
import onnxruntime as ort
from transformers import AutoTokenizer

MODEL_DIR = "/vercel/sandbox/models/bge-small"
tokenizer = AutoTokenizer.from_pretrained(MODEL_DIR)
session = ort.InferenceSession(f"{MODEL_DIR}/model.onnx",
    providers=["CPUExecutionProvider"])

text = sys.stdin.readline().strip()
# bge-small uses CLS pooling; add the retrieval prefix for query use
inputs = tokenizer(text, return_tensors="np", truncation=True, max_length=512, padding=True)
outputs = session.run(None, {k: v for k, v in inputs.items()})
# CLS token is outputs[0][:, 0, :]
vec = outputs[0][0, 0, :]
vec = vec / (np.linalg.norm(vec) + 1e-9)
print(json.dumps(vec.tolist()))
```

No GPU required. CPU inference for a single 512-token input takes ~50–200 ms on the sandbox's 1 vCPU — acceptable for a personal tool.

## 3. Schema

Added to the existing Neon project (same `DATABASE_URL`). Schema is created once per process with `CREATE ... IF NOT EXISTS`, like the access and history tables.

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS memories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_sub     text NOT NULL,
  text          text NOT NULL,
  bucket        text NOT NULL CHECK (bucket IN ('owner', 'project')),
  source_msg_id uuid,
  embedding     vector(384),          -- NULL until embedded
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memories_owner
  ON memories (owner_sub, created_at DESC);

CREATE INDEX IF NOT EXISTS memories_embedding
  ON memories USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

CREATE INDEX IF NOT EXISTS memories_trgm
  ON memories USING gin (text gin_trgm_ops);
```

The `hnsw` index is only built over rows that have embeddings, so it stays small and accurate. The `gin` trigram index covers all rows for the fallback.

## 4. Neon memory store

`src/memory/neon-store.ts` implements `MemoryStore` (the same interface used by the existing Mem0 store and the fake store in tests) backed by Neon.

```
save(owner, input)
  → INSERT INTO memories (id, owner_sub, text, bucket, source_msg_id)
    VALUES (gen_random_uuid(), $1, $2, $3, $4)
    RETURNING id
  → fire-and-forget POST /api/embed { id, text } (no await, failure ignored)

list(owner)
  → SELECT id, text, bucket, source_msg_id, created_at
    FROM memories WHERE owner_sub = $1
    ORDER BY created_at DESC

get(owner, id)
  → SELECT ... WHERE id = $1 AND owner_sub = $2

remove(owner, id)
  → DELETE FROM memories WHERE id = $1 AND owner_sub = $2
    RETURNING id

search(owner, query, limit)
  → embed query (via sandbox runner, see §5)
  → if embedding available:
      SELECT id, text, bucket, source_msg_id, created_at
      FROM memories
      WHERE owner_sub = $1 AND embedding IS NOT NULL
      ORDER BY embedding <=> $queryVec
      LIMIT $limit
    union with trigram fallback for NULL-embedding rows:
      SELECT id, text, bucket, source_msg_id, created_at
      FROM memories
      WHERE owner_sub = $1 AND embedding IS NULL
        AND similarity(text, $query) > 0.1
      ORDER BY similarity(text, $query) DESC
      LIMIT $limit
    deduplicate by id, keep top $limit by relevance (vector rows first)
  → if embedding unavailable (sandbox not warmed, busy, etc.):
      trigram-only search over all rows
```

All statements are parameterised. All filter by `owner_sub`. No statement contains owner data in the query text.

## 5. Sandbox embed runner

`src/memory/sandbox-embed.ts` — called by the store's `search` and by `/api/embed`.

```typescript
export interface EmbedRunner {
  /** Embed one text string. Returns a 384-dim vector or null on failure. */
  embed(text: string, sandbox: SandboxLike, timeoutMs?: number): Promise<number[] | null>;
}
```

Implementation: `sandbox.runCommand({ cmd: "python3", args: [EMBED_SCRIPT_PATH, "--"], stdin: text, ... })`, parse stdout as JSON array of 384 numbers, validate length and all-finite. If the script exits non-zero or output is malformed, return `null` (caller falls back to trigram).

The sandbox is passed in — `sandbox-embed.ts` never creates one, acquires a lock, or reads credentials. The caller (the agent runner for recall, `/api/embed` for background embedding) is responsible for the sandbox handle.

### 5.1 Model path constants

```typescript
export const EMBED_MODEL_DIR = "/vercel/sandbox/models/bge-small";
export const EMBED_SCRIPT_PATH = `${EMBED_MODEL_DIR}/embed.py`;
export const EMBED_VECTOR_DIM = 384;
export const EMBED_TIMEOUT_MS = 10_000; // 10 s; first call after a cold wake may be slower
```

### 5.2 Validation

```typescript
function validateVector(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length !== EMBED_VECTOR_DIM) return null;
  if (!raw.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  return raw as number[];
}
```

## 6. The `/api/embed` route

`api/embed.ts` + `src/memory/embed-route.ts` — a new owner-only route.

- **Off** unless `NLT_MEMORY_ENABLED=1`. 404 otherwise.
- **401** without an owner session.
- **POST only.** Body: `{ id: UUID }`. Looks up the row in Neon (must exist and belong to the owner, must have `embedding IS NULL`). If already embedded, 200 `{ skipped: true }`.
- Acquires the sandbox lock via `withAgentSandbox` with a **5-second stale timeout** (not the agent's 15-minute stale age). If the sandbox is busy, 503 `{ busy: true }` — the caller retries later or ignores it.
- Runs `embedRunner.embed(text, sandbox)`. On failure: 503 `{ embedFailed: true }`.
- On success: `UPDATE memories SET embedding = $vec WHERE id = $1 AND owner_sub = $2 AND embedding IS NULL`.
- Returns 200 `{ embedded: true }`.
- Logs `{ event: "memory_embed", op: "done" | "failed" | "busy" | "skipped" }`. Never logs text, id, or owner.

The 5-second stale timeout means `/api/embed` will never wait more than ~5 seconds for the lock. In practice, if an agent turn is running it will get 503 immediately (the lock is held; the `mkdir` fails at once). The "stale" timeout only matters if the sandbox is in an unknown state.

**Important:** `/api/embed` uses a **separate lock path** (`/tmp/nlt-embed.lock`) from the agent turn lock (`/tmp/nlt-agent.lock`). Two embed calls therefore cannot overlap, but an embed and an agent turn can coexist in the sandbox without interfering with each other's lock. They share the same sandbox filesystem, so the model files are accessible to both.

Actually — re-examining this: two separate lock paths means two things running concurrently in the same sandbox, which could cause resource contention (CPU, memory). Given 1 vCPU and that the sandbox is personal/single-owner, the simpler and safer design is: `/api/embed` tries the **same agent lock** (`/tmp/nlt-agent.lock`) with a 0-second wait (just tries `mkdir` once). If it gets 503, the background embed is skipped for now. Recall will embed on the next agent turn anyway. This is simpler, avoids concurrent CPU use, and aligns with the single-sandbox, single-turn design.

## 7. Recall inside an agent turn

In `src/agent/runner.ts`, after the crisis gate passes and before the Pi session starts, recall now:

1. Checks `deps.recall` (same interface as today — `(prompt: string) => Promise<Memory[]>`).
2. `deps.recall` calls `neonStore.search(owner, prompt, limit)`.
3. `neonStore.search` calls `embedRunner.embed(prompt, sandbox)` using the **already-locked sandbox** (passed through deps).
4. Runs the pgvector + trigram search in Neon.
5. Each hit passes `recallChecks` (unchanged from MEM-001).
6. Injected as untrusted background (unchanged).

The `sandbox` handle needs to flow from `withAgentSandbox` into `deps.recall`. The runner already receives the sandbox inside the `withAgentSandbox` callback — `deps.recall` becomes a factory that receives the sandbox: `deps.recallFactory?: (sandbox: SandboxLike) => (prompt: string) => Promise<Memory[]>`.

## 8. Wiring in `api/agent.ts` and `api/memories.ts`

**`api/agent.ts`** — replace the Mem0 recall lambda with a Neon+pgvector one:

```typescript
recallFactory: (sandbox) => (prompt) =>
  createNeonMemoryStore(neonSql, embedRunner(sandbox))
    .search(owner, prompt, recallLimit)
    .then(hits => hits.filter(m => recallChecks(m.text)))
```

**`api/memories.ts`** — replace `createMem0Store(memoryClient(env))` with `createNeonMemoryStore(neonSql)`. The `save` implementation fires the background embed; list/get/remove are pure Neon.

Remove all Mem0 client imports. `MEM0_*` env vars are no longer read in code (kept in Vercel, inert).

## 9. Owner setup (one-time, manual)

Before enabling `NLT_MEMORY_ENABLED=1`, the owner installs the model into the sandbox once:

```bash
# From inside the Vercel Sandbox (via the agent or a direct sandbox shell)
mkdir -p /vercel/sandbox/models/bge-small
cd /vercel/sandbox/models/bge-small

# Download bge-small-en-v1.5 ONNX int8 weights from the ONNX Community hub
# (~33 MB; requires pip and curl/wget, both available in the sandbox)
pip install -q onnxruntime numpy transformers

# Download model files (public HF Hub — already reachable via github.com preset? No.)
# The sandbox git preset covers github.com but not huggingface.co.
# Option: owner downloads the files locally and writes them into the sandbox via
# the agent's write tool, or uses the agent to run:
python3 -c "
from transformers import AutoTokenizer
import urllib.request, os
BASE = 'https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/main'
FILES = ['config.json','tokenizer.json','tokenizer_config.json',
         'vocab.txt','special_tokens_map.json']
for f in FILES:
    urllib.request.urlretrieve(f'{BASE}/{f}', f)
# ONNX int8 weights
urllib.request.urlretrieve(
    'https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/onnx/model_quantized.onnx',
    'model.onnx')
print('done')
"
# Then write embed.py (see §2.3)
```

**Egress note:** `huggingface.co` is not in the current egress preset. For this one-time install the owner sets `NLT_AGENT_EGRESS_ALL=1` temporarily, runs the install turn, then removes it. Alternatively the owner uses the access-request feature (`NLT_ACCESS_REQUESTS=1`) to approve `huggingface.co` for one turn. After install the model lives in the persistent sandbox filesystem and no further network access to HF is needed.

After install, the owner verifies:
```bash
echo "test embedding" | python3 /vercel/sandbox/models/bge-small/embed.py
# should print a JSON array of 384 numbers
```

## 10. Environment variables

| Variable | Change | Notes |
|---|---|---|
| `NLT_MEMORY_ENABLED` | unchanged | Off unless `1` |
| `NLT_MEMORY_RECALL_LIMIT` | unchanged | Default 5 |
| `DATABASE_URL` | unchanged | Already present |
| `MEM0_API_KEY` | removed from code | Kept in Vercel (inert) |
| `MEM0_ORG_ID` | removed from code | Kept in Vercel (inert) |
| `MEM0_PROJECT_ID` | removed from code | Kept in Vercel (inert) |
| `MEM0_BASE_URL` | removed from code | Kept in Vercel (inert) |

No new environment variables.

## 11. What changes vs. what stays the same

**Unchanged:**
- `MemoryStore` interface (`src/memory/store.ts`)
- `src/memory/route.ts` and all its tests
- `recallChecks`, `writeChecks` (ASFDK checks)
- The runner's recall injection pattern (untrusted background block)
- The invariant: no code reachable from `runAgentTurn` can write to the memory store
- The chat page UI (Remember this, Memories panel, data notice)
- `api/memories.ts` HTTP contract (same routes, same response shapes)
- All existing memory-route tests pass without modification

**New:**
- `src/memory/neon-store.ts` — `MemoryStore` backed by Neon
- `src/memory/sandbox-embed.ts` — `EmbedRunner` over `SandboxLike`
- `src/memory/embed-route.ts` — testable handler for `POST /api/embed`
- `api/embed.ts` — Vercel handler for the embed route
- `mvp/vercel.json` — add `api/embed.ts` with `maxDuration: 30`
- Neon schema additions (`memories` table, `vector` + `pg_trgm` extensions, `hnsw` index)
- `AgentRunnerDeps.recallFactory` replaces `recall` (receives sandbox handle)
- `api/agent.ts` — swap Mem0 recall for Neon+pgvector recall factory
- `api/memories.ts` — swap `createMem0Store` for `createNeonMemoryStore`

**Removed:**
- `src/memory/client.ts` (Mem0 HTTP client) — deleted
- `createMem0Store` from `src/memory/store.ts` — deleted
- Mem0 imports from `api/memories.ts`

## 12. Testing

All tests run offline (no real sandbox, no real Neon, no real model).

**`test/neon-memory-store.test.ts`:**
- Schema created once; all statements parameterised and owner-scoped
- `save` inserts and fires background embed (no await on embed)
- `list`/`get`/`remove` owner-filter invariants
- `search`: uses vector when embed returns a vector; falls back to trigram when embed returns null; deduplicates; caps at limit
- Another owner's row is never returned
- Mutation checks: removing owner filter makes a test fail

**`test/sandbox-embed.test.ts`:**
- Valid output parsed to `number[384]`
- Wrong length, non-finite values, non-JSON each return `null`
- Non-zero exit code returns `null`
- Timeout returns `null`
- Text is passed via stdin, not as a shell argument (injection safety)

**`test/embed-route.test.ts`:**
- 404 when off, 401 without owner, 405 wrong method
- 503 when sandbox busy; 200 `{ skipped }` when already embedded
- 200 `{ embedded }` on success; UPDATE scoped to owner
- Logs operation name only (no text, no id in log)

**`test/agent-runner.test.ts` additions:**
- `recallFactory` receives the sandbox handle; recall result injected before the Pi session
- Recall failure (embed returns null, trigram fallback) does not block the turn
- A blocked prompt never calls `recallFactory`

**Mutation checks** on each owner-filter, the embed-null fallback, and the blocked-prompt guard.

**Not verifiable offline:**
- Real sandbox execution of `embed.py`
- Real pgvector cosine search in Neon
- Cold-wake latency of the embed script (~50–200 ms warm, potentially longer on first wake)
- That `pg_trgm` and `vector` extensions are enabled in the Neon project (owner runs `CREATE EXTENSION` once)

## 13. Rollout

1. Owner installs model into sandbox (§9) and enables extensions in Neon (`CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;`).
2. Merge with `NLT_MEMORY_ENABLED` unset: no change in behaviour.
3. Owner sets `NLT_MEMORY_ENABLED=1` in production and redeploys.
4. Live check: save a memory, send a related prompt, confirm the memory appears in the agent's context.

## 14. Known limits

- The model is only available if the persistent sandbox is warm and the files are intact. A sandbox reset (rare, but possible) requires re-running the install. A future improvement could detect missing model files and surface a clear error rather than silently falling back to trigram.
- Recall latency includes the embed script startup (~100–500 ms cold Python import). Subsequent calls in the same sandbox session are faster (~50 ms warm).
- A sandbox reset would also lose the `gh` login (existing known limit, documented in NLTPI-MVP-005).
- The `hnsw` index is only useful once there are more than a few dozen memories. For small counts, a sequential scan with cosine distance is equivalent.
- `pg_trgm` similarity for English short facts is adequate for simple keyword overlap but is not semantic. Memories without embeddings get lower-quality recall until the background embed runs.

## 15. Governance records

Implementation PR adds: intent record (`docs/agent-log/intent/`), agent registration (`docs/agent-log/registrations/`), handoff (`docs/agent-log/handoffs/`), and updates `docs/active-threads.md` (NLTPI-MEM-003) and `mvp/README.md` (Memory section, platform table row for Neon replacing Mem0).

# Mem0 memory layer — design (phase 1 build, phase 2 outlined)

**Date:** 2026-11-05
**Owner:** Joshua W. Dorsey, Sr.
**Status:** implemented (phase 1)
**Scope:** `mvp/` (NLT Coding Agent MVP on Vercel, project `nlt-pi-mvp`). Builds on nlt-pi#35 (chat history in Neon, merged).
**Builder:** coding agent

## 1. Intent

- **Outcome:** the agent stops forgetting between conversations. Facts the owner approves are recalled in later conversations.
- **For whom:** the signed-in owner only.
- **Success:**
  1. The owner can save a message (optionally edited) as a memory, list memories, and delete them.
  2. In a later conversation the agent has the relevant approved memories in its context.
  3. No model output can create, change or delete a memory.
  4. A blocked prompt, or any text the checks reject, never reaches Mem0.
  5. The model never sees a store id, key or Mem0 address.

### Decisions (owner, 2026-11-05)

| Question | Decision |
|---|---|
| What Mem0 is for first | Learned memories only. TOI/OTOI come in phase 2. |
| Buckets | `owner` (preferences, how the owner works) and `project` (nlt-pi conventions, gotchas, fixes). |
| Who creates a memory | Only the owner, with "Remember this" on a message. The owner's explicit act is the approval. |
| Gate | Every Mem0 read and write passes ASFDK checks. Anything but an explicit allow stops the call (fail closed). |
| Model access | The agent has no Mem0 tool. Only the host reads and writes. |
| New integration approval | The owner approves Mem0 as a new external integration and third-party processor (NLT-DEV-OTOI). Recorded in the intent record. |

### Interim consent rule (until phase 2)

Nothing persists unless the owner approves that specific memory, and the feature is off unless the owner sets `NLT_MEMORY_ENABLED=1`. Phase 2 replaces this with the TOI's `privacy.retention` (`user-controlled`) as the grant of permission.

### Out of scope

- TOI, OTOI, signing, charter (phase 2).
- Agent-suggested memories, and any background job that distils memories from Neon transcripts.
- Sleepwalker's emotional-continuity role. Mem0 holds facts and preferences only.
- Neon Auth, Neon realtime, multi-user memory.
- Changes to `/api/govern`, the crisis gate, or `/api/conversations`.

## 2. Design

### 2.1 Where things live

- **Neon** keeps the exact transcript (unchanged).
- **Mem0** keeps short, approved facts. Each stores `user_id` = the owner's session `sub` (server-side only), `agent_id` = `nlt-pi-mvp`, and metadata `bucket` (`owner` | `project`), `repo` = `nlt-pi`, `source_message_id` (a pointer to the Neon message), `created_at`.
- One fact per memory, short and specific. Never code, secrets or anything governance repos own.

### 2.2 Save flow ("Remember this")

1. The page posts `{ text, bucket, sourceMessageId }` to `api/memories.ts`.
2. The server checks the switch, the owner session, and validation limits.
3. The source message must exist in Neon, belong to the owner, and not be `blocked` or `unavailable`. (Requires `NLT_HISTORY_ENABLED=1`.) Blocked messages are stored without text, so they can never be remembered.
4. The text passes the write checks (section 3).
5. Stored in Mem0 verbatim, with no rewriting by Mem0.
6. Answer `{ saved: true, id }`.

### 2.3 Recall flow (per turn, in the runner)

1. Crisis gate on the prompt (unchanged). A turn that is not clearly allowed does not start. **This runs before any Mem0 call, so a blocked prompt is never sent as a search query.**
2. If `NLT_MEMORY_ENABLED=1`: search Mem0 with the prompt, scoped to the owner and agent, limit `NLT_MEMORY_RECALL_LIMIT` (default 5).
3. Each hit passes the recall checks. A hit that fails is skipped.
4. Remaining hits go into the system prompt in a delimited block marked as untrusted background, never as instructions.
5. Run the turn. The turn writes nothing to Mem0.
6. If Mem0 or the checks are unavailable, the turn runs without recall.

### 2.4 Routes (owner-only, `Cache-Control: no-store`; 404 when the switch is off; 401 without the owner session)

| Method | Behaviour |
|---|---|
| `GET api/memories` | List the owner's memories (id, text, bucket, created, source). |
| `POST api/memories` | Save one (section 2.2). |
| `DELETE api/memories?id=` | Delete one; 404 if not the owner's. |

Limits: text 1–500 characters, at most 200 memories, body ≤ 64 KB, ids are Mem0 ids or UUIDs as returned. The owner always comes from the session, never the body.

### 2.5 Page

A "Remember this" action on each message (with a bucket choice and an editable text box), a Memories panel (list, delete), and a notice that memory is on and sends prompts to Mem0. Behaviour is unchanged when the switch is off or the route answers anything but 200, as with history. Page text is written with `textContent` only.

## 3. Checks (all fail closed)

- **Write:** deterministic checks first, from `@neurolift-technologies/asfdk`: `validateInputLength`, `sanitizeInput`, `detectInjectionPatterns`. Then the source-message rule (2.2 step 3).
- **Recall:** the same deterministic checks on each hit before it is injected. A recalled memory is untrusted text.
- An LLM review may add advice but never decides.
- A missing or erroring check counts as a block.

### Invariant: no model-driven change

No code reachable from a model turn can create, change or delete a memory. The Mem0 write client and the Mem0 credentials are not passed into the turn or the sandbox. A test fails if any function reachable from `runAgentTurn` imports the Mem0 write client or an owner-route handler.

## 4. Configuration (names only; values live in Vercel)

| Setting | Notes |
|---|---|
| `NLT_MEMORY_ENABLED` | Owner-set. Off unless `1`. Off means no Mem0 call and today's behaviour. |
| `MEM0_API_KEY`, `MEM0_ORG_ID`, `MEM0_PROJECT_ID`, `MEM0_BASE_URL` | Already present. Server only. Never in the sandbox. |
| `NLT_MEMORY_RECALL_LIMIT` | Optional, default 5. |

## 5. Failure behaviour

| Situation | Result |
|---|---|
| Switch off | No Mem0 call; no change. |
| Mem0 unavailable on recall | Turn runs without memories; log the operation name only. |
| Check blocks or errors on recall | That memory is skipped. |
| Check blocks or errors on save | 400/503; nothing stored. |
| `DATABASE_URL`/history off when saving | 503 "History unavailable"; nothing stored. |

Logs carry the operation name only (for example `{"event":"memory_error","op":"recall"}`): never text, ids, queries or keys.

## 6. Testing (offline; no test reaches Mem0)

- Route tests: 404 off, 401, 405 with `Allow`, each 400 rule, owner from session only, another owner's id gives 404, nothing written on failure.
- Save: a blocked/unavailable/other-owner source message is refused; an injection-pattern text is refused.
- Recall: an injected instruction in a memory is skipped; checks unavailable skips the memory; Mem0 down means the turn still runs.
- A blocked prompt never reaches the Mem0 client (the crisis gate runs first).
- The invariant test (section 3) and mutation checks: removing the owner filter, the source-message rule or the recall checks each makes a test fail.
- Page helpers tested with `node --test`.

**Not verified offline: real Mem0 behaviour.** Before relying on it, probe once and record the result:
- (a) storing text verbatim without rewriting (`infer=false` or equivalent);
- (b) filtering and scoping by user, agent and metadata;
- (c) the size limits and how search ranks short facts;
- (d) delete semantics (hard delete?);
- (e) Mem0's data retention and model-training terms.
If (a) fails, stop and report; do not build around rewriting.

Probe results are recorded in `docs/superpowers/specs/2026-11-06-mem0-probe-results.md` (pending owner verification against live Mem0).

## 8. Governance and records

- Intent record under `docs/agent-log/` before implementation (new third-party processor and persistence boundary).
- Update `mvp/README.md` (memory section; the Mem0 row of "Platforms and services" from nlt-pi#36), `docs/active-threads.md`, and a handoff record.
- The PR follows `PULL_REQUEST_TEMPLATE.md`. `NLT_MEMORY_ENABLED` is set only by the owner.

## 9. Open items for the owner

- Confirm the ASSUMED v1 rule: memories are created only by the owner's "Remember this".
- Review the probe results before enabling the switch in Production.

## 10. Phase 2 outline: TOI and OTOI as standing terms (own spec before building)

Agreed requirements, recorded so nothing is lost:

- **Where they live:** never in any repo. The owner's local `.toi` and `.otoi` (home directory, located by user-level `ASFDK_TOI_PATH` / `ASFDK_OTOI_PATH`) are the authoring source. The signed copy is uploaded to Mem0 through an owner-only route. The private signing key never goes in an environment variable, a repo, Vercel or Mem0.
- **Authoring:** `@neurolift-technologies/toi` → `extractToi` (deterministic) → `TOIDocumentGenerator.fromDict` → `toMarkdown()` review → `signToi`. Review `custom.freeform_terms` (the owner's original text is kept in the signed document) and strip it if wanted.
- **Verification on every turn:** `$signature.public_key` must equal the pinned `NLT_TOI_PUBKEY`, then `verifyToi` (`verifyToi` alone checks only the embedded key). Status must be fully verified, never unsigned.
- **Charter:** the `.otoi` charter is not signed (charter signing is reserved in the spec), so pin its SHA-256 in `NLT_OTOI_SHA256`. Use `strict` mode, `audit: true`, agent id `nlt-pi-mvp`. `honor(charter, { loadSource })`, where `loadSource` returns the verified TOI text; then `propagate`.
- **Sparse document:** use the verified document as signed for `honor`; `fromDict` strips `$signature` and fills defaults, which would make gaps terminal for a personal-tier document. Report this to nlt-toi.
- **What reaches the model:** host-written behaviour notes from a fixed template over recognised enum fields (communication, agency, ethical pillars, privacy floor). Never `identity`, `cognitive_profile`, `custom`, `$`-keys, URIs or raw JSON. The model never sees the file or its location.
- **Retention:** the TOI sets `privacy.retention = user-controlled`. Persistence is allowed for `long-term`, `permanent` or `user-controlled`; `session-only` and `short-term` turn learned memories off. This replaces the interim consent rule.
- **If the TOI cannot be verified:** run on the generator's privacy-first default TOI, tell the owner, and turn learned-memory recall and writes off for that turn.
- **Invariant:** no model output can change a TOI or charter; the agent can only propose changes as text. Write authority is possession of the private key.
- **Follow-up in `asfdk-harness`:** add `.toi` and `.otoi` to the protected-path list and make the owner's files read-only.
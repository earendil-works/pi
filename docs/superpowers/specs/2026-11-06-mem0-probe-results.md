# Mem0 probe results — phase 1 (pre-enablement)

**Date:** 2026-11-06
**Owner:** Joshua W. Dorsey, Sr.
**Status:** pending — not verified against live Mem0
**Purpose:** Record probe results (a)–(e) from the phase-1 design spec before enabling `NLT_MEMORY_ENABLED=1` in Production.

## (a) Storing text verbatim without rewriting

**Expected:** `infer: false` (or equivalent) in the Mem0 create payload; Mem0 stores text verbatim with no rewriting.

**Implementation:** `mvp/src/memory/client.ts` sends `infer: false` in the POST `/v1/memories/` body.

**Status:** ❌ Not verified offline. No live Mem0 connection available in the sandbox.

**Owner action:** Before enabling `NLT_MEMORY_ENABLED=1`, perform a test write with `infer: false` and confirm the stored text matches the input exactly (no summarization, no rephrasing, no entity extraction).

**Blocker if fails:** Do not build around rewriting. Stop and report to the owner per spec §6.

## (b) Filtering and scoping by user, agent and metadata

**Expected:** Mem0 search returns only memories matching `user_id` and `agent_id`; metadata fields (`bucket`, `repo`, `source_message_id`, `created_at`) are queryable/preserved.

**Implementation:** `mvp/src/memory/client.ts` scopes all calls with `user_id` = owner and `agent_id` = `nlt-pi-mvp`. Metadata includes `bucket`, `repo`, `source_message_id`, `created_at`.

**Status:** ❌ Not verified offline.

**Owner action:** Confirm that Mem0 search respects `user_id`/`agent_id` scoping and that metadata is returned with results.

## (c) Size limits and search ranking

**Expected:** Mem0 enforces its own size limits (observed: 5000 char max input length from `@neurolift-technologies/asfdk`'s `validateInputLength`, but Mem0's own limits may differ). Search ranks short facts appropriately.

**Implementation:** Application limits text to 500 chars (route validation). `NLT_MEMORY_RECALL_LIMIT` defaults to 5.

**Status:** ❌ Not verified offline.

**Owner action:** Confirm Mem0's per-memory size limit and search ranking behavior for short facts.

## (d) Delete semantics

**Expected:** Delete is hard delete (memory is removed, not soft-deleted or hidden).

**Implementation:** `mvp/src/memory/client.ts` `remove()` verifies ownership via `GET /v1/memories/{id}` before calling `DELETE /v1/memories/{id}`, preventing cross-owner deletion.

**Status:** ❌ Not verified offline.

**Owner action:** Confirm that deleted memories are not recoverable and that `DELETE` returns success only for existing, owned memories.

## (e) Data retention and model-training terms

**Expected:** Mem0's data retention policy and whether stored memories are used for model training.

**Implementation:** None — this is a terms-of-service question, not code.

**Status:** ✅ Owner-reported (2026-11-06): **Mem0 trains on data on the free plan.** This conflicts with keeping owner memories private.

**Owner action:** Treat as a blocker for enabling learned memories on the current Mem0 free plan. Before enablement, decide one of: (1) do not use Mem0 for memories on the free plan; (2) confirm/obtain a plan or setting that disables training and meets retention requirements; (3) move memory storage to a provider/architecture that satisfies privacy requirements. Record the chosen option and any terms evidence.

## Summary

| Probe item | Status | Blocker for enablement |
|---|---|---|
| (a) Verbatim storage (`infer=false`) | Not verified | Yes — stop and report if fails |
| (b) User/agent/metadata scoping | Not verified | Recommended |
| (c) Size limits and search ranking | Not verified | Recommended |
| (d) Delete semantics (hard delete) | Not verified | Recommended |
| (e) Retention and model-training terms | **Owner-reported (2026-11-06): trains on data on the free plan** | **Yes — blocker on current plan** |

**Recommendation:** Keep `NLT_MEMORY_ENABLED` disabled. Do not enable learned memories on the Mem0 free plan given training-on-data. Resolve by choosing a compliant plan/setting, a different memory provider, or deferring Mem0 memory; still verify (a) before any enablement.
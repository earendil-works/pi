# NLT-Pi Intent Record

**Date:** 2026-11-06
**Agent / session:** Cline
**Branch:** feat/mvp-mem0-memory-layer (phase 2 build)
**OTOI:** NLT-PI-DEV-OTOI-1.0.1

## Intended action

Implement the TOI and OTOI standing terms layer (phase 2 of the Mem0 memory layer), following the owner-approved spec `docs/superpowers/specs/2026-11-06-toi-otoi-standing-terms-design.md`:

1. `mvp/src/toi/loader.ts` — Load `.toi`/`.otoi` from `ASFDK_TOI_PATH`/`ASFDK_OTOI_PATH` (home-directory defaults). Server side only, never throws.
2. `mvp/src/toi/verifier.ts` — TOI: `$signature.public_key` must equal pinned `NLT_TOI_PUBKEY`, then `verifyToi`. OTOI: SHA-256 must equal pinned `NLT_OTOI_SHA256`. Fail closed, op-name-only logging.
3. `mvp/src/toi/retention.ts` — `memoryAllowedByRetention(effectiveDoc)` from `privacy.retention` (`user-controlled`/`long-term`/`permanent` allow; `session-only`/`short-term`/missing deny). Replaces phase-1 interim consent rule.
4. `mvp/src/toi/honorer.ts` — `honorAndPropagate(toiText, otoiText)`: parse TOI, optionally honor OTOI charter with `strict`+`audit`+agent `nlt-pi-mvp`, propagate, build host-written behaviour notes from enum fields only.
5. `mvp/src/toi/index.ts` — Barrel export.
6. `mvp/src/agent/runner.ts` — Add `memoryPolicy` dep (`allowed`, `behaviourNotes`). Gate Mem0 recall on `allowed`. Inject behaviour notes + recalled memories into prompt prefix.
7. `mvp/api/memories.ts` — Add `POST /api/memories/toi`: owner-only upload of signed `.toi` to Mem0. Validates signature, public key pin, `verifyToi`. Stores with metadata `{ kind: "toi", source: "owner-upload" }`.
8. `test/toi.test.ts` — 16 vitest tests (verifier, retention).
9. `docs/superpowers/specs/2026-11-06-toi-otoi-standing-terms-design.md` — Full phase-2 design spec.
10. `mvp/README.md` — TOI/OTOI section.

## Rationale

Phase 1 (Mem0 memory layer) made learned memories opt-in via `NLT_MEMORY_ENABLED=1`. Phase 2 replaces that interim consent rule with the TOI's `privacy.retention` as the governing permission, and adds standing terms (communication, agency, ethical pillars, privacy floor) that shape the agent's behaviour via host-written notes injected into the model context.

## Risks and trust boundaries

- **Standing terms are not executable.** `.toi`/`.otoi` are declarative data. Behaviour notes are host-written templates over enum fields — the model never sees raw JSON, `$`-keys, `identity`, `cognitive_profile`, `custom`, or file locations.
- **No model-driven change.** The TOI/OTOI loader, verifier, and private key are never passed into the turn or the sandbox. Write authority is possession of the private key, held only by the owner locally.
- **Fail closed.** Missing/unset pins, key mismatches, failed signatures, and honoring failures all result in the turn running without standing terms (or with TOI-only behaviour), logging the operation name only.
- **Retention governs memory.** `session-only`/`short-term` turn learned-memory recall and writes off. Unverifiable TOI → privacy-first default TOI, memory off.
- **Private key never reaches the server.** It stays on the owner's local machine. Only the signed `.toi` (with public key) is uploaded to Mem0 via the owner-only route.
- **New dependency:** `@neurolift-technologies/toi` 1.0.3 and `@neurolift-technologies/otoi` 1.2.0 (already in workspace lockfile).

## Rollback

Unset `NLT_TOI_PUBKEY` and `NLT_OTOI_SHA256` (TOI/OTOI verification becomes unavailable, memory follows phase-1 `NLT_MEMORY_ENABLED` switch), or revert the PR. No data is written unless the owner uploads a signed TOI via the new route.
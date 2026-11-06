# TOI and OTOI as standing terms — design (phase 2)

**Date:** 2026-11-06
**Owner:** Joshua W. Dorsey, Sr.
**Status:** spec
**Scope:** `mvp/` (NLT Coding Agent MVP on Vercel, project `nlt-pi-mvp`). Builds on the Mem0 memory layer (phase 1) and the ASFDK harness.
**Builder:** coding agent

## 1. Intent

- **Outcome:** the agent's standing terms (how it communicates, what agency it may exercise, how it treats the owner's data) come from the owner's signed `.toi` and `.otoi` files, verified on every turn, and enforced through the ASFDK honoring layer.
- **For whom:** the signed-in owner only.
- **Success:**
  1. The owner's local `.toi` and `.otoi` files (in their home directory) are the source of truth for the agent's standing terms.
  2. On every turn, the `.toi` signature is verified against the pinned `NLT_TOI_PUBKEY`, and the `.otoi` checksum is verified against the pinned `NLT_OTOI_SHA256`.
  3. The effective policy is applied to the agent via `honor`/`propagate` with agent id `nlt-pi-mvp`, `strict` mode, `audit: true`.
  4. Host-written behaviour notes (from enum fields only) reach the model; the model never sees the `.toi`/`.otoi` files or their locations.
  5. `privacy.retention` from the verified TOI governs learned-memory persistence: `session-only`/`short-term` turn learned-memory recall and writes off; `long-term`/`permanent`/`user-controlled` allow them. This replaces the phase-1 interim consent rule (`NLT_MEMORY_ENABLED=1`).
  6. No model output can change a TOI or OTOI; the agent can only propose changes as text. Write authority is possession of the private key.
  7. The private signing key never goes in an environment variable, a repo, Vercel, or Mem0.

## 2. Decisions (owner)

| Question | Decision |
|---|---|
| Where TOI/OTOI live | Owner's local home directory (`ASFDK_TOI_PATH` / `ASFDK_OTOI_PATH`, user-level env). Never in any repo. |
| Where signed copy goes | Uploaded to Mem0 through an owner-only route (phase 2 addition to `/api/memories`). |
| Private key | Never in an env var, repo, Vercel, or Mem0. Owner holds it locally. |
| TOI verification | `$signature.public_key` must equal pinned `NLT_TOI_PUBKEY`; then `verifyToi`. Fully verified or not at all. |
| OTOI verification | SHA-256 of the charter must equal pinned `NLT_OTOI_SHA256`. |
| Honoring | `honor(charter, { loadSource })` with `strict` mode, `audit: true`, agent id `nlt-pi-mvp`; then `propagate(policy, "nlt-pi-mvp")`. |
| What reaches the model | Host-written behaviour notes from a fixed template over recognized enum fields (communication, agency, ethical pillars, privacy floor). Never `identity`, `cognitive_profile`, `custom`, `$`-keys, URIs, or raw JSON. |
| Retention → memory | `privacy.retention = user-controlled` (or `long-term`/`permanent`) allows learned memories. `session-only`/`short-term` turn learned-memory recall and writes off for that turn. |
| Unverifiable TOI | Run on the generator's privacy-first default TOI, tell the owner, turn learned-memory recall and writes off for that turn. |

## 3. Where things live

- **Owner's home directory:** `.toi` and `.otoi` files, located via `ASFDK_TOI_PATH` / `ASFDK_OTOI_PATH` (user-level env vars). These are the authoring source. Never in any repo.
- **Mem0:** the signed `.toi` copy is uploaded to Mem0 through an owner-only route (phase 2 addition). The public key and checksum are pinned in env; the private key never reaches Mem0.
- **Vercel env:** `NLT_TOI_PUBKEY` (pinned public key), `NLT_OTOI_SHA256` (pinned charter checksum), `ASFDK_TOI_PATH`, `ASFDK_OTOI_PATH`. Server only.
- **Not in any repo:** the `.toi`/`.otoi` files themselves, and the private signing key.

## 4. Authoring flow (offline, owner-local)

The owner authors locally, never through the model:

1. Write freeform terms (natural language).
2. `extractToi(input)` → deterministic `SafeParseResult` (from `@neurolift-technologies/toi`).
3. `TOIDocumentGenerator.fromDict(extracted.document)` → fills privacy-first defaults, strips any `$signature`.
4. Review `toMarkdown()` output. Review `custom.freeform_terms` (the owner's original text is kept in the signed document); strip it if wanted.
5. `signToi(document, privateKey)` → signed `.toi` with `$signature`.
6. Upload the signed copy to Mem0 through the owner-only route (phase 2). The public key (`$signature.public_key`) is pinned as `NLT_TOI_PUBKEY`.
6. Upload the signed copy to Mem0 through the owner-only route (phase 2). The public key (`$signature.public_key`) is pinned as `NLT_TOI_PUBKEY`.

## 5. Verification on every turn

For every agent turn, before memory recall:

1. **Load TOI:** read `.toi` from `ASFDK_TOI_PATH` (or home-directory default). Parse with `parseToi`.
2. **Verify TOI:**
   - `$signature.public_key` must equal the pinned `NLT_TOI_PUBKEY`.
   - `verifyToi(document)` must return `true`.
   - Either failure → unverifiable (see section 8).
3. **Load OTOI:** read `.otoi` from `ASFDK_OTOI_PATH`. Parse with `parseCharter`.
4. **Verify OTOI:** SHA-256 of the charter text must equal the pinned `NLT_OTOI_SHA256`.
5. **Honor:** `honor(charter, { loadSource })` where `loadSource(uri)` returns the verified TOI text. Use `strict` mode, `audit: true`.
6. **Propagate:** `propagate(policy, "nlt-pi-mvp")` → effective `.toi` for this agent.
7. **Build behaviour notes:** host-written template over enum fields of the effective policy (communication, agency, ethical pillars, privacy floor).
8. **Retention check:** `privacy.retention` from the effective policy:
   - `user-controlled` / `long-term` / `permanent` → learned memories allowed.

## 6. What reaches the model

Host-written behaviour notes only, from a fixed template over these recognized enum fields:

| Section | Fields (enum) | Notes |
|---|---|---|
| `communication` | `tone`, `verbosity`, `structure`, `language`, `jargon_tolerance` | Behaviour notes |
| `agency` | `task_initiation`, `ai_suggestions`, `interruptibility`, `action_confirmation`, `override_authority` | Behaviour notes |
| `ethical_pillars` | array of strings | Listed as pillars |
| `privacy` | `retention` | Governs memory on/off (section 5) |

Never reach the model: `identity`, `cognitive_profile`, `custom`, `$`-keys (`$toi`, `$tier`, `$signature`, etc.), URIs, raw JSON, the `.toi`/`.otoi` files, or their locations.

The model never sees the file or its location. Behaviour notes are host-written, delimited as standing terms, never as instructions from the model.
   - `session-only` / `short-term` → learned-memory recall and writes off for this turn.

## 7. Failure behaviour

| Situation | Result |
|---|---|
| `NLT_TOI_PUBKEY` unset | TOI unverifiable; run on default TOI; memory off for this turn. |
| TOI signature key mismatch | TOI unverifiable; run on default TOI; memory off for this turn. |
| `verifyToi` returns false | TOI unverifiable; run on default TOI; memory off for this turn. |
| `NLT_OTOI_SHA256` unset or mismatch | OTOI unverifiable; run without charter honoring; use TOI alone; memory follows TOI retention. |
| `honor`/`propagate` fails | Turn runs with TOI-only effective policy; log op name only. |
| TOI cannot be verified at all | Run on `DEFAULT_DOCUMENT` (privacy-first default from `@neurolift-technologies/toi`); tell the owner; turn learned-memory recall and writes off for that turn. |

Logs carry the operation name only (e.g. `{"event":"toi_error","op":"verify"}`): never text, keys, checksums, or file contents.

## 8. Unverifiable TOI fallback

When the TOI cannot be verified (missing, wrong key, bad signature, unparseable):

1. Use `TOIDocumentGenerator.fromDefaults("nlt-pi-mvp")` → `DEFAULT_DOCUMENT`-based privacy-first TOI.
2. Log `{"event":"toi_error","op":"verify"}` (op name only).
3. Tell the owner (via the page/status) that TOI verification failed and learned memory is off for this turn.
4. Learned-memory recall and writes are off for that turn (replacing the interim consent rule).
5. The turn still runs; the agent uses the default privacy-first TOI.

## 9. Retention → learned memory (replaces interim consent rule)

The phase-1 interim rule (`NLT_MEMORY_ENABLED=1` gates all memory) is replaced by the TOI's `privacy.retention`:

| `privacy.retention` | Learned-memory recall | Learned-memory writes |
|---|---|---|
| `user-controlled` | allowed | allowed |
| `long-term` | allowed | allowed |
| `permanent` | allowed | allowed |
| `session-only` | off | off |
| `short-term` | off | off |
| TOI unverifiable / missing | off | off |

When retention turns memory off, the runner skips Mem0 recall and the save route refuses writes (503 "Memory off by retention"). The page shows the effective state.

## 10. Routes (additions to `/api/memories`)

| Method | Behaviour (phase 2 additions) |
|---|---|
| `POST /api/memories/toi` | Upload the owner's signed `.toi` to Mem0. Owner session required. Body `{ signedToi: ToiDocument }`. Validates `$signature` present, `$signature.public_key` == `NLT_TOI_PUBKEY`, `verifyToi` true. Stores to Mem0 with `user_id` = owner, `agent_id` = `nlt-pi-mvp`, metadata `{ kind: "toi", source: "owner-upload" }`. Answers `{ uploaded: true, id }`.

## 11. Configuration (names only; values live in Vercel / owner env)

| Setting | Notes |
|---|---|
| `NLT_TOI_PUBKEY` | Pinned public key (base64url). Server only. Never in the sandbox. |
| `NLT_OTOI_SHA256` | Pinned SHA-256 of the `.otoi` charter. Server only. |
| `ASFDK_TOI_PATH` | User-level env; path to owner's `.toi` file. Home-directory default if unset. |
| `ASFDK_OTOI_PATH` | User-level env; path to owner's `.otoi` file. Home-directory default if unset. |
| `NLT_MEMORY_ENABLED` | Phase-1 switch; superseded by TOI retention for the memory decision (kept for backward compat / explicit opt-out). |

## 12. Invariant: no model-driven change

No code reachable from a model turn can change a TOI or OTOI. The TOI/OTOI loader, verifier, and private key are never passed into the turn or the sandbox. The agent can only propose changes as text (e.g. in chat); write authority is possession of the private key, held only by the owner locally.

## 13. Follow-up in `asfdk-harness`

- Add `.toi` and `.otoi` to the protected-path list.
- Make the owner's `.toi`/`.otoi` files read-only in the harness.

These are harness-level changes outside `mvp/` and are recorded here for tracking, not implemented in this phase.

## 14. Testing (offline; no test reaches Mem0 or the filesystem paths of real TOI/OTOI)

- Loader tests: reads `.toi`/`.otoi` from injected paths; returns content or undefined.
- Verifier tests: valid TOI passes; wrong public key fails; `verifyToi false` fails; OTOI checksum match passes; mismatch fails.
- Honor tests: `honor` with `strict` + `audit` + agent `nlt-pi-mvp`; `propagate` returns effective policy.
- Behaviour notes tests: template covers enum fields; never includes `identity`, `cognitive_profile`, `custom`, `$`-keys.
- Retention tests: each `privacy.retention` value → memory on/off correctly.
- Fallback tests: unverifiable TOI → default TOI, memory off.
- Route tests: `/api/memories/toi` 401 without owner, 400 without signature, 400 wrong key, 400 bad signature, 200 on valid signed TOI.
- Page helpers tested with `node --test`.

## 15. Governance and records

- Intent record under `docs/agent-log/` (new verification boundary, standing terms).
- Update `mvp/README.md` (TOI/OTOI section), `docs/active-threads.md`, and a handoff record.
- The PR follows `PULL_REQUEST_TEMPLATE.md`.

## 16. Open items for the owner

- Confirm `NLT_TOI_PUBKEY` and `NLT_OTOI_SHA256` pinning process (how the owner establishes the initial pins).
- Confirm the home-directory default paths for `.toi`/`.otoi` when `ASFDK_*_PATH` is unset.
- Confirm whether `/api/memories/toi` upload route is wanted, or whether the owner uploads the signed TOI to Mem0 through another channel.
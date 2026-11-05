# NLT-Pi Intent Record

**Date:** 2026-11-05T16:45:27+00:00  
**Agent / session:** Claude (Claude Code, claude-sonnet-5-5) / `01UNjnjmtbn8V5V114283EeV`  
**Branch:** `feat/mvp-model-selector`  
**OTOI:** NLT-PI-DEV-OTOI-1.0.1

## Intended action
Finish the model selector for the MVP chat page (owner-approved design, 2026-11-05):

1. `GET /api/models`: lists the free, tool-capable gateway models, behind the same enable flag and owner session as `/api/agent`.
2. A selector in the chat UI (default "Auto (best free)"), held in memory only.
3. An optional `model` field on `POST /api/agent`, passed to the runner as `pickFreeModel({ requested })`.

## Rationale
`pickFreeModel` already supports a requested model but nothing exposes the list or passes a choice.

## Risks and trust boundaries
- The client's model id is untrusted input. It is length-capped, then re-checked against the live free list inside the turn, after the crisis gate. A non-free or unknown id returns `no_free_model`; no other model is substituted.
- No new persistence, credential, egress or sandbox change. `/api/models` reads only the public catalog and returns 404 when the agent is disabled and 401 without an owner session.
- The crisis gate order is unchanged; the model choice happens after it.

## Rollback
Revert the PR. The route behaves as before without a `model` field.

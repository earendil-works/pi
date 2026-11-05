# NLT-Pi Intent Record

**Date:** 2026-11-05T01:10:48+00:00
**Agent / session:** Claude Code, session_01UNjnjm3TZ7Tg4MRswGt24P
**Branch:** ccr-0d5033af-1rkbla (restarted from `main` after PR #17 merged)
**OTOI:** NLT-PI-DEV-OTOI-1.0.1

## Intended action
Re-sync the vendored ASFDK harness (`mvp/src/harness/`) from asfdk-harness `5488262` (PR #36, merged). Selected by the owner ("Re-sync harness") after the follow-up was proposed.

1. Replace `policy.ts`, `protocols.ts` and `tools.ts` with the upstream versions, re-applying only the `.ts` import-specifier change; update the provenance header in all seven vendored files and the harness README.
2. Move the six `policy.ts` commands the upstream fix blocks from the known-gap list to the asserted must-block list in `mvp/test/corpus/policy-commands.json`.
3. Add the three glob variants raised in review of #36 and confirmed as still allowed (`cat .EN?`, `cat cred*.yaml`, `cat .en?.staging`) as known gaps.
4. Update `docs/active-threads.md` (NLTPI-UPSTREAM-001) and write a handoff record.

Not in this action: editing vendored files by hand, changing asfdk-harness, bumping `@neurolift-technologies/asfdk` (no release exists), changing the crisis-gate corpus, or any deployment or provider change.

## Rationale
The owner decided to keep the vendored copy and send fixes upstream, with a re-sync after the upstream merge. `policy.ts` is a guardrail file upstream; here it is copied byte-for-byte apart from imports, so the vendored copy stays an exact image of the merged upstream.

## Risks and trust boundaries
- **Enforcement claims:** the re-synced `policy.ts` is still a regex guardrail, not a security boundary. The README says so and the three confirmed glob gaps are listed as known gaps.
- **Drift:** all seven headers now name `5488262`. The four files not changed upstream were checked as identical to upstream modulo header and imports.
- **No new dependency, provider, persistence or deployment change.**

## Alternatives considered
- Wait for an `asfdk` release and do one combined bump: rejected; the harness fix is independent of the `asfdk` package.
- Fix the glob variants locally: rejected; vendored files are not edited here (owner decision: fix upstream).

## Human approval / escalation
Re-sync approved by the owner. Escalation needed before the glob variants are proposed upstream (`policy.ts` is escalate-before-change in asfdk-harness).

## Outcome
See the handoff record `2026-11-05-resync-harness-after-upstream-36.json` and the PR.

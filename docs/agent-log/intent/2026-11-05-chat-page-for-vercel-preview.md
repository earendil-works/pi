# NLT-Pi Intent Record

**Date:** 2026-11-05T01:19:06+00:00
**Agent / session:** Claude Code, session_01UNjnjm3TZ7Tg4MRswGt24P
**Branch:** ccr-0d5033af-1rkbla-ui (new branch from `main`; the owner approved a branch separate from #18)
**OTOI:** NLT-PI-DEV-OTOI-1.0.1

## Intended action
Build the chat UI the owner supplied as a mockup, in the existing Vercel project (`mvp/`), as a static page.

1. Move the current status page to `mvp/public/status.html` unchanged; serve the chat page at `/`.
2. Add `index.html`, `app.css`, `app.js`, and `lib/decision.js` (pure verdict logic) with unit tests.
3. Wire the page only to endpoints that exist: `POST /api/govern`, `GET /api/health`, `GET /api/status`.
4. Update `mvp/README.md`, `docs/active-threads.md`, and write a handoff record.

Not in this action: calling a model, running tools, authentication, persisting conversations (browser storage included), choosing a framework, setting Vercel environment variables, or any production deploy beyond what merging to `main` already does.

## Rationale
The mockup shows features that do not exist (model, tools, sign-in, sessions) and status values that would be untrue today (governance GREEN, escalation not required, six tools enabled). Showing them would present capability and assurance that the code does not have. The page therefore shows the live gate result and plain "not connected / disabled" states.

## Risks and trust boundaries
- **Misleading assurance:** a UI that says "GREEN" or "Escalation not required" without evidence could be read as a safety statement. Mitigated by showing only gate output and an explicit "Not verified" for governance until `/api/status` says otherwise.
- **Fail-open handling:** the page must never treat a failed or malformed response as a pass. Only a literal `allowed: true` passes, covered by tests.
- **Sensitive input:** prompts may contain crisis content. Nothing is stored; no new persistence boundary. User text is written with `textContent` only.
- **Care for the reader:** the blocked-message wording is placeholder copy (includes a US 988 line) and needs owner or clinician review. It does not assume the person is in crisis because the gate also flags topic mentions.
- **Preview exposure:** the page and `/api/govern` are open on previews (owner decision). `/api/govern` returns 404 in production, so the production page shows the gate as unavailable.

## Alternatives considered
- Next.js or another framework: rejected here; framework choice is an architecture decision for the owner.
- Saving sessions in localStorage: rejected; new persistence boundary, and prompts can be sensitive.
- Copying the mockup literally: rejected for the reasons above.

## Human approval / escalation
Scope follows the owner's request. The owner approved the separate branch and PR. Needs the owner: copy review, logo asset, and any step toward a connected model or sign-in.

## Outcome
See the handoff record `2026-11-05-chat-page-for-vercel-preview.json` and the PR.

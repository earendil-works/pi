# Progress

## Status
- mission scaffolded
- architecture approved via ask_user
- baseline discovery complete with green package check
- architecture-and-baseline milestone complete
- MCP config/auth slice complete and green
- MCP HTTP discovery/invocation slice complete and green
- MCP recovery/refresh red-test slice complete
- MCP recovery/refresh implementation complete and green
- generic MCP milestone complete
- local MCP harness bootstrap complete
- Figma runtime loading/tool exposure slice complete and green
- Figma UX slice complete and green
- metadata-based OAuth support detection and capability gating complete and green
- MCP OAuth login/storage red-test slice complete
- actual MCP OAuth login/storage slice complete and green
- real Figma validation blocked on Figma remote OAuth client-registration refusal
- figma milestone gate blocked on live validation

## Next Smallest Step
- wait for an approved-client bridge or for Figma to allow Mu's dynamic MCP OAuth client registration, then retry the live validation path

## Notes
- Source material came from `.factory/library/mcp.md`, `.factory/library/architecture.md`, `.factory/library/user-testing.md`, and the prior droid mission at `~/.factory/missions/95e916e2-6151-4c4c-8a86-3a8239038a05/`.
- This mission is intentionally mu-style: `ARCHITECTURE.md` + `SPEC.md` + `MILESTONES.json` + `TASKS.json` + `RUNBOOK.md` + `PROGRESS.md`.
- Real Figma validation is allowed to remain blocked only by missing external credentials or endpoint access.
- Baseline package verification is currently green: `npm run check -w @kennyfrc/mu-coding-agent`.
- XTUI baseline check confirmed the live help surface is usable and contains `AI assistant with read`.
- MCP config/auth slice is green: `test/mcp-config.test.ts`, `test/mcp-auth-resolution.test.ts`, and `npm run check -w @kennyfrc/mu-coding-agent` passed.
- MCP HTTP runtime slice is green: `test/mcp-http-runtime.test.ts` and `npm run check -w @kennyfrc/mu-coding-agent` passed.
- MCP recovery/refresh red suite now exists and is confirmed red for the intended missing behavior before implementation.
- MCP recovery/refresh implementation is green: targeted recovery tests and `npm run check -w @kennyfrc/mu-coding-agent` passed.
- User approved continuing with the larger real transport+harness implementation and changed the milestone verification contract from `curl`-level proof to test-only local-harness proof.
- Generic MCP milestone is now green with the updated test-only harness verification.
- Deterministic local harness bootstrap is now complete via `test/mcp-local-harness.test.ts` on port `3210`.
- Figma runtime loading/tool exposure slice is green: `test/figma-runtime-loading.test.ts`, `test/figma-tool-exposure.test.ts`, and `npm run check -w @kennyfrc/mu-coding-agent` passed.
- Figma UX slice is green: `test/figma-slash-ui.test.ts`, `test/figma-readiness-ui.test.ts`, `test/figma-bearer-auth.test.ts`, `test/figma-oauth-recovery.test.ts`, and `npm run check -w @kennyfrc/mu-coding-agent` passed.
- Metadata-based OAuth support detection and capability gating are now green: `test/mcp-oauth-support.test.ts`, `test/figma-oauth-capability-gating.test.ts`, `npm run check -w @kennyfrc/mu-coding-agent`, and root `npm run check` passed.
- The Figma endpoint advertises OAuth metadata via `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`, including `mcp:connect` scope and an authorization server at `https://api.figma.com`.
- Mu now exposes `login_required` capability state, gates tool discovery until an OAuth token exists, and implements metadata-driven MCP OAuth login/storage plus dynamic client registration.
- MCP OAuth login/storage red suite is now in place and confirmed red for the intended missing behavior: the MCP OAuth module is absent and `figma-login` does not yet print the returned authorization URL.
- MCP OAuth login/storage slice is now green: `test/mcp-oauth-login.test.ts`, `test/mcp-oauth-storage.test.ts`, `test/figma-oauth-login-ui.test.ts`, and `npm run check -w @kennyfrc/mu-coding-agent` passed.
- After adding Codex-style dynamic client registration, a live probe through Mu's real OAuth module still fails at Figma's advertised registration endpoint with `MCP OAuth client registration failed: 403 Forbidden`.
- This confirms the remaining blocker is external to the local implementation: Figma is refusing Mu as an MCP OAuth client in this environment, so no real authenticated Figma tool call can proceed without an approved-client bridge or a lifted registration restriction.

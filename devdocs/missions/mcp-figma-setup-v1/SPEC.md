---
mode: build
---

# 1. Summary & Recommendation

Add MCP support to `packages/coding-agent` as a first-class runtime capability and use Figma as the pilot integration that proves the generic design.

Recommended delivery order:

- stabilize the current extension/runtime baseline
- add generic MCP config, auth, discovery, invoke, recovery, and refresh behavior
- add deterministic local harness validation
- add Figma pilot loading, visible status, slash UX, and real-endpoint verification

# 2. What Must be True

- MCP servers can be configured for `streamable_http` without embedding secrets in repo files.
- MCP config validation accepts `stdio` entries in a transport-specific shape even if HTTP is implemented first.
- Remote MCP tools appear through the normal Mu tool surface and normal prompt/tool-definition path.
- MCP-backed tool calls pass through existing hook wrapping, result transformation, and transcript handling.
- Remote tool naming is deterministic and collision-safe across reload/reconnect.
- Reload and resume reconnect cleanly or degrade explicitly without stale MCP tools remaining visible.
- A deterministic local harness can validate connect/discover/invoke flows on ports `3200-3299`.
- Figma can load as a pilot integration without hard-coding Figma logic into the generic MCP core.
- Figma status is visible through normal runtime UX.
- At least one meaningful real Figma operation returns concrete Figma-specific data through the normal tool pipeline.

# 3. What Must Never Happen

- Secret-bearing auth material must never appear in prompts, transcripts, slash output, status text, or surfaced errors.
- MCP must never bypass the existing extension/runtime lifecycle.
- Reload must never leave stale MCP tools, commands, or indicators behind.
- Figma-specific behavior must never leak into the generic MCP runtime layer.
- A visible healthy Figma/MCP status must never coexist with a stale or unusable tool surface.
- The work must never require `npm run dev`.

# 4. Inputs / Outputs

## Inputs

- MCP config under the coding-agent config surface
- env-backed auth references
- optional real Figma credentials and endpoint config from user environment
- local harness-backed MCP fixtures for deterministic testing

## Outputs

- MCP runtime support in `packages/coding-agent`
- deterministic local harness validation paths
- Figma pilot integration and visible readiness/status UX
- targeted tests plus final `npm run check`

# 5. Edge Cases

- invalid config
- missing auth env vars
- malformed discovery or tool payloads
- remote tool name collisions
- inventory refresh removing or renaming tools
- disconnect during tool call
- resume with previously available MCP servers now unavailable
- Figma auth failure followed by in-session recovery

# 6. Constraints

- Primary package is `packages/coding-agent`.
- Keep local harness ports inside `3200-3299`.
- Avoid known occupied ports: `3000`, `5000`, `5173`, `5432`, `6379`.
- Do not run `npm run dev`.
- Root completion gate includes `npm run check`.

# 7. Definition of Done

- Targeted MCP config/auth tests pass.
- Targeted MCP HTTP discovery/invoke/recovery/refresh tests pass.
- Deterministic local harness tests pass.
- Targeted Figma loading/UX/auth tests pass.
- A real Figma validation path either:
  - succeeds with concrete Figma-specific output, or
  - is explicitly blocked only by missing external credentials/access.
- `npm run check -w @kennyfrc/mu-coding-agent` passes.
- Root `npm run check` passes.

# 8. What needs to be done to deliver the spec

- Approve architecture boundaries before implementation.
- Add or fix baseline tests that currently block the package gate.
- Implement generic MCP config/auth/runtime behavior first.
- Add deterministic local MCP harness support.
- Layer Figma integration and UX on top of the generic runtime.
- Run targeted validation, then package check, then root check.

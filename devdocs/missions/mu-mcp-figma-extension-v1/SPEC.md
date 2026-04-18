---
mode: build
---

# 1. Summary & Recommendation

Add MCP to Mu as an extension-hosted runtime with HTTP/HTTPS support first, using Figma as the first real integration target.

The recommended v1 design is:

- a built-in Mu MCP extension inside `packages/coding-agent`
- Mu-native config loading from `~/.mu/agent/mcp.json` and `.mu/mcp.json`
- import adapters for `~/.factory/mcp.json` and `~/.codex/config.toml`
- generic HTTP-first MCP runtime with disposable per-server sessions
- proxy-first tool access through a single `mcp` tool
- slash/status UX through normal Mu surfaces
- Figma as the first real remote MCP server
- explicit degraded/auth-failed behavior when Figma auth/client compatibility is not available

# 2. What Must be True

- MCP runs inside Mu's existing extension lifecycle.
- Each enabled MCP server owns a stable `sourceId` so reload/unload can clean up all artifacts.
- Mu can load MCP server definitions from Mu-native config and the approved import sources.
- HTTP/HTTPS MCP transport works against a local harness before relying on Figma.
- Remote MCP tools are surfaced through Mu's tool runtime and tool-result projection path.
- `/reload` removes stale MCP tools, commands, and indicators before re-registering current inventory.
- Resume either reconnects current MCP state or degrades explicitly with no stale tool surface.
- Figma can be configured from imported config already present on this machine.
- If Figma auth/client compatibility is unavailable, Mu reports that state clearly instead of pretending the server is connected.

# 3. What Must Never Happen

- MCP must never be implemented as a parallel runtime outside the extension system.
- Pi-specific config paths or naming must never leak into the Mu implementation.
- Secrets must never appear in prompts, indicators, transcript entries, or error surfaces.
- Reload/resume failure must never leave stale MCP tools callable.
- Figma-specific transport behavior must never be baked into the generic MCP core.
- Mu must never assume Codex MCP config lives in `~/.codex/config.json` in this environment.

# 4. Inputs / Outputs

## Inputs

- `~/.mu/agent/mcp.json`
- `.mu/mcp.json`
- `~/.factory/mcp.json`
- `~/.codex/config.toml`
- MCP server definitions with HTTP/HTTPS first and stdio later
- Figma remote server URL: `https://mcp.figma.com/mcp`

## Outputs

- one built-in `mcp` extension entrypoint in Mu
- Mu-visible MCP tool surface
- `/mcp` slash/status surface
- footer indicator state for MCP readiness/degraded/auth state
- reconnectable non-secret MCP state

# 5. Edge Cases

- imported server definition is marked disabled
- same server name appears in multiple config sources
- remote inventory changes after reload
- server is reachable but authentication fails
- Figma rejects the client even when transport is correct
- cache is missing or stale
- resume occurs after config removal
- remote tool names collide or normalize badly

# 6. Constraints

- Keep the implementation inside `packages/coding-agent`.
- Reuse the existing extension loader/manager/runtime rather than building a separate subsystem.
- Implement HTTP/HTTPS before stdio.
- Keep Figma-specific behavior out of the generic runtime except in the pilot layer.
- Treat Figma end-to-end auth/client compatibility as a first-class verification risk.
- Final code changes for this mission must pass `npm run check`.

# 7. Definition of Done

- Mu-native MCP config/import tests exist and pass.
- HTTP MCP runtime tests against a deterministic local harness pass.
- Reload/resume cleanup tests pass with no stale MCP surface.
- `/mcp` slash/status UX is visible and correct in terminal validation.
- Real Figma validation proves one of:
  - authenticated MCP connectivity and at least one real Figma operation, or
  - explicit `auth_failed` / `unsupported_client` behavior with no false-positive connected state.
- Final completion gate: `npm run check`.

# 8. What needs to be done to deliver the spec

- Add Mu-native config loader + import adapters for `.factory` JSON and Codex TOML.
- Add MCP runtime dependencies and a generic HTTP-first server/session manager.
- Add a tool adapter that maps remote MCP tools into Mu `AgentTool` registrations with stable names and Mu projection metadata.
- Add built-in `mcp` extension wiring for tool, command, indicator, reload, and cleanup behavior.
- Add local MCP harness tests for connect/discover/call/reload/degrade flows.
- Add real Figma validation, with explicit handling if Figma client approval/auth blocks end-to-end success.


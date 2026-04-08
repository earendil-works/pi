# Architecture

High-level system architecture for the MCP mission in `packages/coding-agent`.

**What belongs here:** components, relationships, runtime flow, invariants, and where new MCP behavior should attach.
**What does not belong here:** low-level implementation notes, step-by-step coding tasks, or test command logs.

---

## System Components

## Current baseline vs new work

Already true today:
- the host runtime loads extensions, commands, tools, and providers through a host-owned lifecycle;
- reload and registry cleanup are existing concepts;
- prompt/tool exposure is already built from the active runtime tool set.

New in this mission:
- a generic MCP runtime layer,
- transport adapters for HTTP first and stdio parity,
- remote inventory discovery and refresh,
- MCP-specific slash/status UX,
- the Figma pilot built on top of the generic MCP layer.

## System Components

### Host runtime
`packages/coding-agent/src/main.ts` is the composition root. It loads extensions, resolves the active tool surface, rebuilds the system prompt from the active tools, restores session/model state, and starts the agent runtime.

### Extension lifecycle layer
The extension subsystem is the MCP insertion point:
- `ExtensionLoader` discovers and reloads extensions.
- `ExtensionManager` owns registrations and cleanup by `sourceId`.
- `ExtensionRunner` composes context/input/tool hooks.
- `ToolRegistry` and `CommandRegistry` determine the active tool/command definitions.

MCP must fit into this lifecycle rather than creating a parallel manager outside it.

### MCP integration layer
Add a generic MCP runtime under the extension layer:
- MCP config loading and validation
- connection/session management per configured MCP server
- transport adapters (`streamable_http` first, `stdio` parity through the same higher-level contract)
- remote inventory discovery and refresh
- auth resolution and redaction

This layer should register tools, commands, providers, and indicators through the existing extension/runtime seams.

Minimum contract with the host runtime:
- each MCP-backed registration must have a stable `sourceId`;
- each enabled MCP server must own a disposable session lifecycle;
- tool registration is mandatory;
- status indicators and slash commands are optional unless the feature explicitly requires user-facing UX;
- cleanup must be possible by `sourceId` alone.

### Tool surface adapter
Remote MCP tools must be mapped into the same `AgentTool` surface used by built-ins and extensions. This adapter owns:
- stable qualified tool names
- schema translation
- invocation forwarding
- tool display/projection metadata
- error normalization
- secret redaction

### Operator UX surface
Use existing user-facing surfaces:
- slash commands for connect/status/retry flows
- footer indicators for connection state
- `/reload` for re-discovery and cleanup
- prompt/tool exposure through the normal active-tool list

Do not create a separate MCP-only UI path if the normal runtime surface can carry the behavior.

Expected visible states for operator UX:
- `disconnected`
- `connecting`
- `connected`
- `degraded` or `auth_failed`

### Session and persistence layer
Session history remains host-owned. MCP-specific persisted state should be extension-scoped and limited to reconnectable metadata, not secrets embedded in prompts or transcripts. Continue/resume should either reconnect cleanly or degrade explicitly with no stale tool surface.

### Figma pilot layer
Figma is a pilot integration built on top of the generic MCP layer. Figma-specific config, slash commands, labels, and validation belong here. Figma-specific transport logic does not belong in the generic MCP runtime.

## Runtime Flow

### Startup
1. Load built-ins and extension runtime.
2. Load MCP config.
3. Start MCP sessions for enabled servers.
4. Discover remote inventory.
5. Map remote tools into runtime registrations.
6. Rebuild the active tool set and system prompt.
7. Start the agent with the combined runtime surface.

### Tool invocation
1. The model sees MCP tools through the normal tool definition path.
2. The model calls a surfaced tool name.
3. Existing before-tool hooks still run.
4. The MCP adapter forwards the call to the correct server/session.
5. The result returns through the normal tool-result transformation path.
6. Transcript/UI rendering treats the result like any other tool result.

### Reload
1. `/reload` unloads prior extension/MCP registrations by `sourceId`.
2. Old MCP sessions are disposed.
3. Config and extensions are reloaded.
4. Servers reconnect and inventory is rediscovered.
5. Tools, commands, indicators, and prompt state are rebuilt in place.

### Resume
1. Restore saved session/model/thinking state.
2. Reconstruct MCP runtime from current config and persisted extension state.
3. Reconnect enabled servers.
4. Re-register current inventory before use.
5. If reconnect fails, show explicit degraded state and remove stale MCP tools.

## Key Invariants

- MCP is host-owned lifecycle state, not a sidecar runtime.
- MCP tools use the same tool surface as built-ins and existing extensions.
- Tool naming and collision handling are deterministic.
- Reload/disconnect/resume failure must not leave stale tools, commands, providers, hooks, or indicators behind.
- The generic MCP layer is transport-agnostic above the adapter boundary.
- Secret-bearing auth material must never appear in prompts, status text, transcripts, or surfaced errors.
- Figma-specific behavior lives only in the pilot layer.

## Naming and ownership defaults

- Use one stable `sourceId` namespace per MCP server so all tools, commands, indicators, and optional providers from that server can be cleaned up together.
- Tool qualification must be deterministic across reload/reconnect. Different workers must not invent incompatible naming rules for the same server/tool pair.

## Persistence defaults

- Persist only reconnectable metadata such as selected server state or non-secret session metadata.
- Do not persist bearer tokens, OAuth secrets, or prompt-facing copies of secret material.

## Worker Guidance

- Reuse `ExtensionManager` and `ExtensionLoader`; do not bypass them.
- Model each MCP server as a runtime-owned session with explicit connect, discover, invoke, refresh, and dispose phases.
- Make failure states explicit in slash/status UX.
- Favor deterministic local harness validation before real Figma validation.
- Update this document if the chosen MCP config shape, session model, or runtime boundaries materially change.

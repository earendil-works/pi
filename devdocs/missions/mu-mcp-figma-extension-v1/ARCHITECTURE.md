# Architecture Proposal

## Summary

Build MCP as a Mu-native runtime inside `packages/coding-agent` using the existing extension lifecycle. Keep Figma-specific behavior in a thin pilot layer on top of the generic MCP runtime.

## Approved Boundaries

- Generic MCP runtime lives in `packages/coding-agent` and integrates through the existing extension lifecycle.
- Figma-specific config, labels, validation, and auth UX live in a pilot layer above the generic runtime.
- Mu-native config/import adapters replace Pi-specific paths and assumptions.

## Approved Abstractions

- `McpConfigLoader`: loads Mu-native config plus import adapters for `.factory` and Codex.
- `McpServerManager`: owns MCP server sessions and HTTP-first transport behavior.
- `McpToolAdapter`: maps remote MCP tools into Mu `AgentTool` registrations with stable naming and Mu projection metadata.
- One built-in `mcp` extension entrypoint wires the runtime into tools, commands, indicators, and cleanup.

## Approved Tradeoffs

- Prioritize real Figma end-to-end auth/compatibility over generic breadth if a tradeoff is required.
- Preserve Mu-native architecture cleanliness over a quick Pi-port.
- Start proxy-first for the tool surface unless direct tools are required to prove Figma viability.

## What Matters Most

- Mu-native architecture cleanliness
- Real Figma usability
- Correct reload/resume cleanup

## Alternatives Considered

- Directly port `pi-mcp-adapter` with minimal renaming: rejected because it bakes in Pi paths and the wrong Codex config shape for this environment.
- Build Figma-only logic first: rejected because the repo architecture already requires a generic MCP layer under the extension system.


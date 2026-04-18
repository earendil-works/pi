# Architecture

## Summary

Set up MCP in `packages/coding-agent` as a host-owned runtime capability, then use Figma as the first real integration that proves the generic layer works.

Recommended boundaries:

- generic MCP runtime in the existing extension lifecycle
- transport adapters under one shared runtime contract
- Figma-specific config, auth UX, and operator affordances in a pilot layer
- local deterministic harnesses before real Figma validation

## Components

### Host runtime
- `packages/coding-agent/src/main.ts` remains the composition root.
- Existing extension/tool/command lifecycle remains authoritative.

### Generic MCP runtime
- config loading and validation
- auth resolution with redaction
- per-server session lifecycle
- tool discovery, naming, refresh, invoke, and cleanup
- support `streamable_http` first and keep `stdio` on the same contract

### Tool surface adapter
- maps remote MCP tools into the normal Mu tool surface
- owns deterministic collision-safe naming
- forwards invocation through normal wrapping, result transformation, and transcript behavior

### Figma pilot layer
- Figma config defaults and labels
- bearer-first auth path with OAuth-ready recovery behavior
- Figma slash/status UX
- no Figma-specific logic inside the generic transport/runtime core

### Validation harnesses
- deterministic local MCP harnesses on `3200-3299`
- real Figma validation only after local/runtime behavior is green

## Invariants

- MCP is runtime-owned lifecycle state, not a side channel.
- Remote tools must appear through the same active tool surface as built-ins and extensions.
- Reload/resume must remove stale MCP artifacts before re-registering current inventory.
- Secret-bearing auth material must never appear in prompts, transcripts, visible status, or surfaced errors.
- Figma remains a pilot integration layered on top of the generic MCP runtime.

## Approval checkpoint

Implementation should not start until the human confirms these boundaries are acceptable:

- generic core vs Figma pilot split
- `streamable_http` first, `stdio` parity second
- bearer-first auth with OAuth-ready recovery
- local harness validation before real Figma validation

Approval should be gathered via `ask_user` in `specification` mode, not by leaving open questions embedded in this file.

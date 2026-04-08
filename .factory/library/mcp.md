# MCP

Mission-specific notes for the new MCP subsystem in `packages/coding-agent`.

**What belongs here:** MCP config shape, transport expectations, auth precedence, naming rules, and runtime gotchas.

---

## Design defaults

- Build a generic MCP runtime under the existing extension lifecycle.
- Treat `streamable_http` as the first implemented transport.
- Keep `stdio` on the same higher-level runtime contract; do not design a separate stdio-only stack.
- Keep Figma-specific behavior out of the generic runtime.

## Auth defaults

- Prefer env-backed bearer-token configuration for the first real Figma pass.
- Keep auth resolution explicit and deterministic.
- Redact secret-bearing material from all user-visible surfaces.

## Naming defaults

- Remote tool names must be deterministic and collision-safe.
- The same remote inventory must map to the same exposed tool names across reload/reconnect.

## Lifecycle defaults

- MCP sessions are runtime-owned and disposable.
- Reload must fully remove stale MCP artifacts before re-registering the refreshed inventory.
- Resume must either reconnect and restore tools or degrade explicitly with no stale tool surface left behind.

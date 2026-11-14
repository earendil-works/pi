# Slice 13: MCP

**Goal.** MCP servers (the owner's and the project's), their tools in the harness, accounts. p2's `plugins/mcp` as precedent.

**Depends on:** slices 3, 6.

**From the archive:** `archive/locks/design.md` (`mcp.*` locks), `archive/org-managed/book.md` (org-supplied MCP servers).

**Read first:** `decisions.md` ("Models and credentials": accounts); `archive/accounts/book.md` (MCP); `archive/rundown/book.md` (one extension per MCP server, namespaces from configuration; no MCP process or credential in a worker); p2's `docs/mcp-durable.md`, `plugins/mcp/`; `packages/mcp/`.

The brief is filled out when the slice is next.

**Also read (docs audit, 2026-11-14; "Chord dec." is `packages/chord/docs/decisions.md` by entry title and line, "archive" is `../archive/`, "research" is `/home/badlogic/chord-notes/research/p3-people-2026-11-13/` on slayer):**

-  2.1 #18 sources; `accounts/book.md` MCP (:479); `org-managed/details.md:1149-1398`; `rundown/book.md` (The
  Filters, Namespaces: one extension per server); p2 `plugins/mcp/config.ts`, `placement.ts`, `worker.ts`, `tools.ts`.

**Open or to carry (docs audit):**

- MCP follows locations through leases; no MCP process or credential in a worker; project `.pi/mcp.json` enabled per
  checkout; stdio servers at the location (`runOn`); accounts through an envelope `{ account?, input }`; the
  `tool_search` fallback arrives with MCP; known p2 bugs: the lease not re-sent on server reactivation, unstable
  provider tool schemas (sources in the audit's 2.1 #18). Credentials by reference.

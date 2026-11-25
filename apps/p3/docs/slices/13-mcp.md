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

**p2's MCP behaviour (Armin, 2026-11-14; owner: record for MCP):** Radius artifact
https://radius.earendil.com/artifact/01m7cx2k0zf03b5pt1fxf2tzgv ("p2 MCP: configurations, behavior and leaks (one
extension per server)"; a copy on slayer: `/home/badlogic/chord-notes/research/p2-mcp-armin-2026-11-14.md`). Read it in
full. In short:

- Durable gives every conversation of a session the same tools (one registry per worker), but a server may have one
  instance per location its conversations work at (leases). p2 publishes one extension per server name
  (`mcp:<server>`, namespace `mcp__<server>`), described by one "describing instance" (shared, else the session's
  location, else the first by id), while each call goes to the instance at the caller's location.
- Exact: HTTP and shared servers, every conversation at the session's location, unshared stdio servers whose tools do
  not depend on where they run, session locks.
- Leaks where the two differ (cases A–F): a project server only at a subagent's location is listed in the main
  conversation and refused there; same-named project servers configured differently (wrong descriptions, schemas,
  missing or phantom tools); tool lists depending on cwd, roots or machine; project overrides turning an owner server on
  or off at one location; no instance at the session's location; names colliding once sanitized across projects. Each
  leak's start and end changes every conversation's prompt (a cache miss).
- The only fix for A–F is per-conversation tool lists, which needs Durable to resolve tools per conversation (a filter
  step when the agent is resolved): prototyped, left out of Durable. Not covered: different people's servers in one
  session (owner and account qualifiers in names).
- For p3: decide whether Durable resolves tools per conversation (it also serves locks per conversation and per-machine
  tools such as PowerShell's), or p3 keeps one extension per server and accepts these leaks.

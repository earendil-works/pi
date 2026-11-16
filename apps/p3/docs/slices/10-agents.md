# Slice 10: Agents

**Goal.** Subagents, one-shot agents, code mode, reaching other sessions (`conversations.reach`). p2's `plugins/subagents`, `plugins/codemode`, `plugins/conversations` as precedent.

**Depends on:** slices 3, 8.

**From the archive:** `archive/rundown/book.md` (Subagents and Places, The Worker and the People), `archive/locks/design.md` (`conversations.reach`, `subagents.*`).

**Read first:** `decisions.md` ("Tool access", "Artifacts and views": plugin tools are code-mode only, by namespace); Chord decisions on subagents (`context: "inherit"`) and on Chord from code-mode scripts (the agent's principal, open); design.md §24 (code mode on reload); `archive/status-2026-11-09.md` (subagents choose from the caller's tools; instruction scopes); `packages/codemode/`.

The brief is filled out when the slice is next.

**Also read (docs audit, 2026-11-14; "Chord dec." is `packages/chord/docs/decisions.md` by entry title and line, "archive" is `../archive/`, "research" is `/home/badlogic/chord-notes/research/p3-people-2026-11-13/` on slayer):**

- **Chord dec.:** 2413 (inherit, tree), 3552 (code mode scripts calling Chord), 110 (code mode sandbox close/R16).
-  `status-2026-11-09.md:60-62, 108-111`; `merged.md` §2 #17, §4 Q10; `handoff.md:65-67`; decisions "Artifacts
  and views" (code-mode-only plugin tools, namespaces from configuration); `rundown/book.md:1495-1509`.
- **p2:** `apps/p2/plugins/agent/`, `agent-plugins/`, `apps/p2/plugins/subagents/contract.worker.ts`
  (`resolveTools`), `apps/p2/docs/agent-plugins.md`.

**Open or to carry (docs audit):**

- Agent-written plugins need the server's machine (a subagent with `env: null` and the plugins directory as cwd,
  `archive/rundown/book.md` 1495-1509); Chord from code-mode scripts needs a principal for the agent (Chord dec. 3552).

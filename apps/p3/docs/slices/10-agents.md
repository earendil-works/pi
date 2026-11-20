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

## Worker memory: what to build with code mode (owner, 2026-11-18)

Measured by mem-audit on the realistic session worker of slice 26's memory test (Node 26.11.1, the committed worker
flags), with code mode as p2 runs it; private: `/home/badlogic/chord-notes/research/p3-memory.md`, "Code mode and
remote environments". USS, MiB, medians:

| | idle | after the first script | after 20 scripts | after the burst | peak | runs over 55 |
| --- | --- | --- | --- | --- | --- | --- |
| no code mode | 21.7 | – | – | 36.2 | 51.2 | 0 of 6 |
| p2's code mode (a worker thread per script) | 23.0 | 37.4 | 44.4 | 51.7 | 57.0 | 3 of 3 |
| QuickJS inline, in the worker's thread | 21.8 | 38.2 | 38.6 | 47.5 | 52.8 | 0 of 3 |

**To build (decided):**
1. **The sandbox runs inline** in the worker's own thread, not a worker thread per script: about 10 MiB less after the
   first script, 28 MiB less with five scripts at once, and a script takes 14 ms instead of 30. A runaway script holds
   the worker's thread until QuickJS's interrupt budget stops it; that budget is the guard.
2. **Opened on first use** (1.2 MiB less while unused). Not closed when idle: that frees nothing measurable and a reopen
   costs 21 to 37 ms. One sandbox per worker (per conversation costs the same: QuickJS compiles once per process).
3. **Look at what Durable keeps per code mode call:** after 21 code mode turns with 63 nested calls the worker holds
   about 8 MiB more heap. Inline code mode plus an SSH environment peaks at 51 to 58 MiB, about one worker per run over
   the 55 MiB budget; trimming those records is the first place to find the missing 3 MiB. If that fails, the budget
   for code mode sessions is decided again (60 MiB was proposed).
4. The release must ship code mode's sandbox with the worker's bundle (inline needs no separate worker file).

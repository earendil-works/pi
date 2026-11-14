# Slice 8: Environments and coding tools

**Goal.** This device, SSH, sandboxes (Gondolin), a session's location and moves; read, write, edit, bash. p2's `plugins/envs`, `plugins/locations`, `plugins/coding-tools` as precedent.

**Depends on:** slice 3.

**From the archive:** `archive/base-inventory/explainer/book.md` (The Harness: environment providers), `archive/rundown/book.md` (Subagents and Places), `archive/org-managed/book.md` (sandboxes, Gondolin, krun).

**Read first:** `decisions.md` ("No per-user environments"); `archive/base-inventory/merged.md` #5 (an undefined environment, never a local fallback; a wrap is not confinement) and §4.7; `archive/handoff.md` (SSH: one owner per environment); p2's `docs/remote-envs.md`, `plugins/envs/`, `plugins/locations/`, `plugins/coding-tools/`; `packages/env/`. **Open:** Armin's worker-start proposals (route retries with backoff, refusal vs transient, ready timeout; `archive/handoff.md`).

The brief is filled out when the slice is next.

**Also read (docs audit, 2026-11-14; "Chord dec." is `packages/chord/docs/decisions.md` by entry title and line, "archive" is `../archive/`, "research" is `/home/badlogic/chord-notes/research/p3-people-2026-11-13/` on slayer):**

-  `resources-code/book.md:300-336`; `model-stress/report.md:792-805` (gap 5, location) and `:829-850`;
  `status-2026-11-09.md:63-66`; `sharing.md:98-100`; `resource-model/book.md:1397-1400`; `merged.md` §4 Q7;
  `handoff.md:78-79, 141-144`; locks table `locations.places`, `subagents.environments`.
- **Chord dec.:** "Natives that follow a relocation (D3)" (346).
- **p2:** `apps/p2/plugins/envs/schema.ts`, `secrets.ts`, `worker.ts`; `plugins/powershell/`;
  `apps/p2/docs/remote-envs.md`.

**Open or to carry (docs audit):**

- An SSH machine's key stays on the server: it holds the connection and relays the channel
  (`archive/resources-code/book.md` 334-336); no location means no shell, never a fallback to the server machine
  (`archive/resource-model/book.md` 1397-1400); natives that follow a relocation (Chord dec. 346).

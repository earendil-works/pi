# p3 overview

p3 is the successor of p2 (Pi Mobile): one Pi per person, built on Chord v2 and its app kit, next to p2 in
`apps/p3/` on main, with its own data directory. It starts empty: no migration of p2's data. Nothing is built yet.

## Goals

- **Almost everything is a plugin.** Base code is vocabulary (the principal, the API, the start script, the worker
  entry); every behaviour, the UI included, is a plugin. Pi stays malleable: cheap extension points, basic primitives.
- **Reload without restarts.** Editing a plugin and applying it loses nothing (decision "Reloads first").
- **Fast and low memory.** Quick worker starts, little RSS per worker, few bytes on the wire (`workflow.md`, Numbers).
- **Small, concise, easy to understand** at every level: code, contracts, docs.
- **Fast, extensive tests** (`workflow.md`, Tests).
- **One owner.** The owner installs every plugin; plugins are trusted code; only people are confined.
- **Consistent names** (`names.md`).

## What we build

**Chord and kit changes** (where each is specified):

- admission before the factory, with the per-acknowledgement binding fence (`packages/chord/docs/admission/design.md`;
  slice 4);
- the kit's reload control `AppChanges` (Chord decision "The kit serves the reload control"; slice 2);
- startup spans and `app.startup` (`archive/startup-telemetry/book.md`, not built; slice 1);
- how a plugin gets its host's store, root scope, load signal and keep-alive (`archive/map/book.md` decision 1, not
  decided; slice 3);
- compression at the origin on the kit's server and worker hosts (`archive/efficiency.md`; slice 1);
- `revokedBy` on the kit's server and workers; removing a device closes its links; pairing for persons; no stale
  admission; authentication precedence (`archive/people/book.md`, What the Kit Must Add; slice 5);
- loader admission, an org's ban (`archive/locks/design.md` §5, `archive/org-managed/book.md`; slice 17);
- rendering another plugin's messages, for the locks sheet (Fable's locks review B1, on slayer; slice 6).

**Base code** (a restart changes it; named after what it is): the principal (`owner`, `person`, `worker`, `server`),
API v1 (shared, server, worker, web, terminal modules), `server.ts` (the server), `worker.ts` (a session worker),
`supervisor.ts` (the `p3` command: restarts the server on request or after a crash).

**Plugins:**

| Plugin | Owns |
| --- | --- |
| sessions | the sessions table, create, rename, archive, delete, export and import; a session's facts (its app, its creator); a worker per session |
| harness | Durable in the session's worker; the registries of extensions, models and environments |
| transcript | a conversation's entries: send, queue, stop, branches |
| models | providers and their sign-in; the faux model for tests |
| environments | this device, SSH, sandboxes; a session's location |
| coding-tools | read, write, edit, bash |
| prompt | AGENTS.md, skills, prompt templates |
| agents | subagents, one-shot agents, code mode, reaching other sessions |
| people | persons, identity providers (Radius, this device), invites, pairing |
| apps | the apps registry, `defaultApp`; coding is the built-in app |
| locks | the locks registry, the layers, the sheets, the agent's lock tools |
| questions | asks and approvals |
| files | uploads, artifacts |
| mcp | MCP servers and their tools |
| views | pane kinds, layouts, slots, the workbench; collaborative views are plugins with server objects, state and events |
| groupings | the sidebar's groupings as plugins: recent, by folder, projects, sections by state, rollups; pins and archive for every grouping |
| org | enrollment, the org profile (later) |
| workspace, terminals | the project's files, git, the file index; PTYs and their viewers |
| status, search, logs | what runs where without starting a worker; message search; notices |
| radius, ports, backup | the relay, forwards, whole-Pi backups |
| discord, chat-mode, voice | sessions talked to from elsewhere and in other ways |

**UI:** the web page on Elanor (Earendil's React design system) and the terminal client, waiting for the team's UI
work (owner, 2026-11-14).

**Not yet sliced:** the base pieces the wake bridge and worker liveness (Durable's wake state to the server; slices 3
or 11), secrets (slice 7), the agent's typed surface (slices 10 and 14). Every domain of p2's functionality map has a
slice (`slices/README.md`, "p2's features by slice").

## In what order

The slices, each with its brief: `slices/README.md`.

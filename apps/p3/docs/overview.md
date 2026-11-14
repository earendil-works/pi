# p3 overview

p3 is the successor of p2 (Pi Mobile): one Pi per person, built on Chord v2 and its app kit, next to p2 in
`apps/p3/`, with its own data directory. Nothing is built yet.

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

**Chord and kit changes** (specified in `packages/chord/docs/`):

- admission before the factory, with the per-acknowledgement binding fence;
- the kit's reload control (`AppChanges`: the marks and Apply, for the owner);
- workers get `revokedBy`; removing a device closes its links; pairing for persons; loader admission (an org's ban);
- rendering another plugin's messages (the locks sheet shows every plugin's titles).

**Base code** (a restart changes it): the principal (`owner`, `person`, `worker`, `server`), API v1 (shared, server,
worker, web, terminal modules), the start script, the worker entry.

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
| org | enrollment, the org profile (later) |

**UI:** the web page and the terminal client on Elanor, from the team's port of p2.

**Tests:** the topology harness (server and workers in one process), the faux model, a few end-to-end runs.

## In what order

The slices, each with its brief: `slices/README.md`.

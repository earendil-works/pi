# Spec: Todos v2 — file-backed tasks with **lists** + `/todos` (YAML front-matter)

Status: draft

## Goal

Replace the current in-memory `TodoWrite` (“replace the whole list”) with a durable todo system that:

- survives restarts
- supports parallel agents in **different workspaces** and **the same workspace**
- stays aligned with backbuffer principles (durable state on disk; minimal context injected)

Preferences baked in:

- Use **YAML** front-matter
- Provide an interactive **`/todos`** UI in the TUI

Non-goals (first cut):

- No extra taxonomy (“epic/workstream/slice”)
- No requirement to commit todos into the repo (we can support it via config later)

---

## Nomenclature

- **Todo / Task**: unit of work
- **List**: primary container a todo belongs to (exactly one)
  - default: `inbox`
- **Tags** (optional): cross-cutting labels (0..N)
- **Assignment**: who is working it (`assigned_to_session`, `assigned_to_run`)
- **Lock**: prevents concurrent edits to the same todo file

This matches the common mental model in todo apps:

- tasks live in a list/project
- labels/tags are many-per-task and used for filtering

---

## Storage (parallel-safe)

Default storage directory (workspace-local):

- `<repoRoot>/.mu/todos/`

Override:

- `MU_TODO_PATH` (absolute or repo-relative)

Rationale:

- Different workspaces ⇒ different directories ⇒ no collisions
- Same workspace ⇒ shared directory ⇒ coordination via locks + assignment
- `.mu/` can be gitignored so this remains tool state, not repo churn

---

## Todo file format (YAML front-matter + markdown body)

One todo = one file: `<id>.md`

Format:

```md
---
id: deadbeef
title: Refactor TodoWrite into file-backed todo tool
list: mu-infra
tags: [agent, todos]
status: open
created_at: "2026-02-08T02:00:00.000Z"
updated_at: "2026-02-08T02:10:00.000Z"
assigned_to_session: "session-uuid"
assigned_to_run: "run-uuid"
---

Notes, links, verification commands, etc.
```

Parsing rules:

- If the file starts with `---\n`, treat everything until the next `---\n` as YAML front-matter.
- Everything after the closing `---` is markdown body (verbatim).

Field rules:

- `list` is required (default on create is `inbox`)
- `status` ∈ `open | in_progress | done | cancelled`
- `assigned_to_*` are optional and auto-cleared when status becomes `done` or `cancelled`

---

## Concurrency model (same workspace)

### 1) Per-todo lock file (exclusive edit)

- Lock file: `<id>.lock`
- Created via atomic create (fail if exists)
- Contains metadata:
  - `pid`, `session`, `run`, `created_at`
- Lock TTL (e.g. 30 minutes) to avoid deadlocks
- Stealing a stale lock requires `force: true`

Purpose:

- prevent concurrent writes to the same todo

### 2) Assignment (coordination)

Front-matter fields:

- `assigned_to_session`
- `assigned_to_run` (distinguishes two concurrent processes using the same session)

Operations:

- `claim`: sets assignment to current session/run
  - fails if assigned to other session/run unless `force: true`
- `release`: clears assignment
  - fails if assigned to other session/run unless `force: true`
- closing (`done/cancelled`) auto-clears assignment

Purpose:

- avoid two agents starting the same work in parallel

---

## Identity (“whoami”)

We need two IDs:

- **session id**: stable identity for the conversation thread (`SessionManager.getSessionId()`)
- **run id**: unique per process invocation (generated at startup)

Practical integration plan:

- CLI exports (or otherwise makes available) environment variables:
  - `MU_SESSION_ID`
  - `MU_RUN_ID`

Tools use these to populate lock metadata + assignment.

---

## Tool surface: replace `TodoWrite` with `Todo`

Introduce a new tool: **`Todo`** (action-based API, no “replace the full list”).

Core actions:

- `list`
  - filter by: `list`, `status`, `tags`, assignment state
  - sorting: open first, then assigned-to-current-session, then `created_at`
- `get` (full record + body)
- `create`
  - inputs: `title`, optional `list` (default `inbox`), optional `tags`, optional `body`
  - optional `claim: true`
- `create_many`
  - batch create to preserve “agent can write the plan in one tool call” ergonomics
- `update` (replace fields/body)
- `append` (append markdown notes without clobbering)
- `claim` / `release`
- `claim_next`
  - atomically pick an unassigned matching todo and claim it
  - key primitive for parallel agents (avoid list→claim races)
- `delete` (likely requires `force` if assigned)

Status set:

- `open | in_progress | done | cancelled`

Notes:

- Avoid global constraints like “only one in_progress todo total”. Parallelism is the point.

---

## `/todos` (interactive TUI command)

Add a slash command: **`/todos`** that opens a dedicated overlay UI.

Minimum viable UX:

- Search input (token/fuzzy match)
- List view that separates:
  - assigned-to-me
  - open/unassigned
  - done/cancelled (optionally hidden)
- Selecting a todo opens an action menu:
  - view
  - claim / release
  - mark `in_progress` / `done` / `cancelled`
  - append note
  - copy path / copy text

Design intent:

- `/todos` is for the human supervisor to inspect/steer.
- The `Todo` tool API is for automation (`create_many`, `claim_next`, etc.).

---

## Backbuffer alignment (avoid context bloat)

- Durable work state lives on disk (`.mu/todos/*.md`), not inside the chat.
- Agents should only load what they need:
  - `Todo.list` for a specific list
  - `Todo.get` for the single todo being worked

Scratchpad remains separate:

- `devdocs/scratchpad.md` is for long-lived learnings (preferences, gotchas), not a task tracker.

---

## Open decisions

1) Are list names free-form strings?
   - Recommendation: yes. Discover lists by scanning todos.

2) Should `.mu/todos` be gitignored by default?
   - Recommendation: yes. Repos that want committed tasks can set `MU_TODO_PATH` to a tracked directory.


# `/tree`: branching the main conversation

pi's `/tree` in p2 (owner decisions from the design discussion). Code: `plugins/tree/` (worker, web sheet),
`src/runtime/main-conversation.ts`, `src/tui/components/tree-selector.ts`, `/tree` in `plugins/chat/tui.ts`, the sidebar's
branch rows (`src/web/Drawer.tsx`, `plugins/sessions/web.tsx`, `BranchSheet.tsx`). Tests:
`tree.test.ts`, `tui-tree.test.ts`, `ui-tree.test.ts`.

## Goal

pi's `/tree` (`packages/coding-agent/src/core/agent-session.ts` `navigateTree`, `components/tree-selector.ts`) moves
the session's position to an earlier entry; the next message starts a new branch there, and old branches stay
reachable. Example:

```
1 "add login"   2 answer   3 "use OAuth"   4 answer
/tree, pick 3 → continue after 2, editor holds "use OAuth"
5 "add password reset"   → the model sees 1, 2, 5
```

## Approach: one Durable fork per branch

A Durable conversation is a linear list of entries. A head marker only cuts a prefix of the context, so "continue
after 2" cannot be expressed inside conversation 1. Durable's forks can: `forkConversation(1, at: 2)` creates a
conversation whose history is 1's entries through 2, then its own. Nothing is copied. Rejected alternatives: a
`head: "self"` entry carrying a copy of the context (copies a context per switch), and head markers with an end point
(changes Durable's context rule).

Durable needs no change. Fork policies (spec §3.7) give the right state: `pi.agent` is `asOf` (model, tools,
instructions as at the fork point); `pi.inbox`, `pi.provider` and `pi.usage` start fresh.

## 1. Top-level conversations and the current main

The session-scoped Durable document `p2.main = { conversation, branches: { conversation, label }[] }` (`MainDoc`,
version 2; absent: `{ 1, [{ 1, null }] }`):

- **Top-level** = in `branches`: conversation 1 and every conversation `/tree` created, added in the switch's commit.
  An explicit list, not "conversations no task owns": older sessions (and `harness-cwd.test.ts`) have subagents
  created without an owner, and conversation records are table reads, which only commits offer. Every "main agent
  only" check (tools and sections of ports, conversations, locations, dev-tools, `rename_session`, the one-shot agent
  list, `Sessions.fork`) uses `isTopLevel`, a document read every tool (`api`) and section (`input.read`) can do.
- **Current main** = `conversation`. It answers "which top-level conversation is shown and followed": the session row
  (`main`; model and thinking level follow it), the web home route, the drawer, the chat's back links, TUI checks,
  terminals, reading unread answers, `Sessions.fork`, and peer messages (the conversations broker).
- Clients learn it through the session row (`Sessions` version 4, catalog schema 4; version 5: null labels); the
  worker pushes it inside the switch, before answering, and at every start (`treeSelf`). Clients built before still
  bind: the providers accept `Sessions` 3, 4 and 5 and `SessionTree` 1, mapping rows and the tree back (no `main`/`branches` for 3, a null
  label as the session title for 4, no labels for `SessionTree` 1). A web page or TUI viewing the previous main conversation follows a switch.
- Earlier branches are read-only (`ReadOnlyConversations`): only the main conversation takes input (send, dequeue,
  configure); Stop stays allowed. A branch left while it works keeps running in the background: its run and queued
  input go on, its sidebar row shows the working dot, and its answer counts as unread. To watch or stop it, switch
  back to it. The web shows only the main conversation and subagents (others redirect to the main one).
- **Labels** are stored per branch (see [Labels](#labels)).

## 2. Per-agent state

The main agent's state stays on conversation 1, whichever branch it works in; a subagent keeps its own:

| Document | Where |
| --- | --- |
| `p2.subagents` | Conversation 1, as before. Subagents are session-wide. A subagent's report goes to the top-level conversation that sent the message (reporter input `parent`), and `team send to: "parent"` to the one that last spawned it or sent it a message (`Subagent.parent`), even after a `/tree` switch; records from before fall back to the current main. TODO on `Subagents`: should probably become session-scoped (a migration). |
| `p2.location-move` | Conversation 1: the move belongs to the session, whichever top-level conversation asked. |
| `p2.artifacts`, `voice.mode`, `chat-mode.settings` | `agentConversation(id)`: conversation 1 for a top-level conversation, the conversation itself for a subagent or one-shot agent. No copying at switches, no migration. |

All of these could become session-scoped documents keyed per agent in one later migration.

A branch forked before a subagent was spawned still lists that subagent (accepted: it is still running).

## 3. Switching and the tree

### Navigate

`SessionTree.navigate({ entry })` (owner), pi's rules:

| Picked | Result |
| --- | --- |
| user message U | continue before U; returns U's text for the editor |
| any other message E | continue after E |

Where the session continues: the top-level conversation whose history ends there (the main one first; switching back
moves only `p2.main`), else a fork of the conversation storing that entry (same history, shorter chain than forking
the one it was picked in), else, before the first message, a new ownerless conversation with the agent as it was then.
The new conversation, its label and `p2.main` are one commit. Allowed while the current main has a run or queued
input: that work goes on in the branch left (see Top-level conversations), as do subagents. Shared per-agent state
(section 2) is then used by two runs at once; accepted. A subagent's report still goes to the branch that asked
(section 2).

### Labels

What the sidebar and the TUI selector call a branch: `label` in `p2.main`, stored, never derived from later messages.

- **A new branch** is labelled in the commit that creates it, with the first `PREVIEW_LENGTH` (200) characters of the
  message the owner picked, on one line: the answer for "Branch from here", the user message itself for "Edit" (not
  the answer the fork starts after). Switching to an existing branch changes no label.
- **Conversation 1** has no fork point: its label is null, and every UI shows the session title for a null label, so
  it follows a session rename. Once renamed, its stored label wins.
- **Renaming:** `SessionTree.rename({ conversation, label })` (owner): one line, 1 to 200 characters after trimming;
  null or empty resets conversation 1 to the session title (other branches need a label). Web: the pencil beside a
  branch row (on hover; always on touch screens) opens a sheet. TUI: pi's label key (`app.tree.editLabel`, Shift+L) in
  `/tree` renames the branch holding the selected message.
- **Version 1** (`branches: number[]`) migrates to `label: null` (Durable `migrate`). At start the worker labels the
  null branches other than conversation 1 once, in one commit: the fork point's message (`parent.at`; for an Edit that
  is the entry before the edited message), else the branch's first own user message.

### Tree

`SessionTree.tree()` (owner) returns the nodes (entry, parent node, role, preview), the main conversation and its last
node:

- Nodes are user messages (not head markers) and assistant answers with text, like pi's default filter.
- A branch's own entries are its fork-aware entries with IDs above `parent.at` (entry IDs are Session-global and the
  fork is created after `at`); its first node hangs below the last node at or before `parent.at`.
- The whole history is scanned per call: fine for now; long sessions may need paging.

### Where

- TUI: `/tree` (`app.session.tree`) and double Escape (`doubleEscapeAction`, default "tree" as in pi), a selector
  adapted from pi's `tree-selector.ts` (layout, active path, paging, label input; no filters or folding). A branch's
  label shows before its first own message (`TreeNode.conversation` names the branch storing a node).
- Web: "Edit" beside the owner's view of a user message (on hover; always shown on touch screens) and "Branch from
  here" under an answer, in the main conversation. Under the session in the sidebar, from two branches on, one row per
  branch (`Sessions` rows' `branches`: the stored labels, null for the session title, newest first in a stable order,
  the current one marked in place), behind the session row's expand control, which also shows its subagents
  (collapsed by default, expanded while a subagent is shown); choosing one switches the session to its end
  (`SessionTree.select`). The worker
  pushes `p2.main` (`treeSelf`: `main` and the branches with their labels) at start and inside each `SessionTree`
  method that changes it, before the method answers (nothing else changes `p2.main`).
- Search indexes each branch's own entries (after its fork point).

## Later

- Branch summary of the branch being left (pi's `branchSummary`): a write in the new branch after the fork.
- Filters and folding in the selectors; labels on single entries (pi's entry labels).
- Session cost: sum `pi.usage` over all top-level conversations.
- History tools in a branch search only the branch's own entries (inherited ones are indexed with conversation 1).
- Deleting or archiving branches.

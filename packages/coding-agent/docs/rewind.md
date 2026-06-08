# Rewind with file restore

Pi can rewind a conversation **and** restore your files on disk to the state they
were in at that point — like Claude Code's rewind. This document explains how it
works, how to use it, and its limitations.

## TL;DR

1. Make sure the editor input is **empty**.
2. Press **`Esc` twice** quickly (double-escape).
3. Pick the point you want to go back to in the tree selector.
4. When asked **"Restore files to this point?"** choose:
   - **Conversation + files** — rewind the chat *and* roll the files back.
   - **Conversation only** — rewind the chat, leave files as they are (the old behavior).
5. Pi navigates back, restores files if you asked, and shows a status line telling
   you exactly what it changed.

> Double-escape can also be configured to open the *fork* selector instead of the
> tree selector. The file-restore prompt appears in the **tree selector** flow.
> If `Esc Esc` does nothing, your `double-escape action` setting may be `none` or
> `fork`.

## What "rewind" means here

A pi session is an append-only log (a tree) of entries: user messages, assistant
messages, tool calls, etc. Every entry has a `parentId`, so "going back" is just
moving a pointer (the *leaf*) to an earlier node. The conversation rewind already
existed; this feature adds the **file** side.

When you rewind to a user message `U`, pi can put your files back to how they were
**right before pi started working on `U`**.

## How file restore works (under the hood)

### Capture (while pi edits)

- A **checkpoint** is taken per **user turn** (each user message you send).
- The first time pi's `edit` or `write` tool touches a file in a turn, pi saves
  that file's **before-content** to a content-addressed blob store. Subsequent
  edits to the same file in the same turn don't re-save the baseline (first-touch
  wins).
- Saved content is deduplicated by SHA-256 hash, so a file with identical content
  across turns costs one blob.

### Storage

- Blobs live in: `~/.pi/agent/checkpoints/<sessionId>/blobs/<sha256>`
- A small **manifest** is appended to the session log per turn:
  `{ turnId, files: [{ path, before, after }] }` where `before`/`after` are
  content hashes (`before: null` means "the file didn't exist yet").
- Manifests are stored as `custom` session entries, so they persist across
  restarts and resumes and never enter the LLM context.

### Restore (when you rewind)

To restore to a point `T`, pi rolls back every turn from the current branch tip
down to `T`:

- For each file, the **earliest** captured before-state (closest to `T`) is the
  target content.
- Files that didn't exist at `T` (created afterward) are **deleted**.
- Restore is computed as a full plan first, then applied — and each file is
  written under the same per-file lock pi's tools use, so a restore can't collide
  with an in-flight edit.

### Safety guards

- **Won't run while the agent is working.** Restore is refused mid-run.
- **Won't clobber your manual edits.** Before touching a file, pi checks whether
  its current content matches what pi last wrote. If you (or a `bash` command)
  changed it since, pi **skips** that file and reports it as
  *"changed outside pi"* instead of overwriting your work.
- **Crash-safe.** A restore marker is written before any disk change; if pi
  crashes mid-restore, it re-applies the plan on next startup (restore is
  idempotent).

## The status line after a restore

Example:

```
Navigated to selected point · 3 files restored, 1 deleted, 1 skipped (changed outside pi)
```

- `N files restored` — files rewritten to their earlier content.
- `N deleted` — files that were created after the target and got removed.
- `N skipped (changed outside pi)` — files you/bash changed after pi last wrote
  them; **left untouched** so your work isn't lost.
- `files already at this point` — nothing needed changing.

## Limitations (read this)

This uses a **tool-edit content log**, not a full filesystem snapshot. That means:

1. **Only files changed through pi's `edit`/`write` tools are tracked.** Changes
   made by raw `bash` (e.g. `rm`, `mv`, code generators, `npm install`) or by an
   external editor are **not** captured and **not** restored. After a restore,
   your working tree may differ from a true snapshot — the status line's
   "skipped" count and this caveat are how you know.
2. **No "code only" mode.** You can rewind *conversation + files* or
   *conversation only*. Rewinding files without the conversation was intentionally
   cut: it leaves the model's history describing edits that no longer exist on
   disk, which desyncs the agent against its own context.
3. **Hard crash mid-turn.** If pi is killed (e.g. `kill -9`, power loss) after an
   edit but before the turn finishes, that turn's manifest may not be persisted,
   so that single turn isn't rewindable (its blobs are harmless orphans). Normal
   errors and aborts are fine — the manifest is flushed at the end of every turn.
4. **Blob cleanup is tied to session deletion.** Checkpoint blobs under
   `~/.pi/agent/checkpoints/<sessionId>/` are deduped and small, and they're
   removed automatically when you delete the session from the session selector.
   There's no time-based GC, so very long-lived sessions accumulate blobs; delete
   the session (or its checkpoint directory) to reclaim the space.
5. **Custom tool sets.** If an embedder overrides pi's base tools, file restore is
   disabled for that session and rewind falls back to conversation-only.

## Developer notes

- Core logic: `src/core/file-checkpoint-store.ts` (`FileCheckpointStore`).
- Wiring: `src/core/agent-session.ts`
  - constructs the store (skipped when base tools are overridden),
  - injects capture via `wrapEditOperations()` / `wrapWriteOperations()` into the
    built-in `edit`/`write` tools,
  - calls `beginTurn(leafId)` on each user message and `flushPending()` on
    `agent_end`,
  - exposes `restoreFilesTo(targetId, fromLeafId)` and `supportsFileRestore`.
- UI: `src/modes/interactive/interactive-mode.ts` `showTreeSelector()` adds the
  "Restore files to this point?" prompt and prints the summary.
- Tests: `test/file-checkpoint-store.test.ts`.

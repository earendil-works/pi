# Slice 19: Workspace and terminals

**Goal.** The session's project as p2 shows it: list, read, search, git status, diff, log, commits; the file index and `@` completion; change notifications; uploads into the project and downloads; review comments sent as a message; confinement and git hardening. Terminals: a detached host process owning PTYs, attach with a screen snapshot, several viewers, flow control, single-use channel tokens.

**Depends on:** slices 8.

**Read first:** `apps/p2/docs/p3-functions/environments-workspace.md`; p2's `plugins/workspace/`, `plugins/file-index/`, `plugins/terminals/`, `docs/changes.md`; design §23 (byte channels, chunked transfers) and decision #23 (the terminal host process).

The brief is filled out when the slice is next, starting with p2's features in its area (`../workflow.md`).

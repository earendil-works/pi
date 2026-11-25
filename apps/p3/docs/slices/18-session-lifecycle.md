# Slice 18: Session lifecycle

**Goal.** Everything a session goes through after it exists, as p2 has it: pin, automatic and agent-set titles, archive that stops the worker and ends guest access and forwards, restore, relocate (idle only, followers move, cross-machine refused), clone, fork at a user message, delete (every plugin's data), unread marks; workers: idle stop, a failed start that stays failed until retried. Extensible: a lifecycle registry so every plugin's per-session data follows archive, clone, fork and delete.

**Depends on:** slices 1, 3, 8.

**Read first:** `apps/p2/docs/p3-functions/sessions-access.md`; p2's `plugins/sessions/`, `plugins/tree/` (`docs/tree.md`), `plugins/drafts/`; Chord's kit `exportData`/`importData`/`deleteData` and `copyFiles` (design §23); `archive/model-stress/report.md` 887-901 (the lifecycle registry); slice 15 (pins and archive as sets every grouping uses).

The brief is filled out when the slice is next, starting with p2's features in its area (`../workflow.md`).

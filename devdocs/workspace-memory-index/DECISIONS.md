# Decisions

## 00-orchestrator
- Scope is limited to projection, prompt context formatting, and TUI startup rendering.
- Artifact memory ledger and `memory_search`/`memory_read` remain authoritative and unchanged unless a later accepted task says otherwise.
- Workspace memory startup surface should behave like a wiki index: short label plus referenced path(s), not summary prose.
- Task order is projection first, then prompt consumer, then TUI consumer.

## 01-projection-index-shape
- Added explicit `projection.indexItems` with `{ id, kind, label, paths }` derived from active entries only.
- `indexItems[].paths` comes from entry `artifacts`; labels stay short via existing projection label rules.

## 02-prompt-index-context
- Startup prompt context now renders workspace memory from `projection.indexItems` as index rows with path references.
- Prompt context must not inject `startupSummary` prose when index items exist.

## 03-tui-index-display
- TUI startup chrome now renders workspace memory from `projection.indexItems` as label/path rows.
- Empty projections preserve the existing behavior of showing no workspace-memory chrome.

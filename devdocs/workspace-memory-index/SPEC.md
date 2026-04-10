# Workspace Memory Index

## Original user query

Please analyze how the workspace memory works. Right now, I think it injects the summary text in the context. Instead, I prefer this to be like an "index" instead, where it just shows alt text and the path to the document, like a wiki index.

Approved architecture direction:
- boundary: projection/prompt/TUI only
- abstraction: explicit index model
- tradeoff: prioritize index brevity over startup recap richness
- what matters most: make memory easier to scan like a wiki index

## Verified current behavior

- `packages/coding-agent/src/project-context.ts` loads the workspace projection file and injects `startupSummary` into model context.
- `packages/coding-agent/src/prompts/index.ts` wraps that content as `<project_instructions>`.
- `packages/coding-agent/src/tui/tui-renderer.ts` renders the same `startupSummary` in startup chrome.
- The existing projection already contains enough structured data to support an index-style view without changing the ledger.

## Decomposition rationale

Use depth-first slices:

1. Build the explicit index projection first so both consumers can depend on a stable derived shape.
2. Switch prompt context loading to the new index representation and verify prompt payload shrinks from summary prose to label/path rows.
3. Switch TUI startup rendering to the same index representation and verify the visible startup text matches the new projection shape.

This keeps the ledger and memory tools authoritative, avoids scope creep into search/read behavior, and limits change to the approved boundary.

## Execution order

1. `projection-index-shape`
2. `prompt-index-context`
3. `tui-index-display`

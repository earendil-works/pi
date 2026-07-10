# Changelog

## [Unreleased]

### Added
- User-defined **quick commands**: arbitrary `/<name>` shortcuts stored under `settings.webui.quickCommands` as `{name, description?, prompt}`. Anything typed after the command name is substituted into the prompt template as `$ARG`. Manage from a new `/commands` page (Terminal icon in the sidebar) or add inline from a bar docked above the chat input.
- `api.compact(sessionId, customInstructions?)` on the webui client (waits for `compact_done`, 30s timeout).
- `api.getQuickCommands()` / `api.setQuickCommands(commands)` for the settings round-trip.

### Changed
- `POST /api/memory/extract` response shape rename (extract-oldid-merge, personal-assistant change): the top-level `superseded` field is renamed → `updated`, and `supersededPairs` → `updatedPairs`. Webui callers reading these on the success response must switch the field name. Also propagates to the underlying `RunMemoryExtractionResult` TypeScript contract — webui-server-side scripts using `result.superseded` from memory.ts must switch to `result.updated`. (Coordinated with extensions/personal-assistant CHANGELOG breaking-changes entry.)
- WebSocket handler accepts a new `compact` message type. The server's existing `compaction_start` / `compaction_end` events are still forwarded as `session_event` and now also clear the "Compacting…" indicator.
- `POST /api/memory/search` now delegates to the shared `recallPipeline` from `extensions/personal-assistant/recall.ts` (single recall entry point shared with the TUI). The inline rewrite → recall → rerank → merge block (and the inline `/api/health` probe) is gone; behaviour and response shape are preserved verbatim, and the timings now come from the pipeline's per-stage `performance.now()` deltas. `topK` defaults to 20 (matching the pipeline + TUI default) instead of 10 at the route boundary; the pipeline still clamps to `[1, 100]`. The optional `recent` field is now accepted; when supplied it must be `string[]` (else 400). `MemoryDeps.embeddingServiceUrl` is now an explicit optional override (was previously read via an inline type cast).

### Reserved names

The following names cannot be used for user-defined quick commands (they conflict with webui-dispatched built-ins):

- `compact` — triggers `api.compact()`
- `new`, `model`, `bash` — reserved for future webui dispatch

- **Memory page** (`/memory` sidebar route, `Brain` icon in IconRow): browse, edit, archive, and recall-test all memories persisted by the `pi-personal-assistant` extension.
  - 3-pane layout: list (30%, filterable by type/archived/tag/q/sort/limit), detail (70%, metadata + Markdown body editor), and collapsible search tester (real `rewriteQuery + searchAtomsWithScores` pipeline).
  - 6 new REST endpoints under `/api/memory`: `GET list`, `GET :id`, `PATCH :id`, `POST :id/archive`, `POST search`, `GET stats`.
  - `api.memory` namespace on the webui client with 6 methods.
  - `useAutoSave` hook (3s debounce + 200ms unmount flush deadline) wired into `MemoryDetail` for transparent auto-save.
- "bug" promoted to 8th `MemoryAtomType` (production data had 1 atom of this type; previously caused silent type rewrite on PATCH).
- GET /api/memory/:id/stream — SSE endpoint pushing atom-version updates to subscribed clients
- PATCH /api/memory/:id requires If-Match header (returns 409 on version mismatch, 400 if missing)
- PATCH response includes optional `previousId` field when a similar atom was auto-superseded
- MemoryDetail uses SSE to replace the prior 3-second polling loop

### Changed

- `POST /api/memory/search` response is now discovery-only: `{results: [{id, type, title, summary, tags, distance, cosine, score}], recallTimeMs}` — no `tier` / `formattedText` / `tokenBudgetUsed`. The agent calls `memory_get(id)` to fetch full content (the sole programmatic strength-feedback entry). The MemorySearchTester UI now shows each result's `score` directly.
- `GET /api/memory/:id` is preview-only — does not bump `access_count`.
- 409 conflict responses in MemoryDetail now surface an inline status banner instead of a full-page error

### Fixed

- WebUI server tests (`memory-routes.test.ts`, 21 cases) now run via the project's actual `npm test` flow instead of silently failing — `packages/webui/vitest.config.ts` had no `server.deps.inline` for `node:sqlite` / `bun:sqlite` / `@earendil-works/pi-personal-assistant`, and `vite-node` 2.1.8 stripped the `node:` prefix from dynamic imports before the inline check ran. Added a small Vite plugin (`webui:sqlite-builtin-shim`) that re-adds the prefix and serves a `require`-based stub letting Node's CJS loader handle the builtin natively.
- `<memory-error>` placeholder banner in the body editor when `content === ""` with a non-empty `file_path` (slug-collision case — file was overwritten by another atom sharing the title). Surfaces the existing R14 limitation as visible feedback instead of a silent empty editor.
- `SearchTester` now shows a "using keyword fallback (no LLM rewrite)" notice when `rewriteQueryWithCallLlm` degraded to `simpleKeywordExtraction` (new `fallback: boolean` field on `QueryRewriteResult` propagated through the API response and the UI).
- "Save now" button in `MemoryEditor` previously called `onSave` which restarted the 3s debounce — now calls `useAutoSave.flush()` directly via a new `onFlush` prop, so it actually saves immediately.
- `raw_query` in search responses now defaults to the user's input query when the LLM omits the field (previously empty string).
- MemoryPage filter input debounced 300ms before triggering a server refetch — typing in `q` / `tag` no longer fires a full list + stats refetch on every keystroke.
- Preview tab now uses the shared `<Markdown>` component (matching chat-page rendering) instead of raw `whitespace-pre-wrap` text.
- MemoryList archive control now shows "Archive" / "Restore" text labels instead of small ✕ / ↺ icons.
- Clicking the **active** list item now re-fetches the detail panel. `setSelectedId(id)` with the same id was a React no-op, leaving `MemoryDetail` with stale state and only re-fetching on the 3s polling tick. Fixed by giving `MemoryPage` a `refreshKey` counter that bumps on every click and becomes part of `MemoryDetail`'s `key` prop, forcing React to unmount + remount. (`MemoryPage.tsx`)
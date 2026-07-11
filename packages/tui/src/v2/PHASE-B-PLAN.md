# Pi TUI v2 Phase B integration plan

Status: gated design note; no Phase B source changes yet.
Inputs: design commit `16d4948`, Phase A `e3452638`, Ember protocol verdict pending, quarantined call-site map reviewed under PM authorization.

## 1. Parallel entry point and selection

- Add `packages/tui/src/v2/index.ts` and the `./v2` package export. Keep v1 exports and constructor behavior unchanged.
- Add `--tui v1|v2` plus `PI_TUI=v1|v2`; CLI wins over env, default remains v1, invalid values fail before interactive startup.
- In coding-agent startup select either the existing `TUI` or a new `V2TUIHost` behind a narrow structural host interface. Do not add a v2 branch to v1 `doRender()` or reuse v1's whole-tree `render(width)` path.
- Preserve extension-facing `TUI` arguments through a compatibility facade where necessary; the v2 host owns the actual Band, Ledger, focus, overlays, and Presenter.

## 2. Host/frame pipeline

`V2TUIHost` owns:

- `LedgerStore`, ordered `StripSlot[]`, overlays, focus/caret owner;
- `BandLayout`, shared `StyleTable`/`LinkTable`, front/back `CellBuffer`s;
- `FrameScheduler`, dirty/layout-dirty sets, resize/theme epochs;
- `Presenter`, terminal capability record, pending serialized ledger lines;
- cancellable re-commit job and metrics.

Each coalesced frame follows the design order exactly:

1. apply resize/theme epoch and cancellation;
2. advance only the current Ledger frontier under budget;
3. layout dirty strips and assign all geometry in `BandLayout`;
4. paint dirty strips then overlays into the back buffer;
5. compute row damage against the front buffer;
6. perform one Presenter write containing sync begin, ledger commits, band updates/full repaint, exactly one caret CUP, sync end;
7. swap buffers and record metrics.

No frame path traverses committed blocks. A full band repaint is still O(viewport), never O(history). Frontier scheduling guarantees at least one dirty-block step per frame before discretionary work, even when the nominal budget is exhausted, so sustained streaming cannot starve commits and grow the band without bound.

## 3. Presenter protocol

Presenter input is structured, not v1 strings:

- newly committed `StyledLine[]` segments after one-time width safety/hard wrap and ANSI serialization;
- band geometry plus `DamageRun[]` or a full-band repaint;
- one focused-strip caret in band-local coordinates;
- terminal dimensions/capabilities and re-commit state.

Presenter owns physical band origin, previous band height, hardware cursor, synchronized-update wrapping, shrink-row clearing, and terminal cleanup. Normal commits CUP to band top and emit each line once so the band is pushed downward atomically. Height changes repaint the full bounded band and clear vacated rows, while preserving v1's Termux height-change behavior as an explicit terminal-capability policy rather than an implicit special case. A focused visible caret produces the frame's sole caret CUP; a no-focus or hidden-cursor frame parks the cursor at the configured safe location and applies the matching DECTCEM policy. Ghostty/Kitty history images degrade to `[image: name (WxH)]`; no image commit is attempted where the protocol matrix marked it unsafe.

Protocol tests must cover grow/shrink, byte-chunked writes, resize + `3J` replay, cleanup cursor placement, tmux, and the xterm scrollback oracle before dogfood.

## 4. Ledger adapters and live-tail ownership

Add a coding-agent transcript adapter that maps logical messages/tool calls to data blocks, not retained v1 chat components. Each block has a pure `(model, width, theme) -> StyledLine[]` renderer and explicit frontier policy:

- streaming assistant markdown: `ConservativeMarkdownFrontier` initially; unstable suffix is the tail strip;
- append-only tool/bash text: `CompletedLineFrontier`;
- args/result renderers that can reflow prior output: block-stable until the relevant phase closes unless the renderer supplies a progressive hint;
- static user/system/custom/summary sections: final immediately;
- sequential transcript status: one open live-tail block updated in place; finalize only when superseded by the next transcript item. Never re-commit on each status update.

Before integration, strengthen the adapter invariant test: all emitted commit segments concatenated at finalization must equal a fresh final render; a renderer/frontier that rewrites an already committed prefix must fail loudly and request explicit re-commit.

## 5. Quarantined call-site map -> v2 hooks

Use the snapshot only as a location checklist; do not reuse its `LedgerContainer` or Presenter.

- `message_start` / streaming updates / `message_end`: create, update, finalize assistant block; finalize aborted pending tools in source order.
- tool execution start/update/result/abort: create open tool block, update model, advance appropriate frontier, finalize on result/abort.
- async bash immediate/deferred: create open line-stable block; deferred blocks enter the ledger only at their established transcript order and assert at flush time that they append at or ahead of the current frontier, never behind it; finalize on completion.
- session restore and ordinary `addMessageToChat`: append final logical blocks directly.
- clear/rebuild paths around session switch, compaction, branch navigation: replace logical block list and start explicit re-commit.
- expand/collapse, thinking visibility, image settings, theme change: mutate logical display state; if affected blocks are committed, trigger one explicit re-commit; if only live, repaint the relevant strip.
- editor/widget/footer/header swaps: replace strips, unmount old timers, mount new, mark layout dirty; never touch ledger history.

## 6. Re-commit policy

Allowed triggers only:

- terminal width epoch change;
- theme epoch change;
- committed message edit or renderer display mutation (expand/collapse, thinking visibility, image settings);
- compaction/session/branch history rebuild;
- explicit frontier invariant violation requiring an edit replay.

Not triggers:

- sequential status replacement;
- streaming chunks or tool-line appends;
- spinner/loader ticks;
- editor, footer, widget, overlay, or height-only band updates;
- ordinary block finalization.

Re-commit clears via `2J/H/3J`, replays logical blocks from the tail up to `maxReplayLines`, emits the earlier-history marker when capped, chunks work across frames, keeps the band coherent, and cancels/restarts on a newer width/theme epoch.

## 7. Compatibility layers

- `LegacyStripAdapter`: cache and parse ANSI strings to spans only when a v1 component invalidates; measure/paint within assigned region; clip with a metric rather than throw.
- `LegacyBlockRendererAdapter`: pure render call plus ANSI-to-span parse for message/tool renderers.
- `EditorStrip`: new `TextModel`/`TextLayout` path; legacy editor adapter derives its caret from `CURSOR_MARKER` only at the boundary.
- Preserve input listener ordering, focus restore, overlays, custom footer/header/editor, widgets, `ctx.ui.*`, and existing keybinding indirection.

## 8. Verification and commit sequence

1. v2 exports + CLI/env selection tests; prove flag-off v1 snapshots unchanged.
2. ANSI serializer, Ledger commit queue, and Presenter deterministic unit tests.
3. Band host composition, dirty repaint, caret uniqueness, overlay clipping golden tests.
4. transcript adapters and call-site hooks with faux-provider streaming/tool/bash tests.
5. re-commit job, replay cap, cancellation, and scrollback-integrity oracle.
6. legacy adapters against existing component/editor tests, plus an explicit extension tranche exercising the `ctx.ui.*` facade end-to-end (children, focus, overlays, render invalidation, terminal access, custom header/footer/editor, and widget lifecycles).
7. full `npm run check`, focused tests, `./test.sh`, tmux/xterm protocol runs, then guarded `PI_TUI=v2` interactive smoke; v1 remains default throughout.

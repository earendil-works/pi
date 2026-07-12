# Pi TUI v2 Phase B integration plan

Status: reconciled to maintainer decisions of 2026-07-12; Phase B implementation authorized behind `PI_TUI=v2`.
Inputs: design commit `16d4948`, Phase A `9507965a`, Phase-0 protocol evidence `bcdacb27` (spike corrected verdict), quarantined call-site map reviewed under PM authorization (preserved verbatim at tag `handoff/tui-v2-ledger-band-dirty-20260712`).

## 0. Maintainer decisions (Thomas, 2026-07-12, via broker)

1. **Resize scrollback semantics resolved:** v2 re-commit MAY clear terminal scrollback (`CSI 3J`) on resize, accepting deletion of pre-session terminal history, **provided history within the Pi session remains scrollable afterwards** (tail replay up to `maxReplayLines` plus the earlier-history marker). The spike's `3J`-vs-duplicates HOLD is resolved in favor of `3J`. **Binding acceptance (broker refinement, 2026-07-12):** after resize/re-commit the user must be able to browse/scroll the **full Pi-session history end-to-end from within Pi**. Clearing pre-session terminal history is allowed, and native terminal scrollback may hold only the capped, duplicate-free replay tail (marker emitted exactly once at the tail's head) — but retaining older rows in an internal data structure behind a marker is NOT sufficient on its own: the Pi UX must let the user naturally continue scrolling/paging through earlier in-session history. This must be proven end-to-end in guarded dogfood and oracle tests; logical reachability alone must never be reported as satisfying this criterion.
2. **Image policy resolved (corrected verdict, spike finding 8):** preserve Pi's native image path on **positively identified direct terminals**. The stable-ID / `C=1` / delete-by-ID (`a=d,d=I`) lifecycle is specifically the **Kitty-protocol** discipline (Kitty/Ghostty/WezTerm); **iTerm2** retains Pi's existing native iTerm2 protocol and row-reservation discipline but does not share Kitty's ID/delete mechanics. Under tmux/screen, keep Pi v1's current behavior (`images: null` → textual placeholder fallback; no cell-size query or blocking under tmux). **No Unicode-placeholder (Amp-style) spike or runtime path in Phase B.**

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

Presenter owns physical band origin, previous band height, hardware cursor, synchronized-update wrapping, shrink-row clearing, and terminal cleanup. Normal commits CUP to band top and emit each line once so the band is pushed downward atomically. Height changes repaint the full bounded band and clear vacated rows, while preserving v1's Termux height-change behavior as an explicit terminal-capability policy rather than an implicit special case. A focused visible caret produces the frame's sole caret CUP; a no-focus or hidden-cursor frame parks the cursor at the configured safe location and applies the matching DECTCEM policy.

Image commits follow decision 0.2: on positively identified direct terminals (Kitty protocol for Kitty/Ghostty/WezTerm, iTerm2 protocol for iTerm), committed history images use Pi v1's native lifecycle — Kitty-protocol terminals: stable per-component ID, `C=1`, graphics-only first row, reserved rows accounted before any subsequent write, delete-by-ID before redraw/replay; iTerm2: Pi's existing protocol and row reservation without Kitty ID/delete mechanics. Under tmux/screen the capability record reports `images: null` and blocks degrade to the existing textual placeholder (`[image: name (WxH)]`), matching current Pi.

First-image cell-size gate (**image-layout epoch/barrier**, timeout-bounded): **no native image commit may enter the Ledger before the cell-size response (`CSI 16 t` → `CSI 6;h;w t`) has been consumed or a declared fallback has been frozen** — an image committed at the 9×18 default would be permanently mis-sized in scrollback (v1 tolerates the race only because it repaints everything). UI and input stay live while waiting; reservation and encoding must use the same frozen dimensions; image-bearing blocks stay in the Band until dimensions settle. The response parser must handle a fragmented or coalesced response (`response + key` in one read), consuming only the response bytes and forwarding residual input. A late or different response after native placement must not silently rewrite committed geometry: either ignore it until the next explicit re-commit, or bump the image-layout epoch, delete prior Kitty IDs, and re-commit.

Image replay lifecycle: `2J/H/3J` removes placements visually without freeing Kitty image data — before replay/replacement, explicitly delete retained IDs (`a=d,d=I`), then reserve rows before re-emitting. Retain the image model/data for replay without a second unbounded copy in the TUI. Band-image unmount and epoch cancellation also delete owned IDs.

Terminal-safety invariant: ordinary Ledger/Band content is typed/structured and must be unable to inject CR/LF or terminal control sequences; only privileged image/control serialization may emit escapes. If a frame writes the final column, hold DECAWM off for the complete self-contained frame and restore it on every normal/error/signal exit; otherwise preserve the spike's final-cell margin. Tests must cover exact-width lines and wide graphemes at the right edge.

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
- terminal handback after Ctrl+Z suspend/resume (SIGCONT), where interleaved shell output has corrupted the primary screen below committed content;
- explicit frontier invariant violation requiring an edit replay.

Alt-screen returns (external `$EDITOR`, extension editor) are NOT re-commit triggers: primary-screen scrollback survives the alt screen, so a Band repaint suffices.

Not triggers:

- sequential status replacement;
- streaming chunks or tool-line appends;
- spinner/loader ticks;
- editor, footer, widget, overlay, or height-only band updates;
- ordinary block finalization.

Re-commit clears via `2J/H/3J`, replays logical blocks from the tail up to `maxReplayLines`, emits the earlier-history marker when capped, chunks work across frames, keeps the band coherent, and cancels/restarts on a newer width/theme epoch. Per decision 0.1 this is the accepted semantics: pre-session terminal history may be destroyed by `3J`, and the binding invariant is that **Pi-session history remains scrollable after every re-commit** — the scrollback-integrity oracle must assert the replayed tail (with marker when capped) is present and duplicate-free in scrollback after resize.

Full-history browsability affordance (required by decision 0.1's binding acceptance): terminal emulators cap their own scrollback, so even uncapped replay cannot guarantee full-session browsability. Phase B must provide an in-Pi affordance to browse the complete session history — e.g. an alt-screen history viewer/pager backed by the Ledger's full logical history, reflowed at the current width — reachable via a discoverable keybinding, with the earlier-history marker line advertising it. Survey and prefer reusing existing v1 overlay/viewer machinery before building new UI. The affordance must reach history beyond both the replay cap and the emulator's native scrollback limit, and must not disturb primary-screen scrollback (alt screen only).

Chunked replay and cancellation discipline (Phase-0 audit deltas; binding):

- Chunk only at **complete ledger-row/block + frame transaction boundaries**, never arbitrary byte offsets. Every chunk-frame independently closes synchronized-update mode, paints a coherent Band, places exactly one caret, and restores required terminal modes. (The spike's byte-chunk transport stress was a final-state test, not a cancellation strategy — cancelling mid-CSI/OSC/Kitty sequence can strand the parser or sync mode.)
- Once a frame write is dispatched, it must finish. Epoch cancellation drops only not-yet-dispatched frames. Output is serialized; after an in-flight old-epoch frame drains, the new epoch's first physical transaction is `2J/H/3J` + replay. Guard the epoch both before enqueue/compute completion and again at dispatch, so a late old job can never write after the new clear.
- Snapshot a **replay watermark** (logical Ledger revision/frontier) per epoch. Select the capped tail at current width, emit retained rows oldest→newest with the marker exactly once at the head, and hold post-watermark commits logically pending until replay reaches the watermark, then drain them normally. Cancellation discards physical work only — never Ledger state — and restarts from the latest logical snapshot.
- The replay cap must never split a multi-row semantic block — in particular an image placement plus its reserved rows. Include or omit such blocks atomically and adjust the omission count/marker accordingly.

## 7. Compatibility layers

- `LegacyStripAdapter`: cache and parse ANSI strings to spans only when a v1 component invalidates; measure/paint within assigned region; clip with a metric rather than throw.
- `LegacyBlockRendererAdapter`: pure render call plus ANSI-to-span parse for message/tool renderers.
- `EditorStrip`: new `TextModel`/`TextLayout` path; legacy editor adapter derives its caret from `CURSOR_MARKER` only at the boundary.
- Preserve input listener ordering, focus restore, overlays, custom footer/header/editor, widgets, `ctx.ui.*`, and existing keybinding indirection.
- **Type-level constraint:** extension factory callbacks (`setWidget`, `setFooter`, `setHeader`, `custom`, `setEditorComponent`) receive the concrete `TUI` class from `@earendil-works/pi-tui`, not an interface. The v2 compatibility object must type-check and behave as `TUI` (a subclass, or the live TUI object backed by v2 internals) — a narrow structural facade is insufficient for wild extensions.

## 8. Verification and commit sequence

1. v2 exports + CLI/env selection tests; prove flag-off v1 snapshots unchanged.
2. ANSI serializer, Ledger commit queue, and Presenter deterministic unit tests.
3. Band host composition, dirty repaint, caret uniqueness, overlay clipping golden tests.
4. transcript adapters and call-site hooks with faux-provider streaming/tool/bash tests.
5. re-commit job, replay cap, cancellation, and scrollback-integrity oracle.
6. legacy adapters against existing component/editor tests, plus an explicit extension tranche exercising the `ctx.ui.*` facade end-to-end (children, focus, overlays, render invalidation, terminal access, custom header/footer/editor, and widget lifecycles).
7. full `npm run check`, focused tests, `./test.sh`, tmux/xterm protocol runs, then guarded `PI_TUI=v2` interactive smoke; v1 remains default throughout.
8. A/B proof against v1 (QA oracle/tape harness from `test/tui-v2-qa-evidence`), guarded dogfood, and independent exact-head review before any merge request. Dogfood/oracle evidence MUST include the full-session history browsability proof of §0.1/§6: after resize with a capped replay, browse from the live Band back to the oldest session line entirely within Pi. The v1 default and the public/default switch remain frozen; no merge/push/publish without broker-held exact-head evidence and explicit gate acknowledgment.

# Alternate-Screen Layout System Plan

## Purpose

Implement a constrained layout system for `TuiAltScreen` and use it to keep the coding-agent transcript scrollable while the pending/status/widget/editor/footer area remains fixed at the bottom.

This document is an implementation handoff. It records the decisions made during design discussion and should be treated as the intended scope unless implementation findings require revisiting a decision.

## Core decisions

1. The constrained layout system is an alternate-screen feature.
2. `TuiMainScreen` keeps its existing terminal-scrollback rendering model.
3. Interactive mode uses two different compositions, but shares the same component instances and behavior.
4. The public layout primitives are initially:
   - `VStack`
   - `HStack`
   - `ScrollView`
   - existing overlays
5. The frame-specific layout tree is internal. API users construct a component tree and never manipulate layout boxes, rectangles, hit-test nodes, or scroll ancestry.
6. Rebuild the internal layout tree on each requested render. Do not rebuild component state.
7. Rely on existing leaf render caches, especially `Markdown`, `Text`, `Image`, and `Box`. Do not introduce a second framework-level render cache initially.
8. `Editor` does not currently cache its rendered lines, but it is small and active; this is not expected to be the dominant cost.
9. Keep `interactive-mode.ts` changes declarative and minimal. Layout, clipping, scrolling, hit testing, and event routing belong in `packages/tui`.
10. Mouse wheel support is an enhancement. Configurable keyboard scrolling must always remain available.

## Why main-screen and alternate-screen layouts differ

The terminal owns scrolling in main-screen mode. The application cannot reliably provide:

- sticky rows
- independently scrollable nested regions
- full-height side-by-side panes
- reliable mouse hit testing for content moved into terminal scrollback
- arbitrary repainting of off-screen regions without replaying or clearing scrollback

Therefore, do not pretend the same constrained viewport semantics exist in `TuiMainScreen`.

Main-screen interactive mode remains a vertically rendered document:

```text
header
loaded resources
chat
pending messages
status
widgets above
editor / replacement UI
widgets below
footer
```

Alternate-screen interactive mode becomes:

```text
┌─────────────────────────────────────────────┐
│ scrollable transcript                       │
│                                             │
│ header                                      │
│ loaded resources                            │
│ chat/messages/tool output                   │
│                                             │
├─────────────────────────────────────────────┤
│ pending messages                            │
│ working/retry/compaction status             │
│ widgets above editor                        │
│ editor or temporary replacement UI          │
│ widgets below editor                        │
│ footer                                      │
└─────────────────────────────────────────────┘
```

Pending messages and status belong in the fixed region. Hiding active queue/working state while the user reads older output would be surprising.

## Goals

### Required for the first implementation

- Constrained root layout in `TuiAltScreen`.
- Vertical and horizontal stack layout.
- Vertical scrolling with follow-end behavior.
- Sticky coding-agent dock.
- Existing mouse-wheel and keyboard transcript scrolling.
- Wheel routing based on the region under the pointer.
- Scroll chaining for nested scroll views.
- Existing overlay rendering must continue to work.
- Existing cursor positioning and IME support must continue to work.
- Existing hyperlink clicking and mouse text selection must continue to work.
- Existing Kitty image behavior must not regress for the transcript use case.
- `TuiMainScreen` behavior and output order must remain unchanged.
- Leaving alt mode must still print a complete logical final document.

### Future uses enabled by the design

- Wide-terminal sidebars.
- Independently scrollable transcript and sidebar.
- Sticky top regions.
- Layout-aware overlays.
- Scrollbars and unread-line indicators.
- Transcript virtualization.

## Non-goals for the first implementation

- CSS-compatible flexbox.
- Grid layout.
- Wrapped flex rows.
- Arbitrary absolute positioning; overlays already cover this need.
- Percentage sizing unless it falls out naturally from existing size utilities.
- Virtualized transcript rendering.
- Incremental layout-tree mutation.
- A public API for custom components to create or mutate internal layout nodes.
- Reworking every existing component to understand height constraints.
- Giving main-screen mode fake sticky or nested-scroll semantics.

## Public API

### Stack entries

Use one axis-neutral entry type for both vertical and horizontal stacks.

```ts
export interface StackEntryOptions {
	/** Initial size on the stack's main axis. Defaults to "auto". */
	basis?: number | "auto";
	/** Share of positive remaining space. Defaults to 0. */
	grow?: number;
	/** Relative willingness to shrink when content overflows. Defaults to 1. */
	shrink?: number;
	/** Minimum allocated size on the main axis. Defaults to 0. */
	minSize?: number;
	/** Maximum allocated size on the main axis. */
	maxSize?: number;
	/** Conditionally omit this entry for a viewport size. */
	visible?: (viewport: { width: number; height: number }) => boolean;
}

export interface StackEntry extends StackEntryOptions {
	component: Component;
}

export type StackChild = Component | StackEntry;

export interface StackOptions {
	gap?: number;
	align?: "stretch" | "start" | "center" | "end";
}
```

Use explicit fields in implementations. Do not use TypeScript parameter properties because root-configured source must remain erasable in Node strip-only mode.

### `VStack`

```ts
export class VStack implements Component {
	constructor(children?: StackChild[], options?: StackOptions);

	addChild(component: Component, options?: StackEntryOptions): void;
	removeChild(component: Component): void;
	clear(): void;
	invalidate(): void;
	render(width: number): string[];
}
```

Behavior:

- Public `render(width)` provides an unbounded-height rendering for compatibility and debugging.
- Constrained behavior is invoked internally by `TuiAltScreen` through the internal layout engine.
- Children are arranged from top to bottom.
- `gap` rows appear only between visible children.
- The cross axis defaults to `stretch`.

### `HStack`

```ts
export class HStack implements Component {
	constructor(children?: StackChild[], options?: StackOptions);

	addChild(component: Component, options?: StackEntryOptions): void;
	removeChild(component: Component): void;
	clear(): void;
	invalidate(): void;
	render(width: number): string[];
}
```

Behavior:

- Children are arranged from left to right.
- Child widths are allocated from `basis`, `grow`, `shrink`, `minSize`, and `maxSize`.
- Shorter children are padded according to `align`.
- Compose ANSI lines using existing ANSI-aware slicing/compositing utilities. Never use plain string length or raw substring for terminal columns.
- Initial image support only needs to preserve current vertical transcript behavior. See the image section for horizontal limitations.

### `ScrollView`

```ts
export interface ScrollViewOptions {
	axis?: "vertical";
	/** Follow content growth while positioned at the end. */
	follow?: "none" | "end";
	/** Designate this view as the fallback target for global scroll actions. */
	primary?: boolean;
	/** Bubble unused wheel delta to an outer scroll view. */
	overscroll?: "chain" | "contain";
	/** Reserved for a later visible scrollbar implementation. */
	scrollbar?: "hidden" | "auto" | "always";
}

export class ScrollView implements Component {
	constructor(component: Component, options?: ScrollViewOptions);

	get scrollTop(): number;
	get isFollowingEnd(): boolean;

	scrollBy(lines: number): number;
	scrollToStart(): void;
	scrollToEnd(): void;
	invalidate(): void;
	render(width: number): string[];
}
```

`scrollBy()` returns unused delta so nested scrolling can chain:

```ts
const remaining = scrollView.scrollBy(delta);
```

Examples:

- Requested `+3`, moved `+3`: return `0`.
- Requested `+3`, only one row remained: move one and return `+2`.
- Requested `-3`, already at the top: return `-3`.

Behavior:

- In constrained layout, the child is measured/rendered at unbounded height and clipped to the allocated viewport.
- In public unbounded `render(width)`, render the complete child. This is needed for final-document output and debugging, not to emulate viewport behavior in main-screen mode.
- `follow: "end"` behaves like current `TuiAltScreen.stickToBottom`:
  - start in follow mode
  - content growth keeps the view at the end
  - scrolling away from the end disables follow mode
  - reaching or explicitly scrolling to the end enables follow mode
- Scrolling must request a render.
- Preserve `scrollTop` when viewport height changes, unless following the end.

### Viewport capability

Do not add constrained layout methods to every `TUI` implementation as though main-screen mode supports them.

Add an explicit capability:

```ts
export interface ViewportTUI extends TUI {
	setLayoutRoot(component: Component | undefined): void;
}

export function isViewportTUI(tui: TUI): tui is ViewportTUI;
```

`TuiAltScreen` implements `ViewportTUI`. `TuiMainScreen` does not.

The type guard should test a stable capability, not rely on application-level `instanceof`. The concrete implementation may use a symbol or method-presence check.

`TuiAltScreen` behavior when no explicit layout root is set must remain compatible with current users of `addChild()`. Treat its existing children as an implicit vertically stacked document in an implicit primary `ScrollView`.

## Internal layout API

Do not export these types from `packages/tui/src/index.ts`.

Suggested module: `packages/tui/src/layout.ts`.

```ts
interface LayoutConstraints {
	width: number;
	/** Undefined means unbounded height. */
	height: number | undefined;
}

interface LayoutRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface LayoutBox {
	component: Component;
	rect: LayoutRect;
	clip: LayoutRect;
	children: LayoutBox[];
	parent?: LayoutBox;
	/** Leaf-rendered lines. Keep the returned array by reference. */
	lines?: readonly string[];
	/** Present when this box represents a ScrollView viewport. */
	scrollView?: ScrollView;
	/** Z/layer ordering for hit testing when needed. */
	layer: number;
}

interface LayoutFrame {
	root: LayoutBox;
	width: number;
	height: number;
	lines: string[];
	primaryScrollView?: ScrollView;
}
```

The exact shape may change during implementation, but it must support:

- painting visible terminal rows
- clipping nested children
- hit testing from terminal coordinates
- translating to component-local coordinates
- walking ancestors
- identifying scroll ancestors
- locating cursor markers
- retaining enough mapping for selection and hyperlinks

### Component tree versus layout tree

The public component tree is long-lived and stateful:

```text
VStack
├─ ScrollView
│  └─ chat container
└─ dock VStack
   ├─ editor container
   └─ footer container
```

The internal layout tree is a transient frame snapshot:

```text
box root       rect 0,0,120,40
├─ scroll box  rect 0,0,120,31 clip 0,0,120,31
│  └─ content  rect 0,-85,120,116
└─ dock box    rect 0,31,120,9
```

Rebuild the layout tree for every requested frame. Replace the committed frame atomically after successful painting so input is always routed against the last displayed geometry.

Do not mutate component state merely to generate layout geometry, except for intentional `ScrollView` clamping/follow state.

## Rendering and caching strategy

### Rebuild geometry, reuse leaf lines

A fresh frame performs:

```ts
const nextLayout = layout(root, terminalBounds);
const nextScreen = paint(nextLayout);
writeScreenDiff(previousScreen, nextScreen);
currentLayout = nextLayout;
```

For a leaf component:

```ts
const lines = component.render(width);
```

Keep `lines` by reference in the layout box. Most expensive leaves already cache by content and width:

- `Markdown` caches text, width, and rendered lines.
- `Text` caches text, width, and rendered lines.
- `Image` caches width and rendered lines.
- `Box` caches based on width/background/child output.
- several coding-agent animation and tool components have their own caches.

`Editor`, `Input`, selectors, footer, and some small leaves recompute. This is acceptable initially.

Do not add a separate `WeakMap<Component, RenderCache>` in the layout engine until profiling shows a need. A second cache risks becoming stale because existing components own their invalidation semantics.

### Avoid unnecessary flattening where practical

The first correct implementation may call existing `Container.render(width)`, which flattens child arrays. Markdown parsing/highlighting will still be cached, so this is acceptable for the initial implementation.

If easy and safe, optimize exact base `Container` instances as structural vertical stacks so layout can retain child line arrays and heights without flattening the whole transcript. Do not bypass overridden rendering in `Container` subclasses such as message/tool components. Treat subclasses as leaves unless they explicitly opt into internal structural layout.

Do not make this optimization a prerequisite for correctness.

### No render means no layout

Only rebuild a layout frame after `requestRender()` schedules a render. There is no independent layout loop.

## Stack layout algorithm

The implementation should use one shared stack allocator parameterized by axis.

### Visibility

1. Evaluate `visible` against the terminal viewport dimensions.
2. Remove invisible entries before calculating gaps or size distribution.

### Intrinsic sizes

- `basis: "auto"` uses the child's intrinsic size on the main axis.
- Numeric `basis` uses the given cell count.
- Clamp basis to `minSize`/`maxSize`.
- For wrapped leaves, width allocation must happen before intrinsic height is known.
- `HStack` therefore allocates widths before measuring child heights.
- `VStack` renders/measures auto-height children at the allocated width before distributing remaining height.

### Positive remaining space

Distribute positive remaining space among entries with `grow > 0`, proportional to `grow`, respecting `maxSize`.

Use deterministic integer rounding. Allocate leftover cells in child order so layouts do not jitter frame to frame.

### Overflow

When total basis exceeds available size:

1. Compute shrinkable entries (`shrink > 0` and current size above `minSize`).
2. Distribute required shrink proportional to `shrink` and current basis, or another deterministic documented policy.
3. Repeat if an entry reaches `minSize` before overflow is resolved.
4. If constraints still cannot be satisfied, clip at the parent boundary.

A focused cursor must not disappear merely because a leaf is clipped. When clipping a leaf vertically and its lines contain `CURSOR_MARKER`, choose a visible line window containing the marker where possible.

### Initial interactive layout sizing

The transcript should be flexible and the dock should prefer intrinsic height:

```ts
new VStack([
	{
		component: transcriptScrollView,
		basis: 0,
		grow: 1,
		shrink: 1,
		minSize: 1,
	},
	{
		component: dock,
		basis: "auto",
		grow: 0,
		shrink: 1,
		minSize: 1,
	},
]);
```

The implementation must define sensible behavior for very small terminals and oversized custom widgets. Preferred priority:

1. Preserve at least one transcript row when terminal height permits.
2. Preserve the focused editor/selector cursor.
3. Preserve at least one footer row when possible.
4. Clip/truncate widgets and pending/status content before hiding the focused editor.

This may require coding-agent-specific stack entry `minSize`/`shrink` settings rather than adding domain-specific priority rules to generic TUI layout.

## Painting

### Frame surface

The layout engine may continue using ANSI strings per terminal row rather than introducing a full cell object model.

Painting must:

- create exactly `terminal.rows` base rows in constrained alt mode
- respect each box's rectangle and accumulated clip
- use ANSI-aware column slicing
- reset styles between independently painted regions
- preserve `CURSOR_MARKER` until cursor extraction
- compose horizontal children without style leakage
- produce lines no wider than terminal width

Reuse:

- `sliceByColumn()`
- `compositeTuiLine()`
- `visibleWidth()`
- existing line-reset normalization

### Vertical stacks

Paint each child at its allocated `y`. Skip children and line ranges that do not intersect the accumulated clip.

### Horizontal stacks

Paint each child at its allocated `x`. Pad short lines to the allocated width before composing adjacent children. Apply reset boundaries so one child's style or OSC 8 hyperlink does not leak into another.

### Scroll views

- Child content is laid out at its full natural height.
- The child's painted origin is translated by `-scrollTop`.
- Accumulate the scroll view's rectangle into the clip.
- Only paint child rows intersecting the viewport.
- Record the scroll box in the layout tree for hit testing and ancestor walking.

## Input and event routing

### Normalized mouse events

Keep terminal mouse parsing in `TuiAltScreen`, but convert parsed sequences into normalized events before routing:

```ts
interface TuiMouseEvent {
	type: "press" | "release" | "move" | "wheel";
	x: number;
	y: number;
	button: number;
	deltaX: number;
	deltaY: number;
}
```

The exact public visibility of this type is optional. The initial wheel router can remain internal.

### Hit testing

Hit test the committed layout frame, not the frame currently being constructed.

1. Reject boxes outside their clip.
2. Traverse higher layers/frontmost children first.
3. Return the deepest visible box containing the terminal coordinate.
4. Preserve the ancestor chain for event bubbling.

### Wheel routing

For a wheel event:

1. Hit test at the pointer.
2. Starting at the deepest box, walk toward the root.
3. Offer the delta to each encountered `ScrollView`.
4. If `overscroll` is `"chain"`, pass unused delta to the next scroll ancestor.
5. If `overscroll` is `"contain"`, stop even when delta remains.
6. If no hit ancestor consumes the delta, offer it to the frame's primary scroll view.
7. Consume recognized mouse sequences so raw mouse bytes never reach the editor.

Expected behavior:

- Wheel over transcript: scroll transcript.
- Wheel over a future sidebar: scroll sidebar.
- Wheel over a nested scroll view: scroll inner view, then chain at its boundary.
- Wheel over non-scrollable dock/footer: scroll primary transcript.
- Wheel interaction must not steal keyboard focus from the editor.

### Trackpads

Preserve current behavior of ignoring horizontal wheel events for a vertical-only scroll view. If an event contains both axes, consume only the supported vertical portion and document the policy.

### Mouse-disabled fallback

Do not depend on detecting mouse support. Terminals do not provide a sufficiently reliable universal capability signal.

Keyboard navigation is always available through existing configurable actions:

- `tui.altScreen.pageUp`
- `tui.altScreen.pageDown`
- `tui.altScreen.top`
- `tui.altScreen.bottom`

Route these actions to:

1. an explicitly active scroll region, if future multi-pane navigation sets one
2. otherwise the primary scroll view

For the first coding-agent layout there is only one scroll view, so the transcript is always the keyboard target.

If future layouts introduce multiple keyboard-selectable scroll regions, add configurable actions to `TUI_KEYBINDINGS`; never hardcode key checks.

## Focus and cursor behavior

- Existing `TUI.setFocus(component)` remains the public keyboard-focus API.
- Keyboard focus and wheel-scroll target are separate. Scrolling a sidebar must not move focus away from the editor unless explicitly requested.
- During paint, find `CURSOR_MARKER` in the final composited frame.
- Cursor row/column must include stack offsets, scroll translations, overlay offsets, and horizontal-pane offsets.
- Only show the hardware cursor according to existing `showHardwareCursor` behavior.
- Layout containment checks used by overlay focus restoration must understand layout roots and nested layout components.

## Selection and hyperlinks

The current alt renderer maps selection rows directly into one global logical document. That assumption no longer holds once fixed and horizontal regions exist.

For the first implementation, preserve visible-screen selection semantics:

- Anchor and focus begin from terminal-screen coordinates.
- Apply highlight against the current committed visible frame.
- Copy text from the selected visible rows/columns using ANSI-aware slicing and `stripTerminalSequences()`.
- Blank/padded areas contribute no text beyond required line separation.
- Continue snapping selection columns to grapheme boundaries.

If maintaining selection across frame changes is required, store enough source mapping in painted rows to translate screen rows into leaf line references. Do not map fixed dock rows to unrelated transcript rows.

Hyperlink clicking can continue reading OSC 8 metadata from the committed screen line at the clicked column. Ensure the final composed line, rather than an unshifted child line, is used.

Maintain current behavior:

- click without drag may call `openUrl`
- dragging does not activate a URL
- release after drag copies via OSC 52

## Images

The initial required image case is the existing vertically scrolling transcript.

Preserve:

- Kitty image metadata and reserved rows
- cropping when the top of a Kitty image is above the scroll viewport
- deletion/redraw when image-containing rows change
- iTerm2 fallback to text in alt mode

Horizontal composition of image protocol lines is not required to become fully general in the first implementation. Terminal image placements do not behave like ordinary ANSI text. Document and defensively handle the limitation:

- an image-bearing component in an `HStack` may be required to occupy the full row/width
- do not silently corrupt adjacent pane output
- add a focused test for whatever fallback policy is chosen

Do not regress existing vertical image tests.

## Overlays

Keep the current overlay stack and positioning API.

Initial integration:

1. Paint the base constrained layout into terminal-height lines.
2. Composite existing overlays over those lines using current overlay logic.
3. Extract the cursor from the final result.
4. Apply differential rendering.

Existing overlays are not required to become nested `ScrollView` layout roots in the first implementation. However, base-layout hit testing must not break overlay focus or input ownership.

A later phase can give each overlay its own constrained layout tree and include overlay boxes as higher hit-test layers.

## `TuiAltScreen` refactor

Suggested state after the change:

```ts
private layoutRoot?: Component;
private currentLayout?: LayoutFrame;
private implicitScrollView?: ScrollView;
```

Move these responsibilities out of `TuiAltScreen` global fields and into `ScrollView` where applicable:

- `scrollTop`
- `contentLineCount`
- `stickToBottom`

Compatibility getters/methods such as `viewportTop`, `isFollowingOutput`, `scrollBy()`, `scrollToTop()`, and `scrollToBottom()` may delegate to the primary/implicit scroll view so existing tests and consumers continue to work. Do not preserve backward compatibility if it materially complicates the implementation unless tests/public API indicate these methods are relied upon; check exports and usage before removal.

`doRender()` becomes conceptually:

```ts
const root = this.layoutRoot ?? this.getImplicitLegacyRoot();
const nextLayout = layoutConstrained(root, width, height);
let screen = paint(nextLayout);
screen = this.compositeOverlays(screen, width, height);
screen = this.applySelection(screen);
const cursor = this.extractCursorPosition(screen, height);
// Normalize, crop defensive overflow, diff, write.
this.currentLayout = nextLayout;
```

### Legacy implicit root

When callers only use `tui.addChild()`:

```text
implicit ScrollView(primary, follow=end)
└─ implicit vertical document of TuiAltScreen.children
```

This preserves the current standalone `TuiAltScreen` API and tests.

The implicit root must observe subsequent `addChild()`, `removeChild()`, and `clear()` mutations.

### Final document on stop

When leaving alt mode, render the explicit or implicit root with unbounded height:

- `ScrollView` emits its complete child rather than a clipped viewport.
- The coding-agent transcript appears first and the dock appears once after it.
- Do not print terminal-height padding rows.
- Strip cursor markers.
- Preserve existing line resets and image cleanup.

Do not use only the last visible frame as the exit document.

## Interactive-mode changes

File: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`

Changes should remain small.

### Add stable grouping containers

```ts
private documentContainer: Container;
private footerContainer: Container;
```

The existing component containers remain unchanged:

- `headerContainer`
- `loadedResourcesContainer`
- `chatContainer`
- `pendingMessagesContainer`
- `statusContainer`
- `widgetContainerAbove`
- `editorContainer`
- `widgetContainerBelow`

Build the transcript group once:

```ts
this.documentContainer.addChild(this.headerContainer);
this.documentContainer.addChild(this.loadedResourcesContainer);
this.documentContainer.addChild(this.chatContainer);
```

Build the footer slot once:

```ts
this.footerContainer.addChild(this.footer);
```

### Main-screen composition

Preserve exact current ordering:

```ts
this.ui.addChild(this.documentContainer);
this.ui.addChild(this.pendingMessagesContainer);
this.ui.addChild(this.statusContainer);
this.ui.addChild(this.widgetContainerAbove);
this.ui.addChild(this.editorContainer);
this.ui.addChild(this.widgetContainerBelow);
this.ui.addChild(this.footerContainer);
```

Because `documentContainer` is visually transparent, its three children render exactly where they do today.

### Alternate-screen composition

```ts
const transcript = new ScrollView(this.documentContainer, {
	follow: "end",
	primary: true,
	overscroll: "chain",
});

const dock = new VStack([
	{ component: this.pendingMessagesContainer, shrink: 1, minSize: 0 },
	{ component: this.statusContainer, shrink: 1, minSize: 0 },
	{ component: this.widgetContainerAbove, shrink: 1, minSize: 0 },
	{ component: this.editorContainer, shrink: 1, minSize: 3 },
	{ component: this.widgetContainerBelow, shrink: 1, minSize: 0 },
	{ component: this.footerContainer, shrink: 1, minSize: 1 },
]);

const root = new VStack([
	{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
	{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
]);

viewportTui.setLayoutRoot(root);
```

Use `isViewportTUI(this.ui)` for narrowing. Since `options.alt` selected the renderer, failure to obtain the capability is an internal programming error rather than a silent fallback.

### Custom footer replacement

Refactor `setExtensionFooter()` so it never removes/adds root TUI children:

```ts
this.footerContainer.clear();
this.footerContainer.addChild(this.customFooter ?? this.footer);
this.ui.requestRender();
```

Continue disposing replaced custom footers.

### Features that should require no logic changes

- message rendering
- streaming updates
- tool updates
- widget APIs
- editor replacement
- extension selectors/input/editor
- built-in selectors
- queue rendering
- status indicators
- focus changes
- overlays
- theme invalidation

These features mutate existing stable containers and should automatically appear in the correct layout.

### Existing alt-specific status workaround

Revisit this code:

```ts
if (hadActiveStatusIndicator && !this.options.alt && this.ui.getClearOnShrink()) {
	this.statusContainer.addChild(this.idleStatus);
}
```

The main-screen workaround should remain main-screen-only. Constrained alt layout should naturally clear released rows.

## Suggested files

Likely new files:

- `packages/tui/src/layout.ts` — internal constraints, boxes, layout, paint, hit testing
- `packages/tui/src/components/v-stack.ts`
- `packages/tui/src/components/h-stack.ts`
- `packages/tui/src/components/scroll-view.ts`

Likely modified files:

- `packages/tui/src/tui.ts`
- `packages/tui/src/tui-alt-screen.ts`
- `packages/tui/src/index.ts`
- `packages/tui/src/keybindings.ts` only if new configurable actions are required
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `packages/tui/test/tui-alt-screen.test.ts`
- new focused layout tests under `packages/tui/test/`
- `packages/coding-agent/test/interactive-tui.test.ts`
- `packages/tui/README.md`
- `packages/coding-agent/docs/usage.md`
- `packages/coding-agent/docs/keybindings.md` if keyboard behavior changes
- `packages/tui/CHANGELOG.md`
- `packages/coding-agent/CHANGELOG.md`

Do not modify released changelog sections. Add entries under the existing `## [Unreleased]` subsections.

## Test plan

### Stack allocation tests

Add focused unit tests for both axes:

- auto-sized children
- numeric basis
- positive grow distribution
- shrink distribution
- min/max clamping
- deterministic odd-cell rounding
- gaps only between visible children
- conditional visibility
- cross-axis alignment
- child output wider than allocation is clipped safely
- ANSI styles/hyperlinks do not leak between horizontal children
- CJK, emoji, and combining-character boundaries in horizontal clipping

### ScrollView tests

- initial `follow: "end"` position
- content growth while following
- manual upward scroll disables follow
- reaching bottom reenables follow
- explicit `scrollToEnd()` reenables follow
- viewport growth/shrink while following
- viewport growth/shrink while manually positioned
- `scrollBy()` returns unused positive/negative delta
- nested scroll chaining
- `overscroll: "contain"`
- child shorter than viewport
- empty child
- child width change
- cursor marker remains visible when focused content is clipped

### Layout frame tests

- generated rectangles for nested V/H stacks
- accumulated clipping
- hit testing returns deepest visible box
- clipped boxes are not hit-testable
- local coordinate translation
- layer ordering
- only visible rows are painted from a scroll view
- each frame uses fresh geometry after resize/content change
- cached leaf line arrays are accepted by reference and not mutated

### Alternate-screen renderer tests

Extend `packages/tui/test/tui-alt-screen.test.ts`:

- legacy `addChild()` path still behaves as current implicit scrolling
- explicit layout root renders terminal-height frame
- fixed dock remains unchanged while transcript scrolls
- transcript viewport height accounts for dock height
- dock growth/shrink while following
- dock growth/shrink while manually scrolled
- Shift+PageUp/Down targets primary ScrollView
- Ctrl+Home/End targets primary ScrollView
- wheel over transcript scrolls transcript
- wheel over non-scrollable dock falls back to primary transcript
- nested scroll consumes first and bubbles unused delta
- mouse-disabled mode still supports keyboard scrolling
- cursor row is correct inside dock
- cursor row is correct inside scrolled content
- overlay compositing remains screen-relative
- overlay focus behavior remains correct
- OSC 8 click remains correct after horizontal/vertical offsets
- selection/copy works in transcript
- selection/copy works in dock without mapping to transcript rows
- terminal resize recomputes layout
- oversized dock does not lose the focused cursor
- stopping prints complete transcript plus dock exactly once
- no terminal padding rows in final output

Retain and pass all existing image tests:

- Kitty cropping at viewport top
- image deletion/redraw
- iTerm2 fallback
- no stale image placements

### Main-screen regression tests

- existing main-screen tests pass unchanged
- interactive main-screen child order/rendered output is unchanged
- custom footer remains at the bottom in flow
- no layout root or application scrolling is installed in main-screen mode

### Coding-agent integration tests

In `packages/coding-agent/test/interactive-tui.test.ts` or a focused new test:

- renderer capability is exposed only for alt mode
- main mode mounts flow composition
- alt mode mounts transcript ScrollView plus dock
- pending/status/widgets/editor/footer are in the dock
- custom footer replacement updates `footerContainer`
- editor replacement does not rebuild the root layout
- widget updates do not rebuild the public component composition

Prefer inspecting component composition or using `VirtualTerminal`; do not use real provider APIs.

## Verification commands

After implementation changes:

1. Run each modified/new focused test from the relevant package root using the repository-prescribed Vitest invocation.
2. Run `npm run check` from the repository root and fix all errors, warnings, and infos.
3. Do not run `npm test` or the full Vitest suite.
4. Optionally use the repository's `./test.sh` for all non-e2e tests if broader validation is warranted.
5. Manually exercise alt mode in tmux using the procedure in `AGENTS.md`:
   - long transcript
   - wheel/trackpad scrolling
   - Shift+PageUp/Down
   - streaming while manually scrolled
   - return to bottom/follow
   - multiline editor
   - autocomplete open
   - settings/model/tree selectors replacing editor
   - extension widget above and below editor
   - custom footer
   - terminal resize
   - hyperlink click
   - mouse selection/copy
   - Kitty image where available
6. Manually smoke-test main-screen mode to ensure terminal scrollback behavior is unchanged.

## Recommended implementation order

1. Add stack allocation unit tests and shared axis allocator.
2. Implement `VStack` unbounded rendering and constrained internal layout.
3. Implement `HStack` with ANSI-safe composition.
4. Implement `ScrollView` state and unit tests independent of terminal ANSI output.
5. Implement internal layout frame generation and painting.
6. Add hit testing and scroll-ancestor traversal.
7. Integrate explicit and implicit layout roots into `TuiAltScreen`.
8. Move current global alt scrolling behavior behind the implicit primary `ScrollView` compatibility path.
9. Preserve selection, hyperlinks, cursor, overlays, and image handling one subsystem at a time, running existing tests after each step.
10. Add coding-agent grouping containers and the two small composition branches.
11. Refactor custom footer replacement to use `footerContainer`.
12. Add integration tests, docs, and changelog entries.
13. Run focused tests and `npm run check`.
14. Perform tmux/manual smoke tests in both modes.

## Acceptance criteria

The implementation is complete when:

- Main-screen mode behaves as before and preserves terminal scrollback.
- Alt-screen mode has a scrollable transcript and fixed bottom dock.
- Streaming follows the transcript end only while follow mode is active.
- Manual scrolling remains stable while new output arrives.
- Mouse wheel routes to the appropriate scroll view and chains at boundaries.
- Keyboard navigation works with mouse disabled.
- Editor/selector focus and IME cursor placement remain correct.
- Widgets and custom footers remain extension-compatible and fixed in alt mode.
- Hyperlinks, selection, overlays, and Kitty transcript images do not regress.
- Leaving alt mode prints the complete logical document once.
- Layout boxes are internal and rebuilt per requested frame.
- Expensive leaf rendering continues to use existing component caches.
- All focused tests and `npm run check` pass.

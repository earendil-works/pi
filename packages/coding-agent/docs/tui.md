# Terminal UI

`@earendil-works/pi-tui` provides the terminal component system used by Pi. Extensions use it when built-in dialogs, notifications, status text, and widgets are not enough for the interaction they need.

Start with `ctx.ui` methods from an [extension](extensions.md#interact-with-the-user). Build a custom component only when the UI needs its own rendering, keyboard or mouse input, focus, layout, or lifecycle.

## Choose an integration point

| Need | Use |
|---|---|
| Select, confirm, input, or multi-line editor | `ctx.ui.select()`, `confirm()`, `input()`, or `editor()` |
| Non-blocking feedback | `ctx.ui.notify()` or `setStatus()` |
| Persistent content near the editor | `ctx.ui.setWidget()` |
| Replace the header, footer, or editor | The corresponding `ctx.ui` component factory |
| Temporary interactive screen or overlay | `ctx.ui.custom()` |
| Custom rendering for a tool or session entry | An extension renderer |

These APIs receive Pi’s active theme and keybindings where needed. Do not create a second terminal renderer inside an extension.

## Understand the component model

A component renders an array of terminal lines for an available width. It can optionally handle keyboard and mouse input, and it must invalidate cached output when its state or theme-dependent content changes.

Every rendered line must fit within the supplied width. Measure visible terminal columns rather than string length because ANSI escapes, wide characters, emoji, and combining characters change display width.

Use `visibleWidth()`, `truncateToWidth()`, `sliceByColumn()`, and `wrapTextWithAnsi()` instead of implementing terminal-width handling yourself. Pi resets styling and hyperlinks after every line, so reapply styles on each rendered line.

After changing component state, invalidate the affected component and call the injected `tui.requestRender()`. The TUI coalesces render requests and updates the terminal.

## Compose built-in components

The package includes components for common layouts and controls:

- `Text`, `Markdown`, `Image`, and `TruncatedText` render content.
- `Container`, `VStack`, `HStack`, `Box`, and `Spacer` compose layouts.
- `Input` and `Editor` accept text.
- `SelectList` and `SettingsList` implement searchable selection and settings flows.
- `ScrollView` provides a bounded scrollable viewport.
- `Loader` and `CancellableLoader` report ongoing work.
- `MouseRegion` adds pointer behavior around another component.

Prefer these components over rebuilding selection, scrolling, text editing, or width handling. The extension examples show how to combine them with Pi’s borders and themes.

## Handle keyboard input and focus

Use `matchesKey()` and `Key` for terminal keyboard input. The parser accounts for supported terminal protocols and key modifiers. Extension components should use the injected `KeybindingsManager` for configurable application actions.

A component that displays a text cursor should implement `Focusable` and place `CURSOR_MARKER` immediately before its visual cursor. The TUI uses that marker to position the hardware cursor for input method editors.

Containers that wrap an `Input` or `Editor` must propagate their `focused` state to that child. Without propagation, Chinese, Japanese, Korean, and other IME candidate windows can appear at the wrong screen position.

Extend Pi’s `CustomEditor` when replacing the main editor. It preserves application shortcuts and agent controls.

Forward keys your editor does not own to the base implementation, and restore the default by clearing the custom editor factory.

## Handle mouse input

Fullscreen mode routes normalized mouse events to components. A handler can mark an event handled, capture a drag sequence, request focus, or request a render.

Unhandled wheel events scroll the nearest `ScrollView`. Unhandled primary-button drags remain available for transcript selection. OSC 8 links take precedence over enclosing click regions.

Regular mode leaves mouse input to the terminal because the terminal owns scrollback. Design every interaction with a keyboard path even when fullscreen mouse input is available.

## Use custom screens and overlays

`ctx.ui.custom()` temporarily gives one component control of the interactive area and resolves when that component calls the supplied completion callback.

Pass `overlay: true` to draw above existing content. Overlay options control size, anchors, offsets, margins, and responsive visibility. An overlay handle can change focus, toggle visibility, or permanently close the overlay.

Focused overlays retain input ownership across ordinary renders. If another component should receive input while an overlay remains visible, explicitly release or redirect focus through the handle.

Treat each custom component instance as belonging to one interaction. Create a new instance when starting that interaction again.

Do not rely on `OverlayHandle.hide()` to dispose the component. Release component-owned resources before or alongside a direct handle removal, and keep cleanup idempotent.

See [`overlay-qa-tests.ts`](../examples/extensions/overlay-qa-tests.ts) for positioning, stacking, focus, responsive visibility, and animation behavior.

## Apply themes correctly

Use the theme passed to the extension or component callback. Theme helpers produce ANSI-styled strings for semantic colors such as accent, muted text, success, warnings, errors, tool output, and Markdown.

Do not permanently store strings with theme colors unless `invalidate()` rebuilds them. A theme change clears render caches, but it cannot remove old ANSI colors embedded in application state.

Theme callbacks evaluated during rendering do not need special rebuilding. Stateless components can also calculate themed output on every render.

Use [Themes](themes.md) to create terminal palettes. Use Pi’s `getMarkdownTheme()` when rendering Markdown that should match the active application theme.

## Keep rendering responsive

Rendering runs on the interactive path. Cache expensive layout and highlighting work by width and content, then clear that cache from `invalidate()`.

Keep the default view compact and reveal detail through expansion or a dedicated screen. For custom tool rendering, handle partial results and reuse the previous component when it can be updated safely.

Use `PI_TUI_WRITE_LOG` to capture the raw ANSI stream when diagnosing rendering problems. Test narrow widths, wide characters, resize events, theme changes, focus transitions, and both regular and fullscreen modes.

## Examples and source

The checked extension examples cover the main patterns:

- [`preset.ts`](../examples/extensions/preset.ts) and [`tools.ts`](../examples/extensions/tools.ts) use selection and settings lists.
- [`qna.ts`](../examples/extensions/qna.ts) uses cancellable asynchronous UI.
- [`modal-editor.ts`](../examples/extensions/modal-editor.ts) replaces the editor.
- [`custom-footer.ts`](../examples/extensions/custom-footer.ts) replaces the footer.
- [`widget-placement.ts`](../examples/extensions/widget-placement.ts) places persistent content around the editor.
- [`doom-overlay/`](../examples/extensions/doom-overlay/) demonstrates a continuously rendered overlay.

The public exports are defined in [`packages/tui/src/index.ts`](https://github.com/earendil-works/pi/blob/main/packages/tui/src/index.ts). See [Extensions](extensions.md) for extension lifecycle, state, tools, events, and mode behavior.

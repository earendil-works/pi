# Changelog

## [Unreleased]

## [0.65.0] - 2026-04-03

### Fixed

- Fixed markdown H1 headings ending with inline code from leaking underline styling into trailing line padding
- Fixed slash-command argument autocomplete to await async `getArgumentCompletions()` results and ignore invalid return values, preventing crashes when extension commands provide asynchronous completions ([#2719](https://github.com/badlogic/pi-mono/issues/2719))
- Fixed non-capturing overlay padding from inflating scrollback and corrupting the viewport on terminal widen ([#2758](https://github.com/badlogic/pi-mono/pull/2758) by [@dotBeeps](https://github.com/dotBeeps))

## [0.64.0] - 2026-03-29

### Fixed

- Fixed TUI cell size response handling to consume only exact `CSI 6 ; height ; width t` replies, so bare `Escape` is no longer swallowed while waiting for terminal image metadata ([#2661](https://github.com/badlogic/pi-mono/issues/2661))
- Fixed Kitty keyboard protocol keypad functional keys to normalize to logical digits, symbols, and navigation keys, so numpad input in terminals such as iTerm2 no longer inserts Private Use Area gibberish or gets ignored ([#2650](https://github.com/badlogic/pi-mono/issues/2650))

## [0.63.2] - 2026-03-29

## [0.63.1] - 2026-03-27

## [0.63.0] - 2026-03-27

### Added

- Added support for `PI_TUI_WRITE_LOG` directory paths, creating a unique log file (`tui-<timestamp>-<pid>.log`) per instance for easier debugging of multiple pi sessions ([#2508](https://github.com/badlogic/pi-mono/pull/2508) by [@mrexodia](https://github.com/mrexodia))

### Fixed

- Fixed blockquote text color breaking after inline links (and other inline elements) due to missing style restoration prefix
- Fixed slash-command Tab completion from immediately chaining into argument autocomplete after completing the command name, restoring flows like `/model` that submit into a selector dialog ([#2577](https://github.com/badlogic/pi-mono/issues/2577))
- Fixed stale content and incorrect viewport tracking after TUI content shrinks or transient components inflate the working area ([#2126](https://github.com/badlogic/pi-mono/pull/2126) by [@Perlence](https://github.com/Perlence))
- Fixed `@` autocomplete to debounce editor-triggered searches, cancel in-flight `fd` lookups cleanly, and keep suggestions visible while results refresh ([#1278](https://github.com/badlogic/pi-mono/issues/1278))


## [0.62.0] - 2026-03-23

### Fixed

- Fixed `truncateToWidth()` to stream truncation for very large strings, keep contiguous prefixes, and always terminate truncated SGR styling safely ([#2447](https://github.com/badlogic/pi-mono/issues/2447))
- Fixed markdown heading styling being lost after inline code spans within headings

## [0.61.1] - 2026-03-20

### Fixed

- Fixed shared keybinding resolution to stop user overrides from evicting unrelated default shortcuts such as selector confirm and editor cursor keys ([#2455](https://github.com/badlogic/pi-mono/issues/2455))
- Fixed Termux software keyboard height changes from forcing full-screen redraws and replaying TUI history on every toggle ([#2467](https://github.com/badlogic/pi-mono/issues/2467))

## [0.61.0] - 2026-03-20

### Breaking Changes

- Replaced the editor-only keybinding store with a single global keybindings manager in `@mariozechner/pi-tui`. TUI keybinding ids are now namespaced: `cursorUp` -> `tui.editor.cursorUp`, `cursorDown` -> `tui.editor.cursorDown`, `cursorLeft` -> `tui.editor.cursorLeft`, `cursorRight` -> `tui.editor.cursorRight`, `cursorWordLeft` -> `tui.editor.cursorWordLeft`, `cursorWordRight` -> `tui.editor.cursorWordRight`, `cursorLineStart` -> `tui.editor.cursorLineStart`, `cursorLineEnd` -> `tui.editor.cursorLineEnd`, `jumpForward` -> `tui.editor.jumpForward`, `jumpBackward` -> `tui.editor.jumpBackward`, `pageUp` -> `tui.editor.pageUp`, `pageDown` -> `tui.editor.pageDown`, `deleteCharBackward` -> `tui.editor.deleteCharBackward`, `deleteCharForward` -> `tui.editor.deleteCharForward`, `deleteWordBackward` -> `tui.editor.deleteWordBackward`, `deleteWordForward` -> `tui.editor.deleteWordForward`, `deleteToLineStart` -> `tui.editor.deleteToLineStart`, `deleteToLineEnd` -> `tui.editor.deleteToLineEnd`, `yank` -> `tui.editor.yank`, `yankPop` -> `tui.editor.yankPop`, `undo` -> `tui.editor.undo`, `newLine` -> `tui.input.newLine`, `submit` -> `tui.input.submit`, `tab` -> `tui.input.tab`, `copy` -> `tui.input.copy`, `selectUp` -> `tui.select.up`, `selectDown` -> `tui.select.down`, `selectPageUp` -> `tui.select.pageUp`, `selectPageDown` -> `tui.select.pageDown`, `selectConfirm` -> `tui.select.confirm`, `selectCancel` -> `tui.select.cancel`. `keybindings.json` stays backward compatible because each keybinding definition maps the new internal id back to the existing public config key. Apps extend `interface Keybindings` via declaration merging, create one manager with both TUI and app definitions, then install it with `setKeybindings(...)` ([#2391](https://github.com/badlogic/pi-mono/issues/2391))

### Fixed

- Fixed user-defined keybindings to shadow conflicting default bindings across the shared registry, so app-level defaults no longer stay active when the same key is explicitly reassigned ([#2391](https://github.com/badlogic/pi-mono/issues/2391))

## [0.60.0] - 2026-03-18

### Fixed

- Fixed tmux xterm `modifyOtherKeys` matching for `Backspace`, `Escape`, and `Space`, and resolved raw `\x08` backspace ambiguity by treating Windows Terminal sessions differently from legacy terminals ([#2293](https://github.com/badlogic/pi-mono/issues/2293))

## [0.59.0] - 2026-03-17

## [0.58.4] - 2026-03-16

## [0.58.3] - 2026-03-15

## [0.58.2] - 2026-03-15

### Added

- Added configurable `SelectList` primary column sizing via `SelectListLayoutOptions`, including custom primary-label truncation hooks ([#2154](https://github.com/badlogic/pi-mono/pull/2154) by [@markusylisiurunen](https://github.com/markusylisiurunen))

### Fixed

- Fixed stale scrollback remaining after full-screen redraws such as session switches by clearing the screen before wiping scrollback ([#2155](https://github.com/badlogic/pi-mono/pull/2155) by [@Perlence](https://github.com/Perlence))
- Fixed trailing blank lines after markdown block elements when they are followed immediately by the next block or end of document ([#2152](https://github.com/badlogic/pi-mono/pull/2152) by [@markusylisiurunen](https://github.com/markusylisiurunen))

## [0.58.1] - 2026-03-14

### Fixed

- Fixed Windows shell and path handling in autocomplete to properly handle drive letters and mixed path separators
- Fixed editor paste to preserve literal content instead of normalizing newlines, preventing content corruption for text with embedded escape sequences ([#2064](https://github.com/badlogic/pi-mono/issues/2064))
- Fixed tab completion to preserve `./` prefix when completing relative paths ([#2087](https://github.com/badlogic/pi-mono/issues/2087))
- Fixed `ctrl+backspace` being indistinguishable from plain `backspace` on Windows Terminal. `0x08` is now recognized as `ctrl+backspace` instead of `backspace`, making `ctrl+backspace` bindable on terminals where it produces a distinct byte ([#2139](https://github.com/badlogic/pi-mono/issues/2139))

## [0.58.0] - 2026-03-14

### Added

- Added paste marker atomic segment handling in editor, treating paste markers as indivisible units during word wrapping and cursor navigation ([#2111](https://github.com/badlogic/pi-mono/pull/2111) by [@haoqixu](https://github.com/haoqixu))

### Fixed

- Fixed `Input` horizontal scrolling for wide Unicode text (CJK, fullwidth characters) to use visual column width and strict slice boundaries, preventing rendered line overflow and TUI crashes ([#1982](https://github.com/badlogic/pi-mono/issues/1982))
- Fixed xterm `modifyOtherKeys` handling for `Tab` in `matchesKey()`, restoring `shift+tab` and other modified Tab bindings in tmux when `extended-keys-format` is left at the default `xterm`
- Fixed editor scroll indicator rendering crash in narrow terminal widths ([#2103](https://github.com/badlogic/pi-mono/pull/2103) by [@haoqixu](https://github.com/haoqixu))
- Fixed tab characters in editor `setText()` and input paths not being normalized to spaces ([#2027](https://github.com/badlogic/pi-mono/pull/2027) by [@haoqixu](https://github.com/haoqixu))
- Fixed `wordWrapLine` overflow when wide characters (CJK, fullwidth) fall exactly at the wrap boundary ([#2082](https://github.com/badlogic/pi-mono/pull/2082) by [@haoqixu](https://github.com/haoqixu))
- Fixed tab characters in `Input` paste not being normalized to spaces ([#1975](https://github.com/badlogic/pi-mono/pull/1975) by [@haoqixu](https://github.com/haoqixu))

## [0.57.1] - 2026-03-07

### Added

- Added `treeFoldOrUp` and `treeUnfoldOrDown` editor actions with default bindings for `Ctrl+←`/`Ctrl+→` and `Alt+←`/`Alt+→` ([#1724](https://github.com/badlogic/pi-mono/pull/1724) by [@Perlence](https://github.com/Perlence))
- Added digit keys (`0-9`) to the keybinding system, including Kitty CSI-u and xterm `modifyOtherKeys` support for bindings like `ctrl+1` ([#1905](https://github.com/badlogic/pi-mono/issues/1905))

### Fixed

- Fixed autocomplete selection ignoring typed text: highlight now follows the first prefix match as the user types, and exact matches are always selected on Enter ([#1931](https://github.com/badlogic/pi-mono/pull/1931) by [@aliou](https://github.com/aliou))
- Fixed xterm `modifyOtherKeys` parsing in `matchesKey()` and `parseKey()`, restoring Ctrl-based keybindings and modified Enter keys in tmux when `extended-keys-format` is left at the default `xterm` ([#1872](https://github.com/badlogic/pi-mono/issues/1872))
- Fixed slash-command Tab completion to immediately open argument completions when available ([#1481](https://github.com/badlogic/pi-mono/pull/1481) by [@barapa](https://github.com/barapa))

## [0.57.0] - 2026-03-07

### Added

- Added non-capturing overlays via `OverlayOptions.nonCapturing` and new `OverlayHandle` methods: `focus()`, `unfocus()`, and `isFocused()` for programmatic overlay focus control ([#1916](https://github.com/badlogic/pi-mono/pull/1916) by [@nicobailon](https://github.com/nicobailon))

### Changed

- Overlay compositing order now uses focus order so focused overlays render on top while preserving stack semantics for show/hide behavior ([#1916](https://github.com/badlogic/pi-mono/pull/1916) by [@nicobailon](https://github.com/nicobailon))

### Fixed

- Fixed automatic focus restoration to skip non-capturing overlays and fixed `hideOverlay()` to only reassign focus when the popped overlay had focus ([#1916](https://github.com/badlogic/pi-mono/pull/1916) by [@nicobailon](https://github.com/nicobailon))

## [0.56.3] - 2026-03-06

### Added

- Added xterm modifyOtherKeys mode 2 fallback when Kitty keyboard protocol is not available, enabling modified enter keys (Shift+Enter, Ctrl+Enter) inside tmux ([#1872](https://github.com/badlogic/pi-mono/issues/1872))

## [0.56.2] - 2026-03-05

### Added

- Exported `decodeKittyPrintable()` from `keys.ts` for decoding Kitty CSI-u sequences into printable characters

### Fixed

- Fixed `Input` component not accepting typed characters when Kitty keyboard protocol is active (e.g., VS Code 1.110+), causing model selector filter to ignore keystrokes ([#1857](https://github.com/badlogic/pi-mono/issues/1857))
- Fixed editor/footer visibility drift during terminal resize by forcing full redraws when terminal width or height changes ([#1844](https://github.com/badlogic/pi-mono/pull/1844) by [@ghoulr](https://github.com/ghoulr)).

## [0.56.1] - 2026-03-05

### Fixed

- Fixed markdown blockquote rendering to isolate blockquote styling from default text style, preventing style leakage.

## [0.56.0] - 2026-03-04

### Fixed

- Fixed TUI width calculation for regional indicator symbols (e.g. partial flag sequences like `🇨` during streaming) to prevent wrap drift and stale character artifacts in differential rendering.
- Fixed Kitty CSI-u handling to ignore unsupported modifiers so modifier-only events do not insert stray printable characters ([#1807](https://github.com/badlogic/pi-mono/issues/1807))
- Fixed single-line paste performance by inserting pasted text atomically instead of character-by-character, preventing repeated `@` autocomplete scans during paste ([#1812](https://github.com/badlogic/pi-mono/issues/1812))
- Fixed `visibleWidth()` to ignore generic OSC escape sequences (including OSC 133 semantic prompt markers), preventing width drift when terminals emit semantic zone markers ([#1805](https://github.com/badlogic/pi-mono/issues/1805))
- Fixed markdown blockquotes dropping nested list content by rendering blockquote children as block-level tokens ([#1787](https://github.com/badlogic/pi-mono/issues/1787))

## [0.55.4] - 2026-03-02

## [0.55.3] - 2026-02-27

## [0.55.2] - 2026-02-27

## [0.55.1] - 2026-02-26

### Fixed

- Fixed Windows VT input initialization in ESM by loading `koffi` via `createRequire`, restoring VT input mode while keeping `koffi` externalized from compiled binaries ([#1627](https://github.com/badlogic/pi-mono/pull/1627) by [@kaste](https://github.com/kaste))

## [0.55.0] - 2026-02-24

## [0.54.2] - 2026-02-23

## [0.54.1] - 2026-02-22

### Fixed

- Changed koffi import from top-level to dynamic require in `enableWindowsVTInput()` to prevent bun from embedding all 18 platform `.node` files (~74MB) into every compiled binary. Koffi is only needed on Windows.

## [0.54.0] - 2026-02-19

## [0.53.1] - 2026-02-19

## [0.53.0] - 2026-02-17

## [0.52.12] - 2026-02-13

## [0.52.11] - 2026-02-13

## [0.52.10] - 2026-02-12

### Added

- Added terminal input listeners in `TUI` (`addInputListener` and `removeInputListener`) to let callers intercept, transform, or consume raw input before component handling.

### Fixed

- Fixed `@` autocomplete fuzzy matching to score against path segments and prefixes, reducing irrelevant matches for nested paths ([#1423](https://github.com/badlogic/pi-mono/issues/1423))

## [0.52.9] - 2026-02-08

## [0.52.8] - 2026-02-07

### Added

- Added `pasteToEditor` to `EditorComponent` API for programmatic paste support ([#1351](https://github.com/badlogic/pi-mono/pull/1351) by [@kaofelix](https://github.com/kaofelix))
- Added kill ring (ctrl+k/ctrl+y/alt+y) and undo (ctrl+z) support to the Input component ([#1373](https://github.com/badlogic/pi-mono/pull/1373) by [@Perlence](https://github.com/Perlence))

## [0.52.7] - 2026-02-06

## [0.52.6] - 2026-02-05

## [0.52.5] - 2026-02-05

## [0.52.4] - 2026-02-05

## [0.52.3] - 2026-02-05

## [0.52.2] - 2026-02-05

## [0.52.1] - 2026-02-05

## [0.52.0] - 2026-02-05

## [0.51.6] - 2026-02-04

### Changed

- Slash command menu now triggers on the first line even when other lines have content, allowing commands to be prepended to existing text ([#1227](https://github.com/badlogic/pi-mono/pull/1227) by [@aliou](https://github.com/aliou))

### Fixed

- Fixed `/settings` crashing in narrow terminals by handling small widths in the settings list ([#1246](https://github.com/badlogic/pi-mono/pull/1246) by [@haoqixu](https://github.com/haoqixu))

## [0.51.5] - 2026-02-04

## [0.51.4] - 2026-02-03

### Fixed

- Fixed input scrolling to avoid splitting emoji sequences ([#1228](https://github.com/badlogic/pi-mono/pull/1228) by [@haoqixu](https://github.com/haoqixu))

## [0.51.3] - 2026-02-03

## [0.51.2] - 2026-02-03

### Added

- Added `Terminal.drainInput()` to drain stdin before exit (prevents Kitty key release events leaking over slow SSH)

### Fixed

- Fixed Kitty key release events leaking to parent shell over slow SSH connections by draining stdin for up to 1s ([#1204](https://github.com/badlogic/pi-mono/issues/1204))
- Fixed legacy newline handling in the editor to preserve previous newline behavior
- Fixed @ autocomplete to include hidden paths
- Fixed submit fallback to honor configured keybindings

## [0.51.1] - 2026-02-02

### Added

- Added `PI_DEBUG_REDRAW=1` env var for debugging full redraws (logs triggers to `~/.pi/agent/pi-debug.log`)

### Changed

- Terminal height changes no longer trigger full redraws, reducing flicker on resize
- `clearOnShrink` now defaults to `false` (use `PI_CLEAR_ON_SHRINK=1` or `setClearOnShrink(true)` to enable)

### Fixed

- Fixed emoji cursor positioning in Input component ([#1183](https://github.com/badlogic/pi-mono/pull/1183) by [@haoqixu](https://github.com/haoqixu))

- Fixed unnecessary full redraws when appending many lines after content had previously shrunk (viewport check now uses actual previous content size instead of stale maximum)
- Fixed Ctrl+D exit closing the parent SSH session due to stdin buffer race condition ([#1185](https://github.com/badlogic/pi-mono/issues/1185))

## [0.51.0] - 2026-02-01

## [0.50.9] - 2026-02-01

## [0.50.8] - 2026-02-01

### Added

- Added sticky column tracking for vertical cursor navigation so the editor restores the preferred column when moving across short lines. ([#1120](https://github.com/badlogic/pi-mono/pull/1120) by [@Perlence](https://github.com/Perlence))

### Fixed

- Fixed Kitty keyboard protocol base layout fallback so non-QWERTY layouts do not trigger wrong shortcuts ([#1096](https://github.com/badlogic/pi-mono/pull/1096) by [@rytswd](https://github.com/rytswd))

## [0.50.7] - 2026-01-31

## [0.50.6] - 2026-01-30

### Changed

- Optimized `isImageLine()` with `startsWith` short-circuit for faster image line detection

### Fixed

- Fixed empty rows appearing below footer when content shrinks (e.g., closing `/tree`, clearing multi-line editor) ([#1095](https://github.com/badlogic/pi-mono/pull/1095) by [@marckrenn](https://github.com/marckrenn))
- Fixed terminal cursor remaining hidden after exiting TUI via `stop()` when a render was pending ([#1099](https://github.com/badlogic/pi-mono/pull/1099) by [@haoqixu](https://github.com/haoqixu))

## [0.50.5] - 2026-01-30

### Fixed

- Fixed `isImageLine()` to check for image escape sequences anywhere in a line, not just at the start. This prevents TUI crashes when rendering lines containing image data. ([#1091](https://github.com/badlogic/pi-mono/pull/1091) by [@zedrdave](https://github.com/zedrdave))

## [0.50.4] - 2026-01-30

### Added

- Added Ctrl+B and Ctrl+F as alternative keybindings for cursor word left/right navigation ([#1053](https://github.com/badlogic/pi-mono/pull/1053) by [@ninlds](https://github.com/ninlds))
- Added character jump navigation: Ctrl+] jumps forward to next character, Ctrl+Alt+] jumps backward ([#1074](https://github.com/badlogic/pi-mono/pull/1074) by [@Perlence](https://github.com/Perlence))
- Editor now jumps to line start when pressing Up at first visual line, and line end when pressing Down at last visual line ([#1050](https://github.com/badlogic/pi-mono/pull/1050) by [@4h9fbZ](https://github.com/4h9fbZ))

### Changed

- Optimized image line detection and box rendering cache for better performance ([#1084](https://github.com/badlogic/pi-mono/pull/1084) by [@can1357](https://github.com/can1357))

### Fixed

- Fixed autocomplete for paths with spaces by supporting quoted path tokens ([#1077](https://github.com/badlogic/pi-mono/issues/1077))
- Fixed quoted path completions to avoid duplicating closing quotes during autocomplete ([#1077](https://github.com/badlogic/pi-mono/issues/1077))

## [0.50.3] - 2026-01-29

## [0.50.2] - 2026-01-29

### Added

- Added `autocompleteMaxVisible` option to `EditorOptions` with getter/setter methods for configurable autocomplete dropdown height ([#972](https://github.com/badlogic/pi-mono/pull/972) by [@masonc15](https://github.com/masonc15))
- Added `alt+b` and `alt+f` as alternative keybindings for word navigation (`cursorWordLeft`, `cursorWordRight`) and `ctrl+d` for `deleteCharForward` ([#1043](https://github.com/badlogic/pi-mono/issues/1043) by [@jasonish](https://github.com/jasonish))
- Editor auto-applies single suggestion when force file autocomplete triggers with exactly one match ([#993](https://github.com/badlogic/pi-mono/pull/993) by [@Perlence](https://github.com/Perlence))

### Changed

- Improved `extractCursorPosition` performance: scans lines in reverse order, early-outs when cursor is above viewport, and limits scan to bottom terminal height ([#1004](https://github.com/badlogic/pi-mono/pull/1004) by [@can1357](https://github.com/can1357))
- Autocomplete improvements: better handling of partial matches and edge cases ([#1024](https://github.com/badlogic/pi-mono/pull/1024) by [@Perlence](https://github.com/Perlence))

### Fixed

- Fixed backslash input buffering causing delayed character display in editor and input components ([#1037](https://github.com/badlogic/pi-mono/pull/1037) by [@Perlence](https://github.com/Perlence))
- Fixed markdown table rendering with proper row dividers and minimum column width ([#997](https://github.com/badlogic/pi-mono/pull/997) by [@tmustier](https://github.com/tmustier))

## [0.50.1] - 2026-01-26

## [0.50.0] - 2026-01-26

### Added

- Added `fullRedraws` readonly property to TUI class for tracking full screen redraws
- Added `PI_TUI_WRITE_LOG` environment variable to capture raw ANSI output for debugging

### Fixed

- Fixed appended lines not being committed to scrollback, causing earlier content to be overwritten when viewport fills ([#954](https://github.com/badlogic/pi-mono/issues/954))
- Slash command menu now only triggers when the editor input is otherwise empty ([#904](https://github.com/badlogic/pi-mono/issues/904))
- Center-anchored overlays now stay vertically centered when resizing the terminal taller after a shrink ([#950](https://github.com/badlogic/pi-mono/pull/950) by [@nicobailon](https://github.com/nicobailon))
- Fixed editor multi-line insertion handling and lastAction tracking ([#945](https://github.com/badlogic/pi-mono/pull/945) by [@Perlence](https://github.com/Perlence))
- Fixed editor word wrapping to reserve a cursor column ([#934](https://github.com/badlogic/pi-mono/pull/934) by [@Perlence](https://github.com/Perlence))
- Fixed editor word wrapping to use single-pass backtracking for whitespace handling ([#924](https://github.com/badlogic/pi-mono/pull/924) by [@Perlence](https://github.com/Perlence))
- Fixed Kitty image ID allocation and cleanup to prevent image ID collisions between modules

## [0.49.3] - 2026-01-22

### Added

- `codeBlockIndent` property on `MarkdownTheme` to customize code block content indentation (default: 2 spaces) ([#855](https://github.com/badlogic/pi-mono/pull/855) by [@terrorobe](https://github.com/terrorobe))
- Added Alt+Delete as hotkey for delete word forwards ([#878](https://github.com/badlogic/pi-mono/pull/878) by [@Perlence](https://github.com/Perlence))

### Changed

- Fuzzy matching now scores consecutive matches higher and penalizes gaps more heavily for better relevance ([#860](https://github.com/badlogic/pi-mono/pull/860) by [@mitsuhiko](https://github.com/mitsuhiko))

### Fixed

- Autolinked emails no longer display redundant `(mailto:...)` suffix in markdown output ([#888](https://github.com/badlogic/pi-mono/pull/888) by [@terrorobe](https://github.com/terrorobe))
- Fixed viewport tracking and cursor positioning for overlays and content shrink scenarios
- Autocomplete now allows searches with `/` characters (e.g., `folder1/folder2`) ([#882](https://github.com/badlogic/pi-mono/pull/882) by [@richardgill](https://github.com/richardgill))
- Directory completions for `@` file attachments no longer add trailing space, allowing continued autocomplete into subdirectories

## [0.49.2] - 2026-01-19

## [0.49.1] - 2026-01-18

### Added

- Added undo support to Editor with Ctrl+- hotkey. Undo coalesces consecutive word characters into one unit (fish-style). ([#831](https://github.com/badlogic/pi-mono/pull/831) by [@Perlence](https://github.com/Perlence))
- Added legacy terminal support for Ctrl+symbol keys (Ctrl+\, Ctrl+], Ctrl+-) and their Ctrl+Alt variants. ([#831](https://github.com/badlogic/pi-mono/pull/831) by [@Perlence](https://github.com/Perlence))

## [0.49.0] - 2026-01-17

### Added

- Added `showHardwareCursor` getter and setter to control cursor visibility while keeping IME positioning active. ([#800](https://github.com/badlogic/pi-mono/pull/800) by [@ghoulr](https://github.com/ghoulr))
- Added Emacs-style kill ring editing with yank and yank-pop keybindings. ([#810](https://github.com/badlogic/pi-mono/pull/810) by [@Perlence](https://github.com/Perlence))
- Added legacy Alt+letter handling and Alt+D delete word forward support in the editor keymap. ([#810](https://github.com/badlogic/pi-mono/pull/810) by [@Perlence](https://github.com/Perlence))

## [0.48.0] - 2026-01-16

### Added

- `EditorOptions` with optional `paddingX` for horizontal content padding, plus `getPaddingX()`/`setPaddingX()` methods ([#791](https://github.com/badlogic/pi-mono/pull/791) by [@ferologics](https://github.com/ferologics))

### Changed

- Hardware cursor is now disabled by default for better terminal compatibility. Set `PI_HARDWARE_CURSOR=1` to enable (replaces `PI_NO_HARDWARE_CURSOR=1` which disabled it).

### Fixed

- Decode Kitty CSI-u printable sequences in the editor so shifted symbol keys (e.g., `@`, `?`) work in terminals that enable Kitty keyboard protocol ([#779](https://github.com/badlogic/pi-mono/pull/779) by [@iamd3vil](https://github.com/iamd3vil))

## [0.47.0] - 2026-01-16

### Breaking Changes

- `Editor` constructor now requires `TUI` as first parameter: `new Editor(tui, theme)`. This enables automatic vertical scrolling when content exceeds terminal height. ([#732](https://github.com/badlogic/pi-mono/issues/732))

### Added

- Hardware cursor positioning for IME support in `Editor` and `Input` components. The terminal cursor now follows the text cursor position, enabling proper IME candidate window placement for CJK input. ([#719](https://github.com/badlogic/pi-mono/pull/719))
- `Focusable` interface for components that need hardware cursor positioning. Implement `focused: boolean` and emit `CURSOR_MARKER` in render output when focused.
- `CURSOR_MARKER` constant and `isFocusable()` type guard exported from the package
- Editor now supports Page Up/Down keys (Fn+Up/Down on MacBook) for scrolling through large content ([#732](https://github.com/badlogic/pi-mono/issues/732))
- Expanded keymap coverage for terminal compatibility: added support for Home/End keys in tmux, additional modifier combinations, and improved key sequence parsing ([#752](https://github.com/badlogic/pi-mono/pull/752) by [@richardgill](https://github.com/richardgill))

### Fixed

- Editor no longer corrupts terminal display when text exceeds screen height. Content now scrolls vertically with indicators showing lines above/below the viewport. Max height is 30% of terminal (minimum 5 lines). ([#732](https://github.com/badlogic/pi-mono/issues/732))
- `visibleWidth()` and `extractAnsiCode()` now handle APC escape sequences (`ESC _ ... BEL`), fixing width calculation and string slicing for strings containing cursor markers
- SelectList now handles multi-line descriptions by replacing newlines with spaces ([#728](https://github.com/badlogic/pi-mono/pull/728) by [@richardgill](https://github.com/richardgill))

## [0.46.0] - 2026-01-15

### Fixed

- Keyboard shortcuts (Ctrl+C, Ctrl+D, etc.) now work on non-Latin keyboard layouts (Russian, Ukrainian, Bulgarian, etc.) in terminals supporting Kitty keyboard protocol with alternate key reporting ([#718](https://github.com/badlogic/pi-mono/pull/718) by [@dannote](https://github.com/dannote))

## [0.45.7] - 2026-01-13

## [0.45.6] - 2026-01-13

### Added

- `OverlayOptions` API for overlay positioning and sizing with CSS-like values: `width`, `maxHeight`, `row`, `col` accept numbers (absolute) or percentage strings (e.g., `"50%"`). Also supports `minWidth`, `anchor`, `offsetX`, `offsetY`, `margin`. ([#667](https://github.com/badlogic/pi-mono/pull/667) by [@nicobailon](https://github.com/nicobailon))
- `OverlayOptions.visible` callback for responsive overlays - receives terminal dimensions, return false to hide ([#667](https://github.com/badlogic/pi-mono/pull/667) by [@nicobailon](https://github.com/nicobailon))
- `showOverlay()` now returns `OverlayHandle` with `hide()`, `setHidden(boolean)`, `isHidden()` for programmatic visibility control ([#667](https://github.com/badlogic/pi-mono/pull/667) by [@nicobailon](https://github.com/nicobailon))
- New exported types: `OverlayAnchor`, `OverlayHandle`, `OverlayMargin`, `OverlayOptions`, `SizeValue` ([#667](https://github.com/badlogic/pi-mono/pull/667) by [@nicobailon](https://github.com/nicobailon))
- `truncateToWidth()` now accepts optional `pad` parameter to pad result with spaces to exactly `maxWidth` ([#667](https://github.com/badlogic/pi-mono/pull/667) by [@nicobailon](https://github.com/nicobailon))

### Fixed

- Overlay compositing crash when rendered lines exceed terminal width due to complex ANSI/OSC sequences (e.g., hyperlinks in subagent output) ([#667](https://github.com/badlogic/pi-mono/pull/667) by [@nicobailon](https://github.com/nicobailon))

## [0.45.5] - 2026-01-13

## [0.45.4] - 2026-01-13

## [0.45.3] - 2026-01-13

## [0.45.2] - 2026-01-13

## [0.45.1] - 2026-01-13

## [0.45.0] - 2026-01-13

## [0.44.0] - 2026-01-12

### Added

- `SettingsListOptions` with `enableSearch` for fuzzy filtering in `SettingsList` ([#643](https://github.com/badlogic/pi-mono/pull/643) by [@ninlds](https://github.com/ninlds))
- `pageUp` and `pageDown` key support with `selectPageUp`/`selectPageDown` editor actions ([#662](https://github.com/badlogic/pi-mono/pull/662) by [@aliou](https://github.com/aliou))

### Fixed

- Numbered list items showing "1." for all items when code blocks break list continuity ([#660](https://github.com/badlogic/pi-mono/pull/660) by [@ogulcancelik](https://github.com/ogulcancelik))

## [0.43.0] - 2026-01-11

### Added

- `fuzzyFilter()` and `fuzzyMatch()` utilities for fuzzy text matching
- Slash command autocomplete now uses fuzzy matching instead of prefix matching

### Fixed

- Cursor now moves to end of content on exit, preventing status line from being overwritten ([#629](https://github.com/badlogic/pi-mono/pull/629) by [@tallshort](https://github.com/tallshort))
- Reset ANSI styles after each rendered line to prevent style leakage

## [0.42.5] - 2026-01-11

### Fixed

- Reduced flicker by only re-rendering changed lines ([#617](https://github.com/badlogic/pi-mono/pull/617) by [@ogulcancelik](https://github.com/ogulcancelik))
- Cursor position tracking when content shrinks with unchanged remaining lines
- TUI renders with wrong dimensions after suspend/resume if terminal was resized while suspended ([#599](https://github.com/badlogic/pi-mono/issues/599))
- Pasted content containing Kitty key release patterns (e.g., `:3F` in MAC addresses) was incorrectly filtered out ([#623](https://github.com/badlogic/pi-mono/pull/623) by [@ogulcancelik](https://github.com/ogulcancelik))

## [0.42.4] - 2026-01-10

## [0.42.3] - 2026-01-10

## [0.42.2] - 2026-01-10

## [0.42.1] - 2026-01-09

## [0.42.0] - 2026-01-09

## [0.41.0] - 2026-01-09

## [0.40.1] - 2026-01-09

## [0.40.0] - 2026-01-08

## [0.39.1] - 2026-01-08

## [0.39.0] - 2026-01-08

### Added

- **Experimental:** Overlay compositing for `ctx.ui.custom()` with `{ overlay: true }` option ([#558](https://github.com/badlogic/pi-mono/pull/558) by [@nicobailon](https://github.com/nicobailon))

## [0.38.0] - 2026-01-08

### Added

- `EditorComponent` interface for custom editor implementations
- `StdinBuffer` class to split batched stdin into individual sequences (adapted from [OpenTUI](https://github.com/anomalyco/opentui), MIT license)

### Fixed

- Key presses no longer dropped when batched with other events over SSH ([#538](https://github.com/badlogic/pi-mono/pull/538))

## [0.37.8] - 2026-01-07

### Added

- `Component.wantsKeyRelease` property to opt-in to key release events (default false)

### Fixed

- TUI now filters out key release events by default, preventing double-processing of keys in editors and other components

## [0.37.7] - 2026-01-07

### Fixed

- `matchesKey()` now correctly matches Kitty protocol sequences for unmodified letter keys (needed for key release events)

## [0.37.6] - 2026-01-06

### Added

- Kitty keyboard protocol flag 2 support for key release events. New exports: `isKeyRelease(data)`, `isKeyRepeat(data)`, `KeyEventType` type. Terminals supporting Kitty protocol (Kitty, Ghostty, WezTerm) now send proper key-up events.

## [0.37.5] - 2026-01-06

## [0.37.4] - 2026-01-06

## [0.37.3] - 2026-01-06

## [0.37.2] - 2026-01-05

## [0.37.1] - 2026-01-05

## [0.37.0] - 2026-01-05

### Fixed

- Crash when pasting text with trailing whitespace exceeding terminal width through Markdown rendering ([#457](https://github.com/badlogic/pi-mono/pull/457) by [@robinwander](https://github.com/robinwander))

## [0.36.0] - 2026-01-05

## [0.35.0] - 2026-01-05

## [0.34.2] - 2026-01-04

## [0.34.1] - 2026-01-04

### Added

- Symbol key support in keybinding system: `SymbolKey` type with 32 symbol keys, `Key` constants (e.g., `Key.backtick`, `Key.comma`), updated `matchesKey()` and `parseKey()` to handle symbol input ([#450](https://github.com/badlogic/pi-mono/pull/450) by [@kaofelix](https://github.com/kaofelix))

## [0.34.0] - 2026-01-04

### Added

- `Editor.getExpandedText()` method that returns text with paste markers expanded to their actual content ([#444](https://github.com/badlogic/pi-mono/pull/444) by [@aliou](https://github.com/aliou))

## [0.33.0] - 2026-01-04

### Breaking Changes

- **Key detection functions removed**: All `isXxx()` key detection functions (`isEnter()`, `isEscape()`, `isCtrlC()`, etc.) have been removed. Use `matchesKey(data, keyId)` instead (e.g., `matchesKey(data, "enter")`, `matchesKey(data, "ctrl+c")`). This affects hooks and custom tools that use `ctx.ui.custom()` with keyboard input handling. ([#405](https://github.com/badlogic/pi-mono/pull/405))

### Added

- `Editor.insertTextAtCursor(text)` method for programmatic text insertion ([#419](https://github.com/badlogic/pi-mono/issues/419))
- `EditorKeybindingsManager` for configurable editor keybindings. Components now use `matchesKey()` and keybindings manager instead of individual `isXxx()` functions. ([#405](https://github.com/badlogic/pi-mono/pull/405) by [@hjanuschka](https://github.com/hjanuschka))

### Changed

- Key detection refactored: consolidated `is*()` functions into generic `matchesKey(data, keyId)` function that accepts key identifiers like `"ctrl+c"`, `"shift+enter"`, `"alt+left"`, etc.

## [0.32.3] - 2026-01-03

## [0.32.2] - 2026-01-03

### Fixed

- Slash command autocomplete now triggers for commands starting with `.`, `-`, or `_` (e.g., `/.land`, `/-foo`) ([#422](https://github.com/badlogic/pi-mono/issues/422))

## [0.32.1] - 2026-01-03

## [0.32.0] - 2026-01-03

### Changed

- Editor component now uses word wrapping instead of character-level wrapping for better readability ([#382](https://github.com/badlogic/pi-mono/pull/382) by [@nickseelert](https://github.com/nickseelert))

### Fixed

- Shift+Space, Shift+Backspace, and Shift+Delete now work correctly in Kitty-protocol terminals (Kitty, WezTerm, etc.) instead of being silently ignored ([#411](https://github.com/badlogic/pi-mono/pull/411) by [@nathyong](https://github.com/nathyong))

## [0.31.1] - 2026-01-02

### Fixed

- `visibleWidth()` now strips OSC 8 hyperlink sequences, fixing text wrapping for clickable links ([#396](https://github.com/badlogic/pi-mono/pull/396) by [@Cursivez](https://github.com/Cursivez))

## [0.31.0] - 2026-01-02

### Added

- `isShiftCtrlO()` key detection function for Shift+Ctrl+O (Kitty protocol)
- `isShiftCtrlD()` key detection function for Shift+Ctrl+D (Kitty protocol)
- `TUI.onDebug` callback for global debug key handling (Shift+Ctrl+D)
- `wrapTextWithAnsi()` utility now exported (wraps text to width, preserving ANSI codes)

### Changed

- README.md completely rewritten with accurate component documentation, theme interfaces, and examples
- `visibleWidth()` reimplemented with grapheme-based width calculation, 10x faster on Bun and ~15% faster on Node ([#369](https://github.com/badlogic/pi-mono/pull/369) by [@nathyong](https://github.com/nathyong))

### Fixed

- Markdown component now renders HTML tags as plain text instead of silently dropping them ([#359](https://github.com/badlogic/pi-mono/issues/359))
- Crash in `visibleWidth()` and grapheme iteration when encountering undefined code points ([#372](https://github.com/badlogic/pi-mono/pull/372) by [@HACKE-RC](https://github.com/HACKE-RC))
- ZWJ emoji sequences (rainbow flag, family, etc.) now render with correct width instead of being split into multiple characters ([#369](https://github.com/badlogic/pi-mono/pull/369) by [@nathyong](https://github.com/nathyong))

## [0.29.0] - 2025-12-25

### Added

- **Auto-space before pasted file paths**: When pasting a file path (starting with `/`, `~`, or `.`) and the cursor is after a word character, a space is automatically prepended for better readability. Useful when dragging screenshots from macOS. ([#307](https://github.com/badlogic/pi-mono/pull/307) by [@mitsuhiko](https://github.com/mitsuhiko))
- **Word navigation for Input component**: Added Ctrl+Left/Right and Alt+Left/Right support for word-by-word cursor movement. ([#306](https://github.com/badlogic/pi-mono/pull/306) by [@kim0](https://github.com/kim0))
- **Full Unicode input**: Input component now accepts Unicode characters beyond ASCII. ([#306](https://github.com/badlogic/pi-mono/pull/306) by [@kim0](https://github.com/kim0))

### Fixed

- **Readline-style Ctrl+W**: Now skips trailing whitespace before deleting the preceding word, matching standard readline behavior. ([#306](https://github.com/badlogic/pi-mono/pull/306) by [@kim0](https://github.com/kim0))

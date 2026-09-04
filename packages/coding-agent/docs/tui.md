# TUI

`pi-tui` provides main-screen and alternate-screen differential renderers with synchronized output. Components include text, Markdown, input/editor, selection/settings lists, stacks, scrolling, loaders, boxes, mouse regions, overlays, and inline images. Width calculations are ANSI-aware and Unicode grapheme-aware. Keyboard decoding supports legacy and Kitty protocols.

Set `tuiMode` to `regular` or `fullscreen` in settings. The interactive coding agent is built directly on these Rust components.

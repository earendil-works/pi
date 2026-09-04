# pi-tui

Native Rust terminal UI primitives for Pi. It provides differential main-screen and alternate-screen renderers, synchronized output, Unicode-width-safe wrapping, Kitty keyboard decoding, autocomplete, inline Kitty/iTerm2 images, scrolling, and reusable text, editor, input, selection, settings, stack, loader, box, and Markdown components.

```rust
use pi_tui::{Tui, TuiMainScreen, ProcessTerminal, Text, shared};
let mut tui = TuiMainScreen::new(ProcessTerminal::new());
tui.add_child(shared(Text::new("Hello")));
tui.start()?;
```

# Height Awareness & Scrolling Research

## Summary

This document captures research findings on how other TUI editors implement height awareness and scrolling for textarea components.

## Key Findings from tui-textarea (Rust/Ratatui)

### 1. Viewport State Management

tui-textarea stores viewport state separately from text state:

```rust
pub struct Viewport(AtomicU64);

impl Viewport {
    pub fn scroll_top(&self) -> (u16, u16) { ... } // returns (row, col)
    pub fn rect(&self) -> (u16, u16, u16, u16) { ... } // (row, col, width, height)
    pub fn scroll(&mut self, rows: i16, cols: i16) { ... }
}
```

The viewport is packed into a single `u64` for efficient storage:
- Bits 0-15: col offset
- Bits 16-31: row offset  
- Bits 32-47: height
- Bits 48-63: width

### 2. Auto-Scroll Logic

The key function for keeping cursor visible during vertical scrolling:

```rust
fn next_scroll_top(prev_top: u16, cursor: u16, len: u16) -> u16 {
    if cursor < prev_top {
        cursor  // cursor above viewport: scroll up to cursor
    } else if prev_top + len <= cursor {
        cursor + 1 - len  // cursor below viewport: scroll down
    } else {
        prev_top  // cursor in viewport: no change
    }
}
```

This is called during render to determine the scroll position:

```rust
fn scroll_top_row(&self, prev_top: u16, height: u16) -> u16 {
    next_scroll_top(prev_top, self.cursor().0 as u16, height)
}
```

### 3. Scroll Types

tui-textarea supports various scroll operations:
- `Delta { rows, cols }` - scroll by delta
- `PageDown` / `PageUp` - scroll by viewport height
- `HalfPageDown` / `HalfPageUp` - scroll by half viewport

### 4. Cursor Movement After Scroll

Important: The cursor moves when it goes **outside** the viewport, not when scrolling. The scroll operation only changes the view, and cursor adjustment happens to keep cursor visible.

### 5. Height from Render Context

tui-textarea gets the height from the render rect passed to `Widget::render()`:

```rust
impl Widget for &TextArea<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let Rect { width, height, .. } = if let Some(b) = self.block() {
            b.inner(area)
        } else {
            area
        };
        // ...
    }
}
```

## Key Findings from blessed.js (Node.js)

### 1. Scrollable Containers

blessed.js uses simple properties on box elements:
```javascript
blessed.box({
    scrollable: true,
    scrollbar: { ch: ' ', inverse: true },
    alwaysScroll: true,  // auto-scroll on new content
    keys: true,  // enable keyboard navigation
    vi: true,    // vim-like key bindings (j/k/g/G)
    mouse: true  // enable mouse wheel
});
```

### 2. Scrollbar Rendering

blessed.js renders scrollbar as a separate visual element:
```javascript
scrollbar: {
    ch: ' ',  // character to use for scrollbar
    bg: 'blue',
    fg: 'white',
    inverse: true
}
```

### 3. Scroll Events

blessed.js supports:
- `scroll(amount)` - scroll by amount
- Mouse wheel events
- Click+drag on scrollbar

## Key Patterns for pi-tui Implementation

### 1. State Structure

Add to `EditorState`:
```typescript
interface EditorState {
    // existing
    lines: string[];
    cursorLine: number;
    cursorCol: number;
    
    // new for height awareness
    scrollOffset: number;  // first visible display line
    maxHeight?: number;    // optional: if undefined, grows with content
}
```

### 2. Viewport Calculation

During `render(width, height)`:
1. Layout all text into display slices (already done)
2. Determine visible range: `[scrollOffset, scrollOffset + maxHeight)`
3. Only render display lines in visible range
4. Calculate scrollbar position if needed

### 3. Auto-Scroll on Cursor Movement

When cursor moves (via navigation or editing):
```typescript
function ensureCursorVisible() {
    const cursorDisplayLine = findCurrentDisplayLine();
    
    if (cursorDisplayLine < scrollOffset) {
        // cursor above viewport - scroll up
        scrollOffset = cursorDisplayLine;
    } else if (cursorDisplayLine >= scrollOffset + visibleHeight) {
        // cursor below viewport - scroll down
        scrollOffset = cursorDisplayLine - visibleHeight + 1;
    }
}
```

### 4. Explicit Scroll Operations

Add scroll methods:
- `scrollUp(lines: number)` / `scrollDown(lines: number)`
- `pageUp()` / `pageDown()`
- Handle mouse wheel events (if supported)

### 5. Scrollbar (Optional)

Render a visual scrollbar indicator:
```typescript
function renderScrollbar(height: number, totalLines: number, offset: number): string[] {
    const thumbSize = Math.max(1, Math.floor((height / totalLines) * height));
    const thumbPos = Math.floor((offset / (totalLines - height)) * (height - thumbSize));
    // render track with thumb
}
```

## Integration with Existing DisplaySlice System

The current `displaySlices` array already maps wrapped lines to buffer positions. The height awareness feature builds on this:

1. **Render only visible slice range**: Instead of rendering all `displaySlices`, render `displaySlices.slice(scrollOffset, scrollOffset + maxHeight)`

2. **Adjust cursor display**: When rendering cursor position, offset by `scrollOffset` to get screen-relative position

3. **Update navigation**: `findCurrentDisplayLine()` returns absolute index; compare to viewport bounds for scroll adjustments

## Key Differences from Current Implementation

| Current | With Height Awareness |
|---------|----------------------|
| Editor grows with content | Fixed or max height option |
| All lines rendered | Only visible lines rendered |
| No scroll state | Track scroll offset |
| No scroll UI | Optional scrollbar |
| Cursor always visible | Must ensure cursor visibility after movements |

## Recommended Approach

1. **Add `maxHeight` config option** to Editor constructor
2. **Store `scrollOffset` in state** (defaulting to 0)
3. **Modify `render(width)`** to accept optional height or use stored max
4. **Update `layoutText()`** to return only visible range OR filter after
5. **Add `ensureCursorVisible()`** called after any cursor movement
6. **Add keyboard shortcuts** for PageUp/PageDown (Ctrl+V / Alt+V in emacs style)
7. **Optional**: Add scrollbar rendering as rightmost column

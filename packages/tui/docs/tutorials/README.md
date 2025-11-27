# TUI Soft-Wrap Navigation Tutorials

Self-contained scripts demonstrating cursor navigation concepts in soft-wrapped text.

## Prerequisites

```bash
cd packages/tui
npm install  # Make sure dependencies are installed
```

## Tutorials

Run each tutorial from the monorepo root:

### 1. Buffer vs Display Positions
```bash
npx tsx packages/tui/docs/tutorials/01-buffer-vs-display.ts
```
Learn the fundamental difference between where text lives in memory vs how it appears on screen.

### 2. Display Slice Mapping
```bash
npx tsx packages/tui/docs/tutorials/02-display-slices.ts
```
Understand how each display line maps back to buffer coordinates using `DisplaySlice`.

### 3. Vertical Navigation
```bash
npx tsx packages/tui/docs/tutorials/03-vertical-navigation.ts
```
See how up/down navigation works through wrapped lines, including the "sticky column" concept.

### 4. Horizontal Wrapping
```bash
npx tsx packages/tui/docs/tutorials/04-horizontal-wrapping.ts
```
Learn what happens when you press ← or → at display line boundaries.

### 5. Wide Characters (Emojis)
```bash
npx tsx packages/tui/docs/tutorials/05-wide-characters.ts
```
Discover why `string.length` isn't enough and how `visibleWidth()` handles Unicode.

## Concepts Covered

| Tutorial | Key Concepts |
|----------|--------------|
| 01 | Buffer position, display position, coordinate conversion |
| 02 | DisplaySlice, exclusive end index, boundary detection |
| 03 | targetDisplayCol (sticky column), vertical movement, gj/gk |
| 04 | Wrap boundaries, horizontal navigation edge cases |
| 05 | visibleWidth, grapheme clusters, CJK, emojis |

## Related Documentation

- [Main Documentation](../soft-wrap-cursor-navigation.md) - Full Diataxis documentation
- [Editor Component](../../src/components/editor.ts) - Production implementation
- [Editor Tests](../../test/editor.test.ts) - Test cases for navigation

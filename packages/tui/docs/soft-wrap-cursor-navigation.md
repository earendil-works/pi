# Soft-Wrapped Text Cursor Navigation

A guide to understanding viewport-aware cursor navigation in terminal text editors.

---

## Table of Contents

1. [Explanation](#explanation) - Understanding the concepts
2. [Reference](#reference) - Technical details  
3. [Tutorials](#tutorials) - Learning by doing
4. [How-To Guides](#how-to-guides) - Solving specific problems

---

# Explanation

## The Problem: Two Views of the Same Text

When you type text in a terminal editor, there are **two different ways** to think about where your cursor is:

1. **The text buffer** - Where your text actually lives in memory
2. **The display** - What you see on screen

These two views can be *very* different when lines wrap.

### Example: A Long Line

Imagine you type this 25-character string in a terminal that's only 10 columns wide:

```
Buffer (in memory):
"Hello World, this is Pi!"
 ^--- position 0        ^--- position 24

Display (on screen, 10 columns wide):
┌──────────┐
│Hello Worl│  <- display line 0 (buffer positions 0-9)
│d, this is│  <- display line 1 (buffer positions 10-19)  
│ Pi!      │  <- display line 2 (buffer positions 20-24)
└──────────┘
```

The text exists as **one logical line** in the buffer, but appears as **three display lines** on screen.

---

## Key Concept 1: Logical Buffer Positions

A **logical buffer position** is where a character lives in your actual text data.

```typescript
// The underlying text buffer - just an array of strings
const lines = [
  "Hello World, this is Pi!",  // bufferLine 0
  "Second line here"           // bufferLine 1
];

// Cursor position in buffer coordinates
const cursorLine = 0;  // Which buffer line
const cursorCol = 5;   // Which character (0-indexed)
// ^ Points to 'W' in "Hello World..."
```

**Key insight**: The buffer doesn't know or care about your terminal's width. It just stores characters.

---

## Key Concept 2: Logical Lines vs Display Lines

A **logical line** is a single line in your text buffer (terminated by `\n` or end of text).

A **display line** is a single row on your terminal screen.

```
Logical line 0: "Hello World, this is Pi!"
                 ↓ wraps into ↓
Display line 0: "Hello Worl"
Display line 1: "d, this is"
Display line 2: " Pi!"
```

**One logical line → Multiple display lines** (when text wraps)

---

## Key Concept 3: Display Slice Mapping

A **display slice** maps each display line back to its source in the buffer:

```typescript
interface DisplaySlice {
  text: string;        // What's shown on this display line
  bufferLine: number;  // Which logical line it came from
  startCol: number;    // Starting buffer position (inclusive)
  endCol: number;      // Ending buffer position (exclusive)
}
```

For our example text "Hello World, this is Pi!" at width 10:

```typescript
const displaySlices = [
  { text: "Hello Worl", bufferLine: 0, startCol: 0,  endCol: 10 },
  { text: "d, this is", bufferLine: 0, startCol: 10, endCol: 20 },
  { text: " Pi!",       bufferLine: 0, startCol: 20, endCol: 24 },
];
```

**Why this matters**: When the user presses ↓, we need to figure out:
1. Which display line are they on?
2. What's the display line below?
3. What buffer position corresponds to that location?

---

## Key Concept 4: Line Boundaries (Exclusive End)

Notice `endCol` is **exclusive** - it points one past the last character.

```
Text:     H  e  l  l  o     W  o  r  l  d  ,     t  h  i  s
Index:    0  1  2  3  4  5  6  7  8  9  10 11 12 13 14 15 16...
                                       ↑
Slice 0:  startCol=0, endCol=10 ──────┘ (doesn't include index 10)
Slice 1:  startCol=10, endCol=20       (includes index 10)
```

**Why exclusive?** Consider where the cursor can be:
- In slice 0: positions 0-9 (cursor ON characters 'H' through 'l')
- At slice boundary: position 10 - belongs to slice 1!

This prevents the cursor from "landing on the crack" between display lines.

### Boundary Handling for Non-Last Slices

For slices that aren't the last one in a buffer line:
- Cursor positions `startCol` to `endCol - 1` belong to this slice
- Position `endCol` belongs to the NEXT slice

For the last slice:
- Cursor can be at `endCol` (end-of-line position)

---

## Key Concept 5: Visual Columns

A **visual column** is the cursor's horizontal position *on the display*, not in the buffer.

```
Display line 1: "d, this is"
                 ^
Visual column:   0 1 2 3...

Buffer position: 10 (startCol=10, so visual column 0 = buffer col 10)
```

Conversion:
```typescript
visualColumn = bufferCol - slice.startCol;
bufferCol = slice.startCol + visualColumn;
```

---

## Key Concept 6: Target Display Column (Sticky Column)

When you move up/down through text, the cursor should try to maintain its visual column position.

```
Display:
│abcdefghij│  <- cursor at column 5 (on 'f')
│klmno     │  <- move down... column 5 would be past end
│pqrstuvwxy│  <- move down... back to column 5 (on 'u')
```

The **target display column** is remembered across vertical moves:
1. User is at visual column 5
2. Presses ↓ - short line only has 5 chars, cursor goes to position 4 (end)
3. Target column 5 is **preserved**
4. Presses ↓ - next line is long enough, cursor goes back to column 5

Any horizontal movement (←, →, typing, etc.) **clears** the target column.

---

## Key Concept 7: Vim's gj and gk

In Vim, `j` and `k` move by **logical lines**, while `gj` and `gk` move by **display lines**.

```
Logical movement (j/k):          Display movement (gj/gk):
    Buffer Line 0 ←──────────→       Display Line 0
          │                                │
          │ (jumps whole line)             ↓ (one row)
          ↓                          Display Line 1
    Buffer Line 1                          │
                                           ↓ (one row)
                                     Display Line 2
```

Our implementation follows the `gj`/`gk` behavior - cursor navigation operates on display lines.

---

## Key Concept 8: Wide Characters and Emojis

Some characters take **multiple terminal columns**:
- Most ASCII: 1 column
- CJK characters: 2 columns  
- Emojis: typically 2 columns

```
Text:    "😀😀😀"
Columns:  01 23 45   <- each emoji takes 2 columns

At width 4:
│😀😀│  <- display line 0 (2 emojis fit, 4 columns)
│😀  │  <- display line 1 (1 emoji, 2 columns + padding)
```

The `visibleWidth()` function calculates actual display width:

```typescript
import stringWidth from "string-width";

function visibleWidth(str: string): number {
  return stringWidth(str);  // Handles unicode properly
}

visibleWidth("abc");   // 3
visibleWidth("😀");    // 2
visibleWidth("你好");  // 4 (2 per CJK character)
```

**Why this matters for wrapping**: We can't just divide by character count. We must track visual width as we build each slice.

---

## Key Concept 9: Horizontal Wrapping at Boundaries

When you press ← at the start of a display line:
- Move to the **end** of the previous display line

When you press → at the end of a display line:
- Move to the **start** of the next display line

```
│Hello Worl│  <- cursor at 'H' (position 0)
│d, this is│  

Press ←: Nothing happens (already at buffer start)

│Hello Worl│  <- cursor at 'l' (position 9, end of display line 0)
│d, this is│  

Press →: Cursor moves to 'd' (position 10, start of display line 1)
```

---

# Reference

## DisplaySlice Interface

```typescript
interface DisplaySlice {
  text: string;        // The actual text shown on this display line
  bufferLine: number;  // Index into the lines[] array
  startCol: number;    // Buffer column where this slice starts (inclusive)
  endCol: number;      // Buffer column where this slice ends (exclusive)
}
```

## Key Methods

### `findCurrentDisplayLine()`
Returns the index into `displaySlices[]` for the current cursor position.

Logic:
1. Find all slices for current buffer line
2. For non-last slices: cursor belongs here if `startCol <= cursorCol < endCol`
3. For last slice: cursor belongs here if `startCol <= cursorCol <= endCol`

### `moveCursorVertical(delta: number)`
Move cursor up (delta=-1) or down (delta=1) through display lines.

Logic:
1. Find current display line index
2. Calculate new display line index (clamped to valid range)
3. Preserve or use `targetDisplayCol`
4. Clamp target to new slice's valid range
5. Convert back to buffer position

### `moveCursorHorizontal(delta: number)`  
Move cursor left (delta=-1) or right (delta=1).

Logic:
1. Clear `targetDisplayCol`
2. If moving within current slice: just adjust buffer column
3. If at boundary: jump to adjacent display line

### `wrapLineByVisibleWidth(line: string, maxWidth: number)`
Break a logical line into display slices based on visual width.

Logic:
1. Iterate through characters
2. Track cumulative visual width using `visibleWidth()`
3. When width exceeds max, start new slice
4. Return array of `{text, startCol, endCol}`

## State Variables

```typescript
private displaySlices: DisplaySlice[] = [];     // Built during render
private lastRenderWidth: number = 0;            // Terminal width at last render
private targetDisplayCol: number | undefined;   // Sticky column for vertical movement
```

---

# Tutorials

## Tutorial 1: Understanding Buffer vs Display Position

Create a file `tutorial-1-positions.ts`:

```typescript
/**
 * Tutorial 1: Buffer vs Display Positions
 * 
 * This demonstrates the difference between where text lives
 * in memory versus how it appears on screen.
 */

// Simulate a text buffer
const textBuffer = {
  lines: ["Hello World, this is Pi!"],
  cursorLine: 0,
  cursorCol: 0
};

// Simulate display at width 10
const DISPLAY_WIDTH = 10;

function getDisplayLines(text: string, width: number): string[] {
  const result: string[] = [];
  for (let i = 0; i < text.length; i += width) {
    result.push(text.slice(i, i + width));
  }
  return result.length ? result : [""];
}

// Show the difference
const line = textBuffer.lines[0];
const displayLines = getDisplayLines(line, DISPLAY_WIDTH);

console.log("=== BUFFER VIEW ===");
console.log(`Line 0: "${line}"`);
console.log(`Length: ${line.length} characters`);
console.log();

console.log("=== DISPLAY VIEW (width=${DISPLAY_WIDTH}) ===");
displayLines.forEach((dl, i) => {
  console.log(`Display line ${i}: "${dl}"`);
});
console.log(`Total: ${displayLines.length} display lines`);
console.log();

// Track cursor position in both coordinate systems
function showCursorPosition(bufferCol: number) {
  // Find which display line contains this position
  const displayLine = Math.floor(bufferCol / DISPLAY_WIDTH);
  const displayCol = bufferCol % DISPLAY_WIDTH;
  
  console.log(`Buffer position: line=0, col=${bufferCol}`);
  console.log(`Display position: line=${displayLine}, col=${displayCol}`);
  console.log(`Character at cursor: "${line[bufferCol] || '(end)'}"`)
  console.log();
}

console.log("=== CURSOR AT POSITION 0 ===");
showCursorPosition(0);

console.log("=== CURSOR AT POSITION 5 ===");
showCursorPosition(5);

console.log("=== CURSOR AT POSITION 12 ===");
showCursorPosition(12);

console.log("=== CURSOR AT POSITION 22 ===");
showCursorPosition(22);
```

Run it:
```bash
npx tsx tutorial-1-positions.ts
```

---

## Tutorial 2: Building Display Slices

Create a file `tutorial-2-slices.ts`:

```typescript
/**
 * Tutorial 2: Display Slice Mapping
 * 
 * Learn how each display line maps back to buffer positions.
 */

interface DisplaySlice {
  text: string;
  bufferLine: number;
  startCol: number;
  endCol: number;  // Exclusive!
}

function buildDisplaySlices(
  lines: string[],
  width: number
): DisplaySlice[] {
  const slices: DisplaySlice[] = [];
  
  for (let bufferLine = 0; bufferLine < lines.length; bufferLine++) {
    const line = lines[bufferLine];
    
    if (line.length <= width) {
      // Line fits without wrapping
      slices.push({
        text: line,
        bufferLine,
        startCol: 0,
        endCol: line.length
      });
    } else {
      // Line needs wrapping
      for (let pos = 0; pos < line.length; pos += width) {
        const text = line.slice(pos, pos + width);
        slices.push({
          text,
          bufferLine,
          startCol: pos,
          endCol: Math.min(pos + width, line.length)
        });
      }
    }
  }
  
  return slices;
}

// Test it
const lines = [
  "Hello World, this is a long line that will wrap!",
  "Short",
  "Another fairly long line here"
];

const DISPLAY_WIDTH = 15;
const slices = buildDisplaySlices(lines, DISPLAY_WIDTH);

console.log(`=== TEXT BUFFER (${lines.length} logical lines) ===`);
lines.forEach((line, i) => {
  console.log(`  Line ${i}: "${line}" (${line.length} chars)`);
});
console.log();

console.log(`=== DISPLAY SLICES (width=${DISPLAY_WIDTH}) ===`);
slices.forEach((slice, i) => {
  console.log(
    `  [${i}] "${slice.text.padEnd(DISPLAY_WIDTH)}" ` +
    `bufferLine=${slice.bufferLine}, ` +
    `cols=${slice.startCol}-${slice.endCol} (exclusive)`
  );
});
console.log();

// Show how to find which slice contains a cursor position
function findSliceForCursor(
  slices: DisplaySlice[],
  bufferLine: number,
  bufferCol: number
): number {
  for (let i = 0; i < slices.length; i++) {
    const slice = slices[i];
    if (slice.bufferLine !== bufferLine) continue;
    
    // Is this the last slice for this buffer line?
    const isLastForLine = 
      i === slices.length - 1 || 
      slices[i + 1].bufferLine !== bufferLine;
    
    if (isLastForLine) {
      // Last slice: includes endCol position
      if (bufferCol >= slice.startCol && bufferCol <= slice.endCol) {
        return i;
      }
    } else {
      // Non-last slice: exclusive end
      if (bufferCol >= slice.startCol && bufferCol < slice.endCol) {
        return i;
      }
    }
  }
  return -1;
}

console.log("=== FINDING CURSOR POSITIONS ===");
const testPositions = [
  { line: 0, col: 0 },
  { line: 0, col: 14 },
  { line: 0, col: 15 },  // Boundary! Should be in slice 1
  { line: 0, col: 30 },
  { line: 1, col: 3 },
  { line: 2, col: 20 },
];

for (const pos of testPositions) {
  const sliceIdx = findSliceForCursor(slices, pos.line, pos.col);
  const slice = slices[sliceIdx];
  const visualCol = pos.col - slice.startCol;
  
  console.log(
    `  Buffer (${pos.line}, ${pos.col}) → ` +
    `Display slice ${sliceIdx}, visual column ${visualCol}`
  );
}
```

---

## Tutorial 3: Vertical Navigation

Create a file `tutorial-3-vertical.ts`:

```typescript
/**
 * Tutorial 3: Display-Line Vertical Navigation
 * 
 * Implement up/down movement through wrapped text.
 */

interface DisplaySlice {
  text: string;
  bufferLine: number;
  startCol: number;
  endCol: number;
}

interface CursorState {
  bufferLine: number;
  bufferCol: number;
  targetDisplayCol: number | undefined;  // Sticky column
}

class TextBuffer {
  lines: string[];
  cursor: CursorState;
  slices: DisplaySlice[] = [];
  width: number = 0;
  
  constructor(text: string) {
    this.lines = text.split('\n');
    this.cursor = { bufferLine: 0, bufferCol: 0, targetDisplayCol: undefined };
  }
  
  layout(width: number): void {
    this.width = width;
    this.slices = [];
    
    for (let bufferLine = 0; bufferLine < this.lines.length; bufferLine++) {
      const line = this.lines[bufferLine];
      
      if (line.length <= width) {
        this.slices.push({ text: line, bufferLine, startCol: 0, endCol: line.length });
      } else {
        for (let pos = 0; pos < line.length; pos += width) {
          this.slices.push({
            text: line.slice(pos, pos + width),
            bufferLine,
            startCol: pos,
            endCol: Math.min(pos + width, line.length)
          });
        }
      }
    }
  }
  
  findCurrentDisplayLine(): number {
    const { bufferLine, bufferCol } = this.cursor;
    
    for (let i = 0; i < this.slices.length; i++) {
      const slice = this.slices[i];
      if (slice.bufferLine !== bufferLine) continue;
      
      const isLast = i === this.slices.length - 1 || 
                     this.slices[i + 1].bufferLine !== bufferLine;
      
      if (isLast) {
        if (bufferCol >= slice.startCol && bufferCol <= slice.endCol) return i;
      } else {
        if (bufferCol >= slice.startCol && bufferCol < slice.endCol) return i;
      }
    }
    return 0;
  }
  
  moveVertical(delta: number): void {
    const currentIdx = this.findCurrentDisplayLine();
    const currentSlice = this.slices[currentIdx];
    
    // Calculate current display column
    const currentDisplayCol = this.cursor.bufferCol - currentSlice.startCol;
    
    // Initialize or use sticky column
    if (this.cursor.targetDisplayCol === undefined) {
      this.cursor.targetDisplayCol = currentDisplayCol;
    }
    
    // Calculate new display line
    const newIdx = currentIdx + delta;
    if (newIdx < 0 || newIdx >= this.slices.length) return;
    
    const newSlice = this.slices[newIdx];
    const sliceLength = newSlice.endCol - newSlice.startCol;
    
    // Is this the last slice for its buffer line?
    const isLastForLine = 
      newIdx === this.slices.length - 1 ||
      this.slices[newIdx + 1].bufferLine !== newSlice.bufferLine;
    
    // Clamp target column to slice bounds
    const maxCol = isLastForLine ? sliceLength : Math.max(0, sliceLength - 1);
    const targetCol = Math.min(this.cursor.targetDisplayCol, maxCol);
    
    // Update cursor
    this.cursor.bufferLine = newSlice.bufferLine;
    this.cursor.bufferCol = newSlice.startCol + targetCol;
  }
  
  display(): void {
    const currentDisplayLine = this.findCurrentDisplayLine();
    
    console.log(`┌${'─'.repeat(this.width)}┐`);
    for (let i = 0; i < this.slices.length; i++) {
      const slice = this.slices[i];
      let line = slice.text.padEnd(this.width);
      
      // Show cursor if on this line
      if (i === currentDisplayLine) {
        const visualCol = this.cursor.bufferCol - slice.startCol;
        const before = line.slice(0, visualCol);
        const cursor = line[visualCol] || ' ';
        const after = line.slice(visualCol + 1);
        line = before + `\x1b[7m${cursor}\x1b[0m` + after;
      }
      
      console.log(`│${line}│`);
    }
    console.log(`└${'─'.repeat(this.width)}┘`);
    console.log(
      `Buffer: line=${this.cursor.bufferLine}, col=${this.cursor.bufferCol}  ` +
      `Target column: ${this.cursor.targetDisplayCol ?? 'none'}`
    );
    console.log();
  }
}

// Demo
const buffer = new TextBuffer("abcdefghijklmnopqrstuvwxyz\n123");
buffer.layout(10);

console.log("=== INITIAL STATE ===");
buffer.display();

// Move to column 5
buffer.cursor.bufferCol = 5;
buffer.cursor.targetDisplayCol = undefined;
console.log("=== MOVED TO COLUMN 5 ===");
buffer.display();

// Move down
buffer.moveVertical(1);
console.log("=== AFTER DOWN (target col preserved) ===");
buffer.display();

// Move down again
buffer.moveVertical(1);
console.log("=== AFTER DOWN AGAIN (column 5 on short line = clamp to 2) ===");
buffer.display();

// Move down to logical line 2
buffer.moveVertical(1);
console.log("=== AFTER DOWN TO LINE 2 (target col 5 > line length, clamp to 3) ===");
buffer.display();
```

---

## Tutorial 4: Wide Characters

Create a file `tutorial-4-emoji.ts`:

```typescript
/**
 * Tutorial 4: Handling Wide Characters (Emojis)
 * 
 * Learn how visual width differs from string length.
 */

import stringWidth from "string-width";

function visibleWidth(str: string): number {
  return stringWidth(str);
}

console.log("=== CHARACTER WIDTHS ===");
const examples = [
  "a",      // ASCII: 1 column
  "字",     // CJK: 2 columns
  "😀",     // Emoji: 2 columns
  "👨‍👩‍👧‍👦",  // Family emoji (ZWJ sequence): 2 columns
  "Hello",  // 5 chars, 5 columns
  "你好",   // 2 chars, 4 columns
  "😀😀😀", // 3 emojis (6 chars with surrogates), 6 columns
];

for (const str of examples) {
  console.log(
    `"${str}": ` +
    `length=${str.length}, ` +
    `visibleWidth=${visibleWidth(str)}`
  );
}
console.log();

// Wrapping with emojis
interface Slice {
  text: string;
  startCol: number;
  endCol: number;
}

function wrapByVisibleWidth(line: string, maxWidth: number): Slice[] {
  const result: Slice[] = [];
  let currentText = "";
  let currentWidth = 0;
  let currentStart = 0;
  
  // Use Intl.Segmenter to properly iterate graphemes (handles emoji sequences)
  const segmenter = new Intl.Segmenter();
  const graphemes = [...segmenter.segment(line)].map(s => s.segment);
  
  let charIndex = 0;
  for (const grapheme of graphemes) {
    const graphemeWidth = visibleWidth(grapheme);
    
    // Would this grapheme exceed the width?
    if (currentWidth + graphemeWidth > maxWidth && currentText.length > 0) {
      // Save current slice
      result.push({
        text: currentText,
        startCol: currentStart,
        endCol: charIndex
      });
      
      // Start new slice
      currentStart = charIndex;
      currentText = "";
      currentWidth = 0;
    }
    
    currentText += grapheme;
    currentWidth += graphemeWidth;
    charIndex += grapheme.length;  // Note: grapheme.length may be > 1 for emojis
  }
  
  // Don't forget the last slice
  if (currentText || result.length === 0) {
    result.push({
      text: currentText,
      startCol: currentStart,
      endCol: line.length
    });
  }
  
  return result;
}

console.log("=== WRAPPING EMOJIS AT WIDTH 6 ===");
const emojiLine = "😀😀😀😀😀";  // 5 emojis = 10 display columns
const slices = wrapByVisibleWidth(emojiLine, 6);

console.log(`Original: "${emojiLine}"`);
console.log(`String length: ${emojiLine.length}`);
console.log(`Visible width: ${visibleWidth(emojiLine)}`);
console.log();

slices.forEach((slice, i) => {
  console.log(
    `Slice ${i}: "${slice.text}" ` +
    `(width=${visibleWidth(slice.text)}, ` +
    `chars ${slice.startCol}-${slice.endCol})`
  );
});
console.log();

console.log("=== MIXED CONTENT ===");
const mixedLine = "Hi 😀 你好 World!";
const mixedSlices = wrapByVisibleWidth(mixedLine, 8);

console.log(`Original: "${mixedLine}"`);
console.log(`String length: ${mixedLine.length}`);
console.log(`Visible width: ${visibleWidth(mixedLine)}`);
console.log();

mixedSlices.forEach((slice, i) => {
  console.log(
    `Slice ${i}: "${slice.text}" (width=${visibleWidth(slice.text)})`
  );
});
```

---

# How-To Guides

## How to: Implement Display-Line Navigation

### Step 1: Track Display Slices

Store slice information during render:

```typescript
private displaySlices: DisplaySlice[] = [];

private layoutText(width: number): LayoutLine[] {
  this.displaySlices = [];  // Reset
  
  for (let bufferLine = 0; bufferLine < this.state.lines.length; bufferLine++) {
    const line = this.state.lines[bufferLine];
    const slices = this.wrapLineByVisibleWidth(line, width);
    
    for (const slice of slices) {
      this.displaySlices.push({
        ...slice,
        bufferLine
      });
    }
  }
  
  // ... rest of layout
}
```

### Step 2: Find Current Display Line

```typescript
private findCurrentDisplayLine(): number {
  for (let i = 0; i < this.displaySlices.length; i++) {
    const slice = this.displaySlices[i];
    if (slice.bufferLine !== this.state.cursorLine) continue;
    
    const isLast = /* check if last slice for this buffer line */;
    const inRange = isLast
      ? this.state.cursorCol >= slice.startCol && this.state.cursorCol <= slice.endCol
      : this.state.cursorCol >= slice.startCol && this.state.cursorCol < slice.endCol;
    
    if (inRange) return i;
  }
  return 0;
}
```

### Step 3: Implement Vertical Movement

```typescript
private moveCursorVertical(delta: number): void {
  const current = this.findCurrentDisplayLine();
  const currentSlice = this.displaySlices[current];
  
  // Preserve target column on first vertical move
  if (this.targetDisplayCol === undefined) {
    this.targetDisplayCol = this.state.cursorCol - currentSlice.startCol;
  }
  
  const newIdx = current + delta;
  if (newIdx < 0 || newIdx >= this.displaySlices.length) return;
  
  const newSlice = this.displaySlices[newIdx];
  const sliceLength = newSlice.endCol - newSlice.startCol;
  
  // Clamp target to valid range
  const maxCol = /* calculate based on isLastSlice */;
  const col = Math.min(this.targetDisplayCol, maxCol);
  
  this.state.cursorLine = newSlice.bufferLine;
  this.state.cursorCol = newSlice.startCol + col;
}
```

### Step 4: Implement Horizontal Wrapping

```typescript
private moveCursorHorizontal(delta: number): void {
  this.targetDisplayCol = undefined;  // Clear sticky column
  
  const current = this.findCurrentDisplayLine();
  const slice = this.displaySlices[current];
  
  if (delta < 0) {
    // Moving left
    if (this.state.cursorCol > slice.startCol) {
      this.state.cursorCol--;
    } else if (current > 0) {
      // Wrap to end of previous display line
      const prev = this.displaySlices[current - 1];
      this.state.cursorLine = prev.bufferLine;
      this.state.cursorCol = prev.endCol - 1;
    }
  } else {
    // Moving right
    if (this.state.cursorCol < slice.endCol) {
      this.state.cursorCol++;
    } else if (current < this.displaySlices.length - 1) {
      // Wrap to start of next display line
      const next = this.displaySlices[current + 1];
      this.state.cursorLine = next.bufferLine;
      this.state.cursorCol = next.startCol;
    }
  }
}
```

---

## How to: Handle Wide Characters in Wrapping

Use `visibleWidth()` instead of `.length`:

```typescript
import { visibleWidth } from "../utils.js";

private wrapLineByVisibleWidth(
  line: string,
  maxWidth: number
): Array<{ text: string; startCol: number; endCol: number }> {
  const result = [];
  let currentText = "";
  let currentWidth = 0;
  let currentStart = 0;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const charWidth = visibleWidth(char);
    
    if (currentWidth + charWidth > maxWidth && currentText.length > 0) {
      result.push({
        text: currentText,
        startCol: currentStart,
        endCol: i
      });
      currentStart = i;
      currentText = "";
      currentWidth = 0;
    }
    
    currentText += char;
    currentWidth += charWidth;
  }
  
  if (currentText || result.length === 0) {
    result.push({
      text: currentText,
      startCol: currentStart,
      endCol: line.length
    });
  }
  
  return result;
}
```

---

## Glossary

| Term | Definition |
|------|------------|
| **Buffer position** | Character index in the underlying text storage |
| **Display line** | A single row on the terminal screen |
| **Display slice** | A mapping from display line to buffer coordinates |
| **Exclusive end** | endCol points to one past the last character |
| **Logical line** | A line of text terminated by newline or end of text |
| **Sticky column** | Preserved target column for vertical navigation |
| **Visual column** | Cursor's horizontal position on the display |
| **Visual width** | Number of terminal columns a string occupies |
| **Wrap boundary** | Position where text breaks to next display line |

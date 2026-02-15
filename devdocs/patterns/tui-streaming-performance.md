# TUI Streaming Performance: history caching + bounded buffers (Diataxis)

This doc explains *why* the TUI stays fast while streaming model output, and *how* to preserve/extend that performance.

It focuses on two mechanisms:

- **History caching** via `RenderCacheContainer` (cache old messages so streaming doesn’t re-render everything)
- **Bounded streaming buffers** via `StreamingAssistantMessageComponent` (cap the amount of text re-processed per delta)

The examples are grounded in the current code:

- `packages/tui/src/render-cache-container.ts`
- `packages/tui/src/components/markdown.ts`
- `packages/coding-agent/src/tui/streaming-assistant-message.ts`

---

## Tutorial (learn by following an example)

### Example scenario

You have a chat UI with:

- 100 old messages in history (mostly Markdown)
- 1 new assistant message streaming in small chunks (`text_delta` / `thinking_delta`)

Each chunk triggers a UI render.

### What a “frame” means

A render frame is essentially:

1. Walk the component tree and call `render(width)`.
2. Produce `string[]` lines for the whole screen.
3. Diff against the previous frame and write only changed terminal lines.

Streaming turns that into a hot loop: **we may run this hundreds/thousands of times per message**.

### First lever: history caching

`RenderCacheContainer` caches each child’s rendered `string[]` by:

```
(width, revision) -> lines[]
```

A child is cacheable if it implements `getRevision()`.

#### Concrete example: 3 history messages + 1 streaming message

Component tree:

```
RenderCacheContainer
  ├─ Msg#1 (rev=10)
  ├─ Msg#2 (rev=10)
  ├─ Msg#3 (rev=10)
  └─ StreamingMsg (rev increments per delta)
```

Now imagine 5 streaming deltas arrive.

Without history caching:

```
Frame 1: render Msg#1 + Msg#2 + Msg#3 + StreamingMsg
Frame 2: render Msg#1 + Msg#2 + Msg#3 + StreamingMsg
Frame 3: render Msg#1 + Msg#2 + Msg#3 + StreamingMsg
Frame 4: render Msg#1 + Msg#2 + Msg#3 + StreamingMsg
Frame 5: render Msg#1 + Msg#2 + Msg#3 + StreamingMsg
```

With history caching:

```
Frame 1: render Msg#1 + Msg#2 + Msg#3 + StreamingMsg   (fills cache)
Frame 2: reuse Msg#1..3 from cache; render StreamingMsg
Frame 3: reuse Msg#1..3 from cache; render StreamingMsg
Frame 4: reuse Msg#1..3 from cache; render StreamingMsg
Frame 5: reuse Msg#1..3 from cache; render StreamingMsg
```

So the per-delta work becomes proportional to the *one thing that changes*.

#### When the cache correctly invalidates

- **Terminal resize**: the cache key includes `width`, so resize forces a re-render (correct).
- **Theme change / global invalidate**: `RenderCacheContainer.invalidate()` clears caches (correct).

### Second lever: bounded buffers

Streaming can generate very long text. If we naïvely re-render Markdown for the full accumulated text on every delta, we hit a common “quadratic trap”.

#### The quadratic trap (why streaming can slow down over time)

If the visible response grows from length `1 → L`, and each delta causes a full re-parse of the entire string, the total parse work is roughly:

```
parse(1) + parse(2) + ... + parse(L)  ≈ O(L²)
```

This shows up as: “streaming starts fast, then progressively gets slower as the message gets longer”.

#### Bounded buffer strategy (cap the worst case)

`StreamingAssistantMessageComponent` keeps rolling buffers (default `maxBufferChars = 64 KiB`).

Conceptually:

```
buffer = last B characters of streamed text
```

So per-delta work becomes:

```
O(min(currentLen, B))
```

and never exceeds `O(B)`.

#### Tiny example with a cap

Let `B = 10` characters. Incoming chunks:

- delta1: `"hello"`  → buffer: `"hello"`
- delta2: `" world"` → buffer: `"hello worl"` (trim to last 10)
- delta3: `"!!"`     → buffer: `"lo world!!"`

The UI is always rendering “the last window” of the stream.

### How these two levers combine

With both in place, per streaming delta looks like:

```
RenderCacheContainer
  - history: reused from cache (fast)
  - streaming: re-rendered (bounded by maxBufferChars)
```

So your hot loop stays bounded even with long history and long outputs.

---

## How-to guide (apply this pattern in the codebase)

### 1) Add history caching around chat history

**Goal:** streaming updates should not force re-rendering old messages.

Typical pattern:

- Put the chat history messages under a `RenderCacheContainer`.
- Ensure each message component implements `getRevision()` and bumps it only when its content changes.

Checklist:

- [ ] Chat history container is a `RenderCacheContainer` (not a plain `Container`).
- [ ] Each stable message component implements `getRevision()`.
- [ ] Stable messages do **not** bump revision during unrelated events.

### 2) Implement the revision contract correctly

**Goal:** caching must be safe.

Rules of thumb:

- If `revision` doesn’t change and `width` doesn’t change, `render(width)` must return the same output.
- If the component depends on global style/theme, it must bump revision (or the container must invalidate) when that global changes.

### 3) Bound streaming buffers

**Goal:** per-delta work should have a ceiling.

Guidelines for choosing `maxBufferChars`:

- Smaller `B` = faster streaming, less context for Markdown correctness.
- Larger `B` = more correct formatting while streaming, more CPU work per delta.

A reasonable default is what the code uses today: `64 * 1024`.

### 4) Decide whether to render Markdown while streaming

There are two viable streaming strategies:

**A. Stream with `Text`, finalize with `Markdown`**

- Pros: fastest during streaming (no markdown parse per delta)
- Cons: formatting appears “late” (e.g., `---` stays literal until finalize)

**B. Stream with `Markdown`**

- Pros: formatting is stable throughout streaming
- Cons: more CPU per delta; rely on history caching + bounded buffers

In this repo, correctness/UX currently prefers (B).

---

## Reference (quick lookup)

### RenderCacheContainer

File: `packages/tui/src/render-cache-container.ts`

- Caches each child’s rendered output.
- Cache key: `(width, revision)`.
- Requires child implements `RevisionedComponent` (`getRevision()`).
- `invalidate()` clears all caches.

### Markdown component costs

File: `packages/tui/src/components/markdown.ts`

`Markdown.render(width)` does full-string work when the text changes:

- `marked.lexer(normalizedText)` parses the full string.
- Token rendering + wrapping runs over the full output.

`Markdown` has an internal cache, but streaming invalidates it by calling `setText()` repeatedly.

### StreamingAssistantMessageComponent

File: `packages/coding-agent/src/tui/streaming-assistant-message.ts`

Key mechanisms:

- `maxBufferChars`: bounds the rolling buffer size.
- revision increments every time streaming display updates.

---

## Explanation (why this works; causal model)

### The hot-loop multiplier

Streaming is a *high-frequency invalidation loop*.

Even small per-frame costs become large when multiplied by many deltas:

```
(total cost) ≈ (cost per delta) × (number of deltas)
```

### History caching removes the “history size” multiplier

Without caching:

```
cost per delta ≈ sum(render(history messages)) + render(streaming message)
```

With caching:

```
cost per delta ≈ render(streaming message)
```

So the cost no longer scales with the number of old messages.

### Bounded buffers remove the “message length grows forever” multiplier

Markdown parsing/wrapping is essentially whole-string work. If you re-run it for the entire message on every delta, you can get the O(L²) growth pattern.

Bounding transforms it into:

- predictable worst-case cost per delta
- stable streaming responsiveness for long outputs

### What bounded buffers *do not* guarantee

- Streaming markdown correctness for content that depends on context beyond the last `B` characters (e.g., very long code fences).

That’s why the final render path should always render the full message once the stream ends.

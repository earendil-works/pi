# editor-scroll-capture

Capture and verification tooling for the pi Editor's scroll behavior (see issue #8484).

Three pieces:

- **`packages/tui/test/editor-scroll-demo.ts`** — scriptable minimal TUI app on the real
  `TuiMainScreen` + `Editor` stack. Trigger keys simulate app-level editor events:
  `F5` = `setText` rewrite, `F6` = history cycle, `F7` = focus churn,
  `F8` = save/restore, `F9` = submit. Writes a JSONL event log
  (`EDITOR_DEMO_EVENT_LOG`).
- **`capture.py`** — PTY harness. Spawns the demo (or any command) in a
  pseudo-terminal, feeds a scripted scenario, and records the raw ANSI stream
  (via `PI_TUI_WRITE_LOG`), a timed `timeline.jsonl` (in/out bytes), and the
  app event log.
- **`analyze.mjs`** — ANSI virtual-terminal analyzer. Reconstructs the screen
  from `timeline.jsonl`, locates the editor box from its scroll-indicator
  borders (`─── ↑ N more` / `─── ↓ N more`), and reports any frame where the
  editor view jumped to the top while the cursor remained below (scroll-jump
  anomaly).
- **`fuzz-scroll.mts`** — property check: after every random editor operation,
  the rendered output must still contain the reverse-video cursor cell
  whenever the editor holds text (cursor must never be scrolled out of view).

## Requirements

- Node >= 22.19 (type stripping) for the demo and analyzer
- Python 3 (stdlib only) for the capture harness
- The TUI deps installed: `npm install --workspace packages/tui --ignore-scripts`

## Usage

```bash
# 1. capture a scenario (default demo, 100x30 PTY)
python3 scripts/editor-scroll-capture/capture.py \
  --scenario scripts/editor-scroll-capture/scenarios/scroll-attempt1.txt \
  --out /tmp/esc

# 2. analyze the capture
node scripts/editor-scroll-capture/analyze.mjs /tmp/esc

# optional: dump the reconstructed screen (debugging)
node scripts/editor-scroll-capture/analyze.mjs /tmp/esc --dump-screen
node scripts/editor-scroll-capture/analyze.mjs /tmp/esc --dump-at=800

# 3. property-fuzz the editor scroll invariant
node scripts/editor-scroll-capture/fuzz-scroll.mts 2000 42
```

Capture any other command with `--cmd` (e.g. the real `pi`):

```bash
python3 scripts/editor-scroll-capture/capture.py \
  --cmd "pi" --scenario my-scenario.txt --out /tmp/pi-capture
```

## Scenario format

One directive per line (`#` comments allowed):

| directive | meaning |
|-----------|---------|
| `wait <seconds>` | sleep |
| `key <name> [x<count>]` | named key (`up`, `down`, `enter`, `f5`…), repeated |
| `raw <hex>` | raw bytes, e.g. `1b5b41` = CSI A |
| `type <text>` | literal text (`\n` escape = newline) |

## Notes

The analyzer's virtual terminal models DEC autowrap (wrap-pending) so that
full-width lines — the editor borders — are positioned exactly like a real
xterm-style terminal.

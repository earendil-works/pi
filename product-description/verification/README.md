# Hand verification

The feature documents were written from the code and the tests. This directory is the protocol for checking them against the running product, one observable claim at a time.

## What is here

| File | Covers |
| --- | --- |
| [conversation.md](conversation.md) | `foundations/*` and `conversation/*` |
| [sessions.md](sessions.md) | `sessions/*` and `startup/*` |
| [settings.md](settings.md) | `models/*`, `settings/*`, and `cross-cutting/*` |
| `driver/` | A scripted pseudo-terminal driver for the items that can be run without a person at the keyboard; see below. |

Each file has one table per document. Each row is an item with a stable ID (`SHELL-07`, `TURN-12`), a priority, what it needs, the claim with a link to the document section, the setup, numbered steps, the expected result, and a Result column for the tester. Items that cannot be checked by hand (design questions, things that need a product decision) are listed under each document as "Not checkable by hand".

Priorities: **P1** is an established fact, a claim many documents depend on, or a suspected bug; **P2** is an ordinary claim; **P3** is a number, a colour, or a timing.

## How to run a pass

1. Bring up the surface. From the repository root, with dependencies hydrated (`npm ci --ignore-scripts`), run pi from source in a terminal that supports the Kitty keyboard protocol (Kitty, Ghostty, WezTerm, iTerm2), at least 100 columns by 40 rows:

   ```bash
   mkdir -p /tmp/pi-desc-home /tmp/pi-desc-proj && cd /tmp/pi-desc-proj && git init -q
   PI_CODING_AGENT_DIR=/tmp/pi-desc-home PI_OFFLINE=1 /path/to/pi-mono/pi-test.sh --no-env
   ```

   `PI_CODING_AGENT_DIR` keeps your own settings, credentials, and sessions untouched; `PI_OFFLINE=1` suppresses the version check and catalogue refresh so startup is deterministic; `--no-env` strips provider keys from the environment. Items marked `model` need a credential: export one provider key (for example `ANTHROPIC_API_KEY`) and drop `--no-env`. Delete `/tmp/pi-desc-home` between sections that say "fresh home".
2. Confirm the commit. Every document says `Verified against pi-mono commit a69bef789`. Run `git rev-parse --short HEAD`; if it differs, the documents describe a different build and some failures will be drift, not defects.
3. Keep the documents open beside pi. Read the linked section before each item; the item is a summary, the section is the claim.
4. Work through P1 first across all files, then P2, then P3.
5. Record `pass`, `fail`, or `blocked` in the Result column, with a note for anything other than a clean pass. A fail is something the document says that the product does not do; a blocked item could not be run (no credential, no such terminal, a prior failure in the way).
6. File every fail in [`bug-triage.md`](../bug-triage.md): if the entry exists, add a Status line quoting the item ID; if not, add an entry with the item ID under "Raised by". A fail is not automatically a product bug; sometimes the document is wrong, and the fix is to the document. Say which in the Status line.
7. When every P1 and P2 item for a document has passed or been filed, change its row in the [coverage table](../README.md#coverage) from `drafted` to `verified`.

## Devices and conditions

The Device column uses these values:

- `keyboard`: any terminal with the Kitty keyboard protocol. The default.
- `model`: a real provider credential is needed, because the item is about a response, a tool call, a retry, or compaction. Responses are not deterministic; items say "a response" and check structure, timing, and state, not wording. Set a low thinking level to keep them fast.
- `legacy terminal`: a terminal without the Kitty protocol (Apple Terminal, xfce4-terminal), for the items about Shift+Enter and Alt+Enter fallbacks.
- `images`: a terminal that draws inline images (Kitty, Ghostty, iTerm2).
- `second process`: a second pi started on the same session or directory, for the items about interleaving and locks.
- `network`: the ability to cut the network mid-response (pull the cable, toggle Wi-Fi); a firewall rule is a poor substitute because an in-flight stream is not always cut by it.
- `signals`: a second shell to send `kill -TERM`, `kill -HUP`, or `kill -KILL` to the pi process.
- `clipboard`: a local terminal with a working system clipboard (not SSH).
- `macOS` / `Windows` / `Linux`: platform-specific items.

Traps: `PI_OFFLINE=1` also skips the `fd`/`rg` download, so start once without it (or with network) to have `@` completion. A fresh home has no `bin/` until then. `--no-env` is a flag of `pi-test.sh`, not of pi. Timing windows (500 ms) are hard to hit by hand; use the driver for those.

## Driving the product from a script

`driver/drive.py` runs pi under a pseudo-terminal from a JSON scenario (a list of keystrokes and waits, with named snapshots of the byte stream), and `driver/render.mjs` replays a snapshot through a headless xterm to print the screen as text. Together they check anything that shows on screen, timing-sensitive sequences (the 500 ms double-press windows, Escape during a running shell command), and what is on disk afterwards. They do not check colours (the rendering is plain text), animation (the spinner is captured as whichever frame was last drawn), or how anything feels. Key tokens: `{CR}`, `{ESC}`, `{C-c}`, `{C-d}`, `{S-CR}`, `{A-CR}`, `{A-UP}`, `{UP}`, `{DOWN}`, `{TAB}`, `{BTAB}` (Shift+Tab), `{C-o}` and any `{C-x}`, `{A-x}`.

The driver answers the terminal queries pi sends at startup (Kitty protocol flags 7, a VT220 device attribute, a cell size), so pi treats the pseudo-terminal as a modern terminal. `render.mjs` needs `@xterm/headless`; `npm install @xterm/headless` in the `driver/` directory once (it is the version the TUI's own tests use).

```bash
python3 driver/drive.py scenario.json out/
node driver/render.mjs out/01-startup.bin 100 40
```

Use the driver to observe, and a real terminal to confirm anything about colour, images, focus, or feel.

## Results so far

A first scripted pass was run on 2026-08-23 against commit `a69bef789` with the driver above: two scenarios at 100×40, no credentials (`--no-env`), `PI_OFFLINE=1`, a fresh `PI_CODING_AGENT_DIR`, and (in the second) a scratch `HOME` so the user's own `~/.agents/skills` did not appear. It observed: the startup header and the no-credential warning; the footer with no credential; `!`, `!!`, a running and a cancelled shell command, and a bare `!`; Ctrl+C once and twice; the double-Escape tree; Ctrl+O on the header; Shift+Enter, Ctrl+W/Ctrl+Y, a large paste and its marker; the `/` popup and `@` completion; `/hotkeys`, `/session`, `/name`, `/settings`, `/thinking`, Ctrl+L, Shift+Tab; and what the run left on disk. It marked about sixty of the 662 rows across the three checklists `pass (driver)` or `partial (driver)` and corrected five claims in the documents before they were committed (the no-credential messages and footer, the `/` list's first item, `fd` on `PATH`, the `[Skills]` block from the home directory). Items needing a model, images, a legacy terminal, a second process, signals, or the clipboard were not run; `sessions.md` rows were run only for the unsaved-session refusals, `/new`, the empty `/resume` picker, `/quit now`, `--help`, and a missing `@file`. The scripted pass did not observe colours, the spinner's animation, or timing feel. No document is marked `verified`: every document has `model` items that were not run.

Two driver caveats found on the way: Escape must be sent as its own step (a key in the same write is read as an Alt chord, which is pi's documented Escape-timing behaviour, not a bug), and `HOME` must be a scratch directory or the real home's `~/.agents/skills` and `AGENTS.md` are loaded.

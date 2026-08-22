#!/usr/bin/env python3
"""
capture.py — PTY capture harness for the pi Editor scroll bug.

Spawns a TUI app (default: the editor-scroll-demo) inside a pseudo-terminal,
feeds scripted keystrokes, and captures:
  - the raw ANSI stream pi writes (via PI_TUI_WRITE_LOG, pi's built-in logger)
  - the raw PTY output bytes (belt-and-braces fallback)
  - app-level event log (demo app writes JSONL to EDITOR_DEMO_EVENT_LOG)

Scenario format (one directive per line, '#' comments allowed):
  wait <seconds>            sleep
  key <name> [x<count>]     send a named key (see KEY_SEQUENCES) count times
  raw <hex>                 send raw bytes (hex, e.g. 1b5b41 = CSI A)
  type <text>               type literal text (UTF-8, newlines as \\n escape)

Example scenario (repro the suspected rewrite/scroll interaction):
  wait 0.5
  key end
  key up x10
  wait 0.2
  key f5
  wait 0.5
  key f8
  wait 0.5
  key ctrl+c

Usage:
  python3 scripts/editor-scroll-capture/capture.py \
      --scenario scenarios/scroll-rewrite.txt \
      --out /tmp/editor-scroll-capture
"""
from __future__ import annotations

import argparse
import os
import pty
import select
import signal
import sys
import time

KEY_SEQUENCES = {
    "up": b"\x1b[A",
    "down": b"\x1b[B",
    "right": b"\x1b[C",
    "left": b"\x1b[D",
    "enter": b"\r",
    "tab": b"\t",
    "esc": b"\x1b",
    "home": b"\x1b[H",
    "end": b"\x1b[F",
    "pgup": b"\x1b[5~",
    "pgdn": b"\x1b[6~",
    "f5": b"\x1b[15~",
    "f6": b"\x1b[17~",
    "f7": b"\x1b[18~",
    "f8": b"\x1b[19~",
    "f9": b"\x1b[20~",
    "ctrl+c": b"\x03",
    "ctrl+z": b"\x1a",
    "ctrl+l": b"\x0c",
    "backspace": b"\x7f",
    "delete": b"\x1b[3~",
}


def parse_scenario(path: str) -> list[tuple[str, ...]]:
    directives: list[tuple[str, ...]] = []
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            directives.append(tuple(line.split()))
    return directives


def encode_directive(directive: tuple[str, ...]) -> bytes:
    kind = directive[0]
    if kind == "key":
        name = directive[1]
        count = 1
        for tok in directive[2:]:
            if tok.startswith("x") and tok[1:].isdigit():
                count = int(tok[1:])
        seq = KEY_SEQUENCES.get(name)
        if seq is None:
            raise ValueError(f"unknown key: {name}")
        return seq * count
    if kind == "raw":
        return bytes.fromhex(directive[1])
    if kind == "type":
        text = " ".join(directive[1:]).replace("\\n", "\n")
        return text.encode("utf-8")
    raise ValueError(f"unknown directive: {kind}")


def main() -> int:
    parser = argparse.ArgumentParser(description="PTY capture harness for pi editor scroll bug")
    parser.add_argument("--scenario", required=True, help="scenario file")
    parser.add_argument("--out", default="/tmp/editor-scroll-capture", help="output directory")
    parser.add_argument(
        "--cmd",
        default=None,
        help="command to run (default: demo app via node22 + ts-strip)",
    )
    parser.add_argument("--cols", type=int, default=100)
    parser.add_argument("--rows", type=int, default=30)
    parser.add_argument("--timeout", type=float, default=30.0, help="hard timeout seconds")
    parser.add_argument("--demo-text", default=None, help="initial editor text file for the demo")
    parser.add_argument("--demo-rewrite", default=None, help="F5 rewrite text file for the demo")
    args = parser.parse_args()

    os.makedirs(args.out, exist_ok=True)
    ansi_log = os.path.join(args.out, "ansi.log")
    pty_log = os.path.join(args.out, "pty-raw.log")
    event_log = os.path.join(args.out, "events.jsonl")
    timeline_log = os.path.join(args.out, "timeline.jsonl")
    scenario_log = os.path.join(args.out, "scenario.txt")

    with open(scenario_log, "w", encoding="utf-8") as f:
        f.write(open(args.scenario, encoding="utf-8").read())

    if args.cmd:
        cmd = args.cmd
    else:
        node = os.environ.get("PI_NODE", "node")
        repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        demo = os.path.join(repo, "packages", "tui", "test", "editor-scroll-demo.ts")
        cmd = f"{node} {demo}"

    env = os.environ.copy()
    env["PI_TUI_WRITE_LOG"] = ansi_log
    env["EDITOR_DEMO_EVENT_LOG"] = event_log
    if args.demo_text:
        env["EDITOR_DEMO_TEXT_FILE"] = args.demo_text
    if args.demo_rewrite:
        env["EDITOR_DEMO_REWRITE_FILE"] = args.demo_rewrite
    env["TERM"] = env.get("TERM", "xterm-256color")
    env["COLORTERM"] = env.get("COLORTERM", "truecolor")

    directives = parse_scenario(args.scenario)
    print(f"[capture] cmd: {cmd}")
    print(f"[capture] out: {args.out}")

    tl_start = time.monotonic()

    def tl(kind: str, hexdata: str) -> None:
        with open(timeline_log, "a", encoding="utf-8") as f:
            f.write(f'{{"t": {round((time.monotonic() - tl_start) * 1000, 1)}, "dir": "{kind}", "hex": "{hexdata}"}}\n')


    pid, fd = pty.fork()
    if pid == 0:  # child
        os.environ.update(env)
        # window size
        import fcntl
        import struct
        import termios

        winsize = struct.pack("HHHH", args.rows, args.cols, 0, 0)
        fcntl.ioctl(sys.stdout.fileno(), termios.TIOCSWINSZ, winsize)
        os.execvp("/bin/sh", ["/bin/sh", "-c", cmd])
        os._exit(127)

    # parent
    with open(pty_log, "wb") as ptyf:
        start = time.monotonic()
        deadline = start + args.timeout
        for directive in directives:
            if time.monotonic() > deadline:
                print("[capture] TIMEOUT reached; aborting scenario")
                break
            kind = directive[0]
            if kind == "wait":
                time.sleep(float(directive[1]))
                continue
            payload = encode_directive(directive)
            print(f"[capture] -> {directive}")
            os.write(fd, payload)
            tl("in", payload.hex())
            # drain available output for a short window so renders settle
            drain_for(fd, ptyf, 0.05, tl)
        # give the app a moment to settle, then terminate
        drain_for(fd, ptyf, 0.5, tl)
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass

    print(f"[capture] done. ANSI log: {ansi_log} ({os.path.getsize(ansi_log)} bytes)")
    print(f"[capture] PTY log: {pty_log} ({os.path.getsize(pty_log)} bytes)")
    print(f"[capture] timeline: {timeline_log}")
    if os.path.exists(event_log):
        print(f"[capture] event log: {event_log} ({os.path.getsize(event_log)} bytes)")
    return 0


def drain_for(fd: int, ptyf, seconds: float, tl=None) -> None:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            ptyf.write(data)
            ptyf.flush()
            if tl is not None:
                tl("out", data.hex())
        else:
            # idle wait consumed the remainder of the window
            break


if __name__ == "__main__":
    sys.exit(main())

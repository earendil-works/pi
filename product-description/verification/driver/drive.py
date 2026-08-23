#!/usr/bin/env python3
"""Drive pi under a pseudo-terminal from a scenario file.

Usage: drive.py <scenario.json> <outdir>

scenario.json: {"cols": 100, "rows": 40, "env": {...}, "cwd": "...", "argv": [...],
                "steps": [{"wait": 6.0}, {"keys": "!echo hi\r", "wait": 2.0, "snap": "after-echo"}, ...]}

Each step may have "keys" (sent verbatim; use \x1b for Escape, \r for Enter, \x03 for Ctrl+C,
\x04 for Ctrl+D, \x1b[13;2u for Shift+Enter, \x1b[13;3u for Alt+Enter), "wait" seconds to
collect output, and "snap" a name: the full byte stream so far is written to <outdir>/<name>.bin.
The final stream is written to <outdir>/final.bin. Exit status and any stderr are reported.
"""
import fcntl, json, os, pty, select, signal, struct, sys, termios, time

TOKENS = {
    "ESC": "\x1b", "CR": "\r", "TAB": "\t", "BTAB": "\x1b[Z",
    "S-CR": "\x1b[13;2u", "A-CR": "\x1b[13;3u", "C-CR": "\x1b[13;5u",
    "UP": "\x1b[A", "DOWN": "\x1b[B", "LEFT": "\x1b[D", "RIGHT": "\x1b[C",
    "A-UP": "\x1b[1;3A", "A-DOWN": "\x1b[1;3B", "HOME": "\x1b[H", "END": "\x1b[F",
    "BS": "\x7f", "DEL": "\x1b[3~", "S-L": "L", "S-T": "T",
    "PASTE": "\x1b[200~", "/PASTE": "\x1b[201~",
}

def expand_keys(s):
    """Expand {ESC}, {CR}, {C-c}, {A-CR}, {S-CR}, {UP}, ... tokens into bytes."""
    out, i = [], 0
    while i < len(s):
        if s[i] == "{":
            j = s.find("}", i)
            if j > i:
                name = s[i + 1:j]
                if name in TOKENS:
                    out.append(TOKENS[name]); i = j + 1; continue
                if name.startswith("C-") and len(name) == 3:
                    out.append(chr(ord(name[2].lower()) - 96)); i = j + 1; continue
                if name.startswith("A-") and len(name) == 3:
                    out.append("\x1b" + name[2]); i = j + 1; continue
        out.append(s[i]); i += 1
    return "".join(out)

scenario = json.load(open(sys.argv[1]))
outdir = sys.argv[2]
os.makedirs(outdir, exist_ok=True)
cols, rows = scenario.get("cols", 100), scenario.get("rows", 40)

pid, fd = pty.fork()
if pid == 0:
    env = dict(os.environ)
    env.update(scenario.get("env", {}))
    env["TERM"] = env.get("TERM", "xterm-256color")
    env["COLUMNS"], env["LINES"] = str(cols), str(rows)
    os.chdir(scenario.get("cwd", os.getcwd()))
    argv = scenario["argv"]
    os.execvpe(argv[0], argv, env)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
stream = bytearray()
log = []

def collect(seconds):
    end = time.time() + seconds
    while True:
        remaining = end - time.time()
        if remaining <= 0:
            return
        r, _, _ = select.select([fd], [], [], min(remaining, 0.1))
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return
            if not data:
                return
            stream.extend(data)
            # Answer the Kitty keyboard protocol query and the primary DA so pi
            # believes it has a capable terminal: "\x1b[?u" -> reply flags 7;
            # "\x1b[c" -> reply VT220. Cell size query (\x1b[16t) -> reply 8x16.
            if b"\x1b[?u" in data:
                os.write(fd, b"\x1b[?7u")
            if b"\x1b[c" in data:
                os.write(fd, b"\x1b[?62;c")
            if b"\x1b[16t" in data:
                os.write(fd, b"\x1b[6;16;8t")
            if b"\x1b[14t" in data:
                os.write(fd, b"\x1b[4;640;800t")

for i, step in enumerate(scenario["steps"]):
    if "resize" in step:
        c, r = step["resize"]
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))
        os.kill(pid, signal.SIGWINCH)
    if "signal" in step:
        os.kill(pid, getattr(signal, step["signal"]))
    if "keys" in step:
        os.write(fd, expand_keys(step["keys"]).encode("utf-8"))
    collect(step.get("wait", 1.0))
    if "snap" in step:
        with open(os.path.join(outdir, step["snap"] + ".bin"), "wb") as f:
            f.write(stream)
        log.append(f"snap {step['snap']} after step {i} ({len(stream)} bytes)")

with open(os.path.join(outdir, "final.bin"), "wb") as f:
    f.write(stream)

status = "running"
try:
    wpid, st = os.waitpid(pid, os.WNOHANG)
    if wpid == pid:
        status = f"exited {os.waitstatus_to_exitcode(st)}"
except ChildProcessError:
    status = "reaped"
if status == "running":
    os.kill(pid, signal.SIGKILL)
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    status = "killed at end of scenario"
print("\n".join(log))
print("process:", status)

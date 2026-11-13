# tui (launcher)

The trusted side of a terminal client (slice 11 §4, decision "Slice 11, P8"; p2's `tui-client.ts`, `tui-sandbox.ts`,
`tui-bootstrap.mjs`, `tui-filter.ts`): `@earendil-works/chord/tui/launcher`. Needs Node 26.5.1 or later (the Node its
sandbox was checked on); `requireSandboxNode` refuses older ones with a clear error.

```ts
const terminal = await startTerminal({
	url: "http://127.0.0.1:8788",
	credentials: { kind: "file", path: "~/.acme/owner-token" },   // or { kind: "token", token }, { kind: "pairing", label, save? }
	mode: "dark", colors: "truecolor",                              // the terminal's background and colours
	locales: ["de-DE"],                                             // the user's languages: the system locale by default
});
process.exitCode = await terminal.exited;
```

- **Credentials** (`credentials.ts`): the launcher keeps the token; pairing asks for a code, shows it, polls every 2 s
  until the owner approves it, and may save the token (created, mode 0600).
- **The sandbox** (`sandbox.ts`): a Node child process of the launcher's binary, in two layers:
  - the operating system's: stdin, stdout and stderr pipes to the launcher (no descriptor of the child is a terminal),
    an empty environment (but `LD_LIBRARY_PATH` when the launcher has one: it needed it to run the same binary), a
    private directory holding only the bootstrap; `--permission` allowing only reading the bootstrap's file (no other
    file, no network, child processes, workers, addons, inspector or WASI), `--no-experimental-sqlite` (SQLite opens
    files past the permission model), a 96 MiB heap. The bootstrap is a file, not `-e`, which puts every builtin on
    `globalThis`;
  - JavaScript's, a second layer: only the bootstrap evaluates downloaded code (the base bundle, at most 8 MiB, a
    CommonJS script; the plugins' registered scripts through the bridge's `evaluate`), with `vm.Script` (options of no
    prototype, no dynamic import callback: `import()` throws) and a `require` (and `process.getBuiltinModule`)
    answering a short list of builtins that compute in memory (`SANDBOX_BUILTINS`, looked up in an object of no
    prototype); `process` is a frozen plain object with `SANDBOX_PROCESS` only; the bootstrap keeps its own references
    to what it uses, and Node's `process` has its listener calls as own properties (changing the shared
    `EventEmitter.prototype` catches nothing: Opus E2); every prototype of Node's `process`, `Object.prototype`
    included, takes no new property and keeps its own ones (a getter for a property Node reads on its process, such as
    `noDeprecation`, would get the real one: Opus E7);
  - messages both ways as length-prefixed binary frames (`pipe.ts`: a header as JSON, the text or bytes as body), each
    at most 17 MiB; the launcher checks every message and ends a sandbox sending a malformed one or not reading;
  - known gaps, each needing the JavaScript layer broken first unless noted: the child may signal the user's processes
    (Node has no permission for signals; the launcher ignores SIGUSR1, which would open its inspector: Opus E8), read
    the machine's details (`os`), and learn whether any path exists (`require.resolve` fails one way for a file that
    exists, another for one that does not: Opus E13, a Node gap); memory outside its heap has no limit (only the child
    dies).
- **The launcher** (`launcher.ts`): downloads `/_chord/tui/start`, the base bundle and the combined file with the token
  (each body read up to 8 MiB, no further); gives the sandbox input (raw mode on a TTY) and resizes; writes its frames
  through the output filter; opens and relays its link sockets to `/chord` (the token in the upgrade's header; at most
  four at once); answers its fetches of terminal files only (`terminalFile`: the path resolved first, then
  `/_chord/tui/<file>` or `/_chord/tui/plugin/<file>` of the server's origin); starts a new sandbox only when the server's
  base bundle is another than the running one; prints the server's text (a pairing code, which must be a plain code)
  through the filter; at its end resets the terminal's modes (sync, mouse, focus, paste, cursor, alternate screen,
  colours, scroll region, autowrap), also when its process exits without that end; answers at most eight requests of
  the sandbox at once (more are refused at once); ignores SIGUSR1 while it runs (no inspector opened by a signal).
  Nothing the sandbox sends ends the launcher: a send on a socket not yet open is dropped, a socket with 16 MiB waiting
  is closed, a message it fails on ends the client.
- **The output filter** (`filter.ts`): text and drawing sequences pass (cursor moves, erasing, SGR colours, the alternate
  screen, bracketed paste, sync, mouse reporting); OSC (the clipboard among them), DCS and other control strings,
  other modes and ESC sequences are dropped; an unterminated sequence ends with its frame; frames above 64 KiB are
  dropped (the sandbox splits a large write into frames between sequences: `src/tui/frames.ts`).
- **Actions** (`actions.ts`), each confirmed on the launcher's prompt (the bottom lines, black on white after a reset
  of all attributes, whatever the sandbox left; `y`): one at a time (a second request is refused at once); from the
  request to the action's end the sandbox's frames are held (1 MiB at most); while the prompt is open its keys go to
  it, and those in its first 300 ms are ignored (typed for the sandbox); a synchronized update the sandbox began is
  closed and the prompt drawn last (again after a resize); its lines are wrapped to the terminal's width, never cut (a
  prompt taller than the terminal is refused). Afterwards the held frames are written and the sandbox asked to redraw.
  `copy` shows the text (five rows, then how many more characters) and refuses control and bidirectional characters (a
  newline and a tab aside), then the launcher writes OSC 52. `open` takes http and https URLs without user info, names
  the host first, and opens with `open`, `xdg-open` or `rundll32 url.dll,FileProtocolHandler` (as the coding agent),
  never through a shell. `attach` refuses a path with control, format or unusual whitespace characters (on Windows
  also UNC, device and `//host` paths and reserved device names), shows the path resolved by its text (its name, then
  its directory) without looking at the machine, after a yes resolves its links and asks again when they lead
  elsewhere, then opens it without blocking (no wait on a FIFO) and reads it only when it is the file confirmed (its
  device and inode as when the last prompt was shown: no parent directory swapped for a link meanwhile) and a regular
  file of at most 16 MiB, at the size its open handle had; one refusal for anything else. While a prompt is open,
  Ctrl-C ends the client.
- **The way out:** three Ctrl-C within a second always end the client (exit code 130, the terminal reset), whatever the
  sandbox does; each still reaches the sandbox, so an app that handles Ctrl-C itself works as before.

Tests: `test/node/tui/` (the launcher and sandbox ones under `CHORD_TUI_NODE` or `node26`; skipped without).

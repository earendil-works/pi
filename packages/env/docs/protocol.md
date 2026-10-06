# pi-env wire protocol

Version 1. The client starts `pi-env serve --token <hex>` (over `ssh`, or directly in tests) and talks to it over the
process's stdin and stdout. stderr is diagnostic text for logs only.

## Sync

Shell startup files may print to stdout before the daemon runs. The daemon's first output is the line
`PI-ENV <token>\n`, with the token from its command line. The client discards everything before that line. After it,
stdout carries only frames.

## Frames

Every frame, in both directions:

```text
u32 length      bytes after this field
u8  type
u32 id          request id; 0 for frames that belong to no request
u32 jsonLength
json            UTF-8 JSON object, jsonLength bytes
bytes           raw payload, the remaining length - 9 - jsonLength bytes
```

All integers are big-endian. A frame is at most 16 MiB; larger transfers are split by the client. A request whose JSON
does not parse gets an `EINVAL` error; framing errors end the connection.

| type | name | direction | meaning |
|---|---|---|---|
| 1 | request | client → daemon | `json.op` names the operation |
| 2 | result | daemon → client | success of request `id`; the request is finished |
| 3 | error | daemon → client | failure of request `id`; the request is finished |
| 4 | event | daemon → client | progress of a running request (`exec` output, `watch` changes), not finishing it |
| 5 | cancel | client → daemon | cancel request `id`; see below |
| 6 | ping | both | liveness; the receiver ignores it |

Errors are `{ code, message, syscall?, path? }`. `code` is a Node-style error code (`ENOENT`, `EISDIR`,
`ERR_FS_EISDIR`, ...) or one of the execution codes `shell_unavailable`, `spawn_error`, `timeout`, `aborted`, `unknown`.
Messages are diagnostic; only codes are part of the contract.

Paths are absolute JSON strings; the client resolves relative paths, `~` and `file://` URLs before sending. Strings are
sent well-formed (lone surrogates become U+FFFD) and encoded as UTF-8, as Node encodes string paths and arguments. File
contents and output travel as raw payload bytes.

## Cancellation

A cancel names one request. The daemon registers each request before running it, so a cancel sent right after its
request is never lost. `exec` kills the command's process group and finishes with `aborted`; `{ mode: "kill" }` kills
without aborting, so the command finishes with the killed process's status, as `cleanup()` does. `scanLines` stops
between chunks with `aborted`. `watch` stops and finishes with `{}`. Other operations are short and finish normally.

## Scheduling

File operations run on a fixed pool of worker threads; `exec` and `watch` run on their own threads. Chunk writes to one
handle run in arrival order. Results, errors, pings and `watch` events are sent before queued command output, and
results with payloads above 64 KiB queue behind output too, so a slow link delays bulk data, not replies. Output of a
command without an output window waits while more than 4 MiB of output is unsent, which slows the command as a full
pipe would.

## Liveness

Each side sends `ping` every 5 seconds. The daemon kills every process group it started and exits after 30 seconds
without receiving any bytes, or when stdin ends. A dropped connection therefore stops remote commands. The client
fails requests of a lost connection with `{ code: "unknown", lost: true }` and starts a new daemon on the next request;
handles belong to the daemon that opened them, so requests on them fail instead of reaching the new one.

## Operations

`hello { protocol }` → `{ protocol, version, os, arch, home, tmpdir, cwd, driveCwds, pid }`. The first request.
`version` is the npm package version the daemon shipped with; `os` and `arch` are Rust's `std::env::consts` values;
`tmpdir` follows the remote Node's `os.tmpdir()` rules; `cwd` and `driveCwds` (Windows' `=C:` variables) are what
Node's `path.resolve` falls back to for drive-relative paths.

File operations take `{ path }` (and the listed fields) and return `{}` unless noted:

| op | fields | result |
|---|---|---|
| `lstat` | | `info` |
| `realpath` | | `{ path }` |
| `write` | `append`, `parents?` (default true), `keep?`, payload | creates missing parents like Node's recursive `mkdir`, opens like `writeFile` (`w`) or `appendFile` (`a`), writes the payload; with `keep`, `{ handle }` for `writeChunk` |
| `writeChunk` | `handle`, payload | appends to a kept write handle; after a failed chunk, later chunks fail with `EBADF` |
| `truncate` | `size` | |
| `fsync` | | |
| `rename` | `to` | |
| `mkdir` | `recursive` | |
| `rm` | `recursive`, `force` | Node `fs.rm` semantics |
| `mkdtemp` | (`path` is the prefix) | `{ path }` |
| `open` | `noFollow`, `mode?` | `{ handle, info }` for `openBinaryReader`: nonblocking, regular files only. With `mode: "read"`, Node's `open(path, "r")` of any file, blocking: `{ handle, stat }` or `{ handle, statError }` |
| `pread` | `handle`, `offset?`, `length` | payload; without `offset`, one read at the current position |
| `fstat` | `handle` | `info` |
| `scanLines` | `handle`, `startLine`, `endLine?` | `LineScan` |
| `opendir` | | `{ handle }` |
| `readdir` | `handle`, `max` | `{ entries, done }` |
| `close` | `handle` | |

`info` is `{ name, kind, size, mtimeSec, mtimeNsec, dev, ino }` with `kind` one of `file`, `directory`, `symlink`, `other`.
`readdir` entries are `{ name, raw?, info }` or `{ name, raw?, error }` when the entry's `lstat` failed. Names are
decoded as UTF-8 with replacement characters, and lstat'ed under that name, as Node does; `raw` holds the original
bytes of a name that is not valid UTF-8, for sorting. Handles are numbers, valid until `close` or the end of the
connection; opening more than 4096 fails with `EMFILE`.

`exec { command | argv, cwd, env, inheritEnv, shellPath?, timeoutMs?, spill?, window? }` runs a shell string or an
argv array. While it runs, `event` frames `{ kind: "output", stream, skipped? }` carry decoded output text as UTF-8
payload. With `window { maxBytes, maxLines, minIntervalMs, bytesPerSecond }`, output is coalesced and paced like the
caller's commits, at most one output frame per command is unsent, and output followed by more than the window is
replaced by `skipped { bytes, newlines, endsWithNewline }` on the next event, which carries all output after it
(`ShellOutputInfo.skipped`). The result is `{ exitCode, spillPath? }`; failures are errors with codes `timeout` or
`aborted` (carrying `spillPath`), `shell_unavailable`, `spawn_error`, or `unknown` (spill failure).

`watch { targets, mode?, pollIntervalMs?, maxDirectories? }` runs Durable's `NodeFileWatcher` in the daemon. `targets`
are `{ path, recursive, exclude: { hidden, names } }`. Once coverage is established, an event `{ kind: "ready", mode }`
follows; then `{ kind: "change", paths }` or `{ kind: "change", overflow: true, mode: "polling" }` (native watching
failed), or `{ kind: "error", code, message }`, after which nothing follows. The request lasts until cancelled.
Failing to establish coverage is an error of the request.

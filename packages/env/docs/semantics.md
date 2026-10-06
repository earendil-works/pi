# Semantics

The reference is Durable's `NodeExecutionEnv` (`packages/durable/src/env/node.ts`) on the remote machine. Durable's
env conformance suite and `test/differential.test.ts` check each rule below.

## Split of work

| Concern | Where |
|---|---|
| Path resolution: `~` (remote home), `file://`, relative to `cwd`; on Windows drive-relative paths against the remote's working directories | client, the remote system's `path` rules |
| Abort checkpoints of each method | client, as `NodeExecutionEnv` |
| Error code mapping (`ENOENT` → `not_found`, ...) | client, as `NodeExecutionEnv`'s `toFileError` |
| `readFile`'s read sizes, size limit and decoding (`StringDecoder`, byte-order mark kept) over the daemon's `open(path, "r")` | client |
| `writeFile` in 512 KiB writes with an abort check before each; `appendFile` without checks | client, over one open file |
| Line reader | client, positional reads and Durable's `StreamDecoder` |
| Watching: snapshots, native events, polling | daemon, a port of Durable's `NodeFileWatcher` |
| Timeout validation, result precedence (callback error, timeout, abort, spill failure, exit code) | client |
| System calls, processes, spill files, line scans | daemon |
| Command output decoding: per stream, WHATWG UTF-8, only a leading byte-order mark dropped | daemon (`encoding_rs`) |

## Rules the standard libraries do not follow

- Recursive `mkdir`: an existing directory is fine, an existing file fails with `EEXIST`, a file in the way of a parent
  fails with `ENOTDIR`. Writes create missing parents this way.
- `rm`: a missing path fails unless `force`; a directory without `recursive` fails with `ERR_FS_EISDIR`
  (`FileError` code `unknown`).
- `mkdtemp`: `mkdtemp(3)` of `<tmpdir>/<prefix>XXXXXX`; the prefix is joined with POSIX `path.join`, so `../x` works.
- `tmpdir`: `TMPDIR`, `TMP`, `TEMP`, then `/tmp` (Termux: `$PREFIX/tmp`), trailing slash removed.
- `listDir`: names in byte order, like libuv's `scandir`; fails if any entry cannot be lstat'ed. `openDirReader` keeps
  directory order, skips entries removed meanwhile, and fills each page after skipping. Names that are not UTF-8 are
  decoded with replacement characters and lstat'ed under that name, so they fail with `ENOENT` as in Node.
- `openBinaryReader`: nonblocking open; directories fail with `is_directory`, other non-regular files with `invalid`;
  `noFollow` refuses a final symbolic link (`O_NOFOLLOW`).
- `readBinaryFile`, `readTextFile` and `openTextLineReader` open any file like `open(path, "r")`: `/dev/null` reads
  empty, a FIFO blocks until it has a writer, and a directory fails when read (a line reader at `readLine`). A regular
  file is read up to its size at open; other files to their end.
- `readBinaryFile` returns a `Buffer`, reader reads a plain `Uint8Array`, as Node does.
- Windows: error codes are libuv's translations; `rm` of a symbolic link or junction to a directory removes the link;
  creating a file where a directory exists fails with `EISDIR`; modification times before 1970 are negative.

## Commands

- A string runs through the shell: a configured `shellPath` that does not exist (following links) fails with
  `shell_unavailable`; otherwise `/bin/bash`, `which bash`, then `sh`, with `-c`. An argv array runs its program
  directly; on Windows it is searched like libuv does (working directory, then `PATH`, adding `.com` and `.exe`), and
  batch files are refused.
- The working directory must exist (`spawn_error`).
- Environment: with `inheritEnv` (default), the daemon's environment, then `shellEnv`, then `env`; without it, only
  `env`.
- Each command gets a new session (process group), default signal dispositions and an empty signal mask. Timeout,
  abort and `cleanup()` kill the group with `SIGKILL`.
- After the process exits, output is still collected until both pipes end, or 100 ms pass without output; the timeout
  still applies meanwhile. The pipes are closed when the command settles, even if a descendant keeps them open.
- An abort settles as `aborted`; `cleanup()` kills without aborting, so the command settles with exit code 137.
- A process killed by a signal reports `128 + signal`.
- Spill: once the output crosses `spill.afterBytes` or `spill.afterLines` (counted over raw chunks in arrival order, as
  Node counts), the complete raw output goes to `pi-output-<uuid>.log` in a fresh `tmp-` directory.

## Watching

- The daemon runs Durable's `NodeFileWatcher` next to the files: native events (inotify, FSEvents) only trigger a
  debounced rescan, and changes are the difference between snapshots plus the event paths. Reads are not events.
- Windows and network or FUSE file systems poll, as `NodeExecutionEnv` does; running out of native watches switches to
  polling and reports `overflow`.
- When the connection is lost, the client opens the watcher again once a new daemon starts and reports `overflow`.

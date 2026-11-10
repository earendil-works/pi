# Changelog

## [1.5.2] - 2026-11-10

## [1.5.1] - 2026-11-09

### Added

- The daemon's `process` operation runs a program with plain pipes for stdin, stdout and stderr, for programs that speak a protocol on stdin and stdout such as MCP servers: `processWrite` and `processCloseStdin` feed its stdin in arrival order, output arrives as raw bytes per stream, and cancelling, a lost connection or the program's own exit kills its process group (on Windows, its job object), so a wrapper such as `npx` that exits leaves nothing running. `hello` reports it in `features`. `openProcess()` returns a `RemoteProcess`; daemons released before it fail the open with `not_supported`. Unlike terminals, it works on Windows too.

### Fixed

- An aborted or timed-out request no longer waits for a remote host that does not answer: aborting while the connection starts rejects at once with `aborted`, a sent request settles as `aborted` if the daemon does not answer its cancel within a second, `RemoteExecutionEnv.exec` enforces its timeout locally as well, and file operations stop waiting for the connection when aborted. `ssh` gets `ConnectTimeout=15`, so a host that is down fails a start within 15 s.
- On Windows, an `exec` command's output readers stop once the command has settled, also while a descendant keeps a pipe open without writing; they stayed blocked until it exited, because cancelling a blocked read did not reach the standard library's overlapped pipe I/O.

## [1.5.0] - 2026-11-02

### Breaking Changes

- `RemoteWatcher` follows Durable's `FileWatcher`: `close(context)` is `stop(context)`, and its changes are tagged (`{ kind: "paths", paths }`, `{ kind: "overflow" }`, `{ kind: "failed", error }`). The daemon's `watch` protocol is unchanged. Migration: `await watcher.close(ctx)` becomes `await watcher.stop(ctx)`; test `change.kind` instead of `"overflow" in change` or `"error" in change`.

### Fixed

- `exec` and `pty` fail with `spawn_error` instead of hanging when the daemon cannot start a helper thread (for example at a cgroup task limit); the started command is killed and reaped ([#11433](https://github.com/earendil-works/pi/issues/11433)).
- `Connection.close()` on Unix no longer leaves running commands behind: the daemon used to die from the client's `SIGTERM` before killing its process groups. It now kills them on `SIGTERM`, `SIGINT` or `SIGHUP` before exiting.

## [1.4.0] - 2026-10-21

## [1.3.0] - 2026-10-15

## [1.2.0] - 2026-10-12

### Added

- The daemon's `listFiles` operation: a bounded, cancellable, gitignore-aware listing of a directory tree (files, directories and unfollowed symlinks); `hello` reports it in `features`, and older daemons answer `not_supported` without a request.
- `RemoteExecutionEnv.listFiles` and `LocalExecutionEnv`, a local `ExecutionEnv` on a pi-env daemon connection with the same operations.
- `nodePlatform(info)` maps the daemon's platform and architecture names to Node's.
- Pseudo-terminals for interactive programs: the daemon's `pty`, `ptyWrite`, and `ptyResize` operations stream raw terminal output as events, write input in arrival order, send `SIGWINCH` on resize, and kill the process group on cancel or a lost connection. `openTerminal()` returns a `RemoteTerminal`, and `localDaemon()` starts the daemon for this machine. Unix only; Windows answers `ENOTSUP`.
- `RemoteTerminal.foreground()` (daemon `ptyForeground`) reports the process group in front of a terminal when it is not the program's own, such as a job its shell runs, with the leader's name on macOS and Linux (`TerminalForeground`).

## [1.1.0] - 2026-10-07

## [1.0.4] - 2026-10-05

### Added

- Initial release of `@earendil-works/pi-env`: `RemoteExecutionEnv`, a Durable `ExecutionEnv` on another machine, and `Connection` to the `pi-env` daemon that runs there. Results match `NodeExecutionEnv` on that machine on Linux, macOS, Android and Windows. The daemon watches files natively (polling on Windows and network file systems), honors output windows so dropped command output is not transferred, and keeps control replies ahead of bulk output; watchers report `overflow` and resume after a lost connection.
- SSH bootstrap: `connectSsh` detects the remote system, deploys the daemon this package ships for it (named by its SHA-256 and verified before every start), and connects; `sshConnection` does the same lazily at the first operation, so building an environment never needs the network without forwarding, shared connections or configured commands; `loginShell` starts it through the user's login shell, and Termux hosts get setup warnings. `scanHostKey`, `acceptHostKey` and `forgetHostKey` manage trusted host keys; a changed key is never accepted without removing the old one.

# Changelog

## [Unreleased]

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

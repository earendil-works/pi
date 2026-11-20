# p3

One Pi per person: a server on your machine with a worker per session, and the command `p3` that runs it. The
successor of p2 (Pi Mobile) on Chord v2, built in slices; so far it is headless (no page yet). Node 26.3.1 or newer.

## The command

```text
p3                 start the Pi's server in the background unless it runs; print its port and an owner link
p3 server          run the server in the foreground
p3 status          whether it runs: its port, pid, data directory, version and start time
p3 stop            stop it; returns once it is gone
p3 restart         stop, then start in the background
p3 apply           build the plugins changed since the start or the last apply, and roll them out
p3 list            the Pis on this machine and their state
```

A Pi is its data directory: `~/.pi/p3/<name>` for `--pi <name>`. Without an option it is the default Pi, named
`default` (`~/.pi/p3/default`), on port 8789. `--dir <path>` is a Pi in any directory whose path is short enough for
its sockets (a socket path holds at most 108 bytes on Linux and Android, 103 on macOS; the longest is a session's
lock, `<data directory>/locks/<16 characters>`, so a data directory's path has at most 85 bytes, 80 on macOS); a
longer one is refused at the start. Every Pi but the default takes a free port at its first start and keeps it
(`pi.json`). `--port <n>` names the port for one start.

Pis on one machine keep their own sessions, sign-ins and cookie, but a browser does not keep them apart: it sends the
cookies of every Pi on `127.0.0.1` to every port there (cookies are scoped by host, not port), so any server on this
machine the browser visits sees every Pi's sign-in cookie (ERNDL-706 redesigns the sign-in).

The command talks to its Pi's server over a socket in the data directory (`server.sock`; the directory is private),
not over HTTP, and sends no token: the trust boundary is the OS user. Every process of the owner's user may stop,
apply or ask for an owner link (the owner's programs, plugins, an agent's tools); no other user can. This holds on
POSIX systems (Linux, macOS, Android) only; on Windows the socket is a named pipe every local user can reach, so p3
does not protect a Pi there yet (ERNDL-1059).

The background server runs under a supervisor that starts it again after a crash (a server whose store failed exits
with an error for that); what it prints is in
`<data directory>/logs/server.log`. The owner link signs a browser in once and is valid for ten minutes; `p3` prints a
fresh one each time.

## Plugins

A plugin imports p3's API and nothing else: `@earendil-works/p3/v1` (every host kind), `/v1/server`, `/v1/worker`;
its own tests also `/v1/testing` (`testPlugin`: one facet built as production builds it, on a host of its own). The
package ships the API's types and source, so a plugin outside this repository type-checks against an installed p3,
runs its tests against it, and "go to definition" lands in the API's code. `p3 apply` (or a restart) loads a
changed plugin.

## In the repository

- `docs/`: start at `docs/README.md`: the guides for building a package (process, building on Chord, testing, performance), names, and the record (decisions, slice briefs).
- `src/`: base code (a restart changes it), only what must exist before plugins load: the process entries (`bin.ts`,
  `server.ts`, `worker.ts`, `supervisor.ts`), the Pis and their data directories (`files.ts`), the sockets that are the
  locks and the command's channel (`local-socket.ts`), what p3 is (`app.ts`: its API, kinds and principals), and the
  API (`src/api/v1/`). Everything else is a plugin.
- `plugins/`: everything else, one directory per plugin.
- `test/`: tests of the whole (the topology of hosts in one process, end to end against real processes, the command,
  the query plans), their harness (`topology.ts`, `support.ts`, `until.ts`) and the tests' own plugin root
  (`test/plugins/`); a plugin's own tests sit in its `test/` folder.

From this directory, with Node 26.3.1 or newer: `npm run check`, `npm test`; `node --conditions=source
--disable-warning=ExperimentalWarning src/bin.ts server --dir <path>` runs the server from source. A local
release (p3 built, packed and installed outside the repository as it would ship, then tested): from the repository root,
`npm run release:p3:local -- --out /tmp/p3-release --force [--bench]`; the command is then `/tmp/p3-release/p3`.

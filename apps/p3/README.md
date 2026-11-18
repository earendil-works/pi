# p3

One Pi per person: a server on your machine with a worker per session, and the command `p3` that runs it. The
successor of p2 (Pi Mobile) on Chord v2, built in slices; so far it is headless (no page yet). Node 24.4 or newer.

## The command

```text
p3                 start the Pi's server in the background unless it runs; print its port and an owner link
p3 server          run the server in the foreground
p3 status          whether it runs: its port, pid, data directory, version and start time
p3 stop            stop it; returns once it is gone
p3 restart         stop, then start in the background
p3 list            the Pis on this machine and their state
```

A Pi is its data directory. Without an option that is `~/.pi/p3`, on port 8789. `--pi <name>` is a second Pi in
`~/.pi/p3/pis/<name>`, `--dir <path>` one in any directory; each takes a free port at its first start and keeps it
(`pi.json`). `--port <n>` names the port for one start. Pis on one machine share nothing: each has its own sessions,
sign-ins and cookie.

The background server runs under a supervisor that starts it again after a crash; what it prints is in
`<data directory>/logs/server.log`. The owner link signs a browser in once and is valid for ten minutes; `p3` prints a
fresh one each time.

## Plugins

A plugin imports p3's API and nothing else: `@earendil-works/p3/v1` (every host kind), `/v1/server`, `/v1/worker`.
The package ships the API's types and source, so a plugin outside this repository type-checks against an installed
p3 and "go to definition" lands in the API's code.

## In the repository

- `docs/`: the working set (`docs/README.md`): overview, names, workflow, decisions, slice briefs.
- `src/`: base code (a restart changes it): the process entries (`src/bootstrap/`: `bin.ts`, `server.ts`,
  `worker.ts`, `supervisor.ts`), the principal, the API (`src/api/v1/`), the kit (`src/kit/`).
- `plugins/`: everything else, one directory per plugin.
- `test/`: tests of the whole (topology, end to end, the command) and of the kit (`test/kit/`); a plugin's own tests
  sit in its directory.

From this directory, with Node 24: `npm run check`, `npm test`; `node --conditions=source
--disable-warning=ExperimentalWarning src/bootstrap/bin.ts server --dir <path>` runs the server from source. A local
release (p3 built, packed and installed outside the repository as it would ship, then tested): from the repository root,
`npm run release:p3:local -- --out /tmp/p3-release --force [--bench]`; the command is then `/tmp/p3-release/p3`.

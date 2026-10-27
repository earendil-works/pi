# @earendil-works/pi-env

Remote execution environments for [Pi Durable](../durable): an agent's tools run on another machine, usually over SSH,
while the Durable worker, its storage and credentials stay local.

- `pi-env` (`daemon/`): a small Rust program that runs on the remote machine. It speaks a framed protocol on stdin and
  stdout ([docs/protocol.md](docs/protocol.md)) and performs file operations and commands there.
- `RemoteExecutionEnv`: a Durable `ExecutionEnv` that talks to the daemon through a `Connection`. Its results match
  `NodeExecutionEnv` running on the remote machine; only error messages may differ
  ([docs/semantics.md](docs/semantics.md)).

```ts
import { acceptHostKey, connectSsh, RemoteExecutionEnv, scanHostKey, sshConnection } from "@earendil-works/pi-env";

const target = { host: "gpu-box", knownHostsFile: "/data/ssh/known_hosts", hostKeyAlias: "pi-env-gpu" };
// Once: show the host's key fingerprint to the owner, who compares it out of band and accepts it.
const { lines, fingerprints } = await scanHostKey(target);
await acceptHostKey(target, lines);

// Detects the remote system, deploys the daemon if missing (named by its SHA-256 and verified before every start),
// and returns a connection that starts it over ssh.
const { connection } = await connectSsh(target);
const env = new RemoteExecutionEnv({ connection, id: "pi-env:gpu", cwd: "/home/me/project" });

// Or lazily: nothing happens until the first operation, which detects, deploys and connects. A failure (no network,
// untrusted host key) is that operation's error, and the next operation tries again.
const lazy = sshConnection(target);
const lazyEnv = new RemoteExecutionEnv({ connection: lazy.connection, id: "pi-env:gpu", cwd: "/home/me/project" });
```

The package ships the daemon for every supported remote system in `bin/`. `ssh` runs with `BatchMode`, strict host-key
checking against the application's own known-hosts file under a fixed alias, no forwarding of any kind, no shared
connections or configured commands, and without forwarding the local locale. On Windows, detection and deployment go
through PowerShell, and the daemon starts through the server's default shell (cmd.exe or PowerShell).

`env.listFiles(path, options, context)` lists the tree below a directory in the daemon, as `fd --hidden --exclude .git`
does without following symbolic links: files, directories and links as relative `/` paths, skipping what git ignores
inside work trees, bounded by `maxEntries`, `maxBytes` and `timeoutMs` with a `truncated` flag, and stopped by aborting
the context. It is Durable's optional `ExecutionEnv.listFiles`. A daemon released before it reports `not_supported`
(`hello.features` lacks `listFiles`), and callers fall back to their own walk. For local sessions,
`LocalExecutionEnv` is `NodeExecutionEnv` plus `listFiles` through a daemon on the same machine:

```ts
const local = new Connection({ command: [localDaemon()] }); // owned by the caller; close() it at shutdown
const env = new LocalExecutionEnv({ cwd: "/home/me/project", connection: local });
const listing = await env.listFiles(".", { exclude: ["node_modules"] }, context);
// { ok: true, value: { entries: [{ path: "src", kind: "directory" }, { path: "src/a.ts", kind: "file" }], truncated } }
```

`nodePlatform(await connection.info())` gives the remote system in Node's names (`win32`, `darwin`, `x64`, `arm64`),
as `process.platform` and `process.arch` spell them.

`openTerminal(connection, options)` runs a program, by default the user's login shell, in a pseudo-terminal of the
daemon: raw output, input, resizing and its exit code, for interactive terminals. `localDaemon()` is the daemon for this
machine, for terminals without SSH (`new Connection({ command: [localDaemon()] })`). Terminals are not supported on
Windows yet.

Supported remote systems: Linux, macOS, Android (Termux) and Windows, on x86-64 and arm64. On Windows, string commands
run through Git Bash as `NodeExecutionEnv` runs them there; argv commands run directly.

## Development

`npm run build:daemon` builds the daemon with Cargo; the tests talk to `daemon/target/debug/pi-env` over a pipe, or to
the binary named by `PI_ENV_DAEMON` (CI tests the release builds this way). They run Durable's env conformance suite
against `RemoteExecutionEnv` and compare random operation sequences and Durable's tools against `NodeExecutionEnv` on
the same machine. `test/ssh-external.test.ts` runs the suite over a real SSH server when `PI_ENV_SSH_HOST` is set.


# Machines, Files, Models {#p2-machines lede="Environments, workspace, terminals, session files, ports and Radius, models and logins, prompt resources, logs, reload and the shells: the rest of p3."}

The last domains are the ones that touch the outside world: other machines over SSH, the file system and git,
terminals, the relay, model providers and their credentials. Most of them are native objects, and most of them are
places where p2 has the same thing several times (four SSH connections to one environment, five notice channels,
three copies of the environment config parser). The rule that fixes that is the one from chapter XVIII: one owner per
thing.

## Environments

The **envs plugin** owns the environment configuration: name, host, user, port, identity file, shell and its
variables, plus a managed ed25519 key per environment and its own `known_hosts` (kept apart from the user's, aliased
per environment name).

| Function | Owner and form |
| --- | --- |
| list, add, edit, delete (refused while a session, archived too, uses it) | `Envs` on the server: a persisted document behind an owner-only view |
| validation (no leading `-`, no whitespace or control characters in host and user) | the view's methods, before the write |
| a hand-edited `envs.json` is picked up; an invalid file keeps the last valid set and shows an error | a native file watcher (poll fallback) in the envs store; one writer (#21) |
| environment revision: a hash of the config, part of its identity | a derive |
| connection test (connect, deploy the daemon, platform, latency, warnings) | a job; the result per revision in a document |
| unknown or changed host key: fingerprints, trust after confirmation, forget | a flow (chapter XII) on the server |
| browse directories (`~`, relative paths, at most 10k scanned, 1,000 shown) | a method with a **call-scoped** SSH session (chapter IX) or the pooled connection |
| a changed environment restarts its sessions' workers once idle | a routine on the envs store and the status reports |

**Execution in the agent.** The worker's harness asks `HarnessEnvironments` for an environment per target (chapter
XIV). The envs plugin contributes it from its worker facet: local execution at the session's cwd, or a remote one over
SSH through the `pi-env` daemon, deployed per platform and connecting at the first operation. A remote session never
falls back to local tools. The environment follows `SessionLocation`: after a move, the old connection closes once
the move has committed and watchers reopen at the new location.

```ts
// envs/worker.ts
export default defineFacet((host, self) => {
  const location = self.get(SessionLocation, { session });
  const pool = self.get(EnvPool, {});                              // one owner of SSH connections (#20)
  self.contribute(HarnessEnvironments, (target) =>
    target.env === "local" ? localEnv(target.cwd) : pool.environment(target.env, target.cwd));
});
```

:::review | Review: connection pools (#20)
SSH connections to one environment exist four times in p2 (worker environment, browse connection, test connection,
terminal host). `design.md` §26 asks for one owner with a pool or deliberate per-use connections. `EnvPool` above is
the first option: a native object that closes idle connections after 10 minutes and invalidates them on a config or
key change. Reloading the plugin that owns the pool kills running remote commands (chapter XV), so it should change
rarely.
:::

## Workspace and file index

The **workspace plugin** serves the viewed conversation's working tree (a subagent's own cwd included) on the worker:
list a folder (at most 2,000 entries, `.git` hidden), read a file (1 MiB, binary detected), git status, diff, log and
single commits, literal text search, and all paths for name filtering. Every query is a **method returning data**, not
state: results are bounded and requested by the UI. Only change notifications are state: a counter in a document,
bumped by a native watcher of the tree, `HEAD`, the index and config (debounced 100 ms); viewers reload what they show
when it changes.

Two rules live in one place each instead of three:

- **Confinement:** path rules, a canonical root, no `.git`, the app's private data directory denied (also excluded
  from search). One helper used by listing, reading, uploads and the file index.
- **Git hardening:** no optional locks, no fsmonitor, filters disabled, no prompts or pager, no system config, 10 s
  timeout, output caps.

Downloads (25 MiB, byte ranges for media) go through the HTTP component (chapter XIII) with a route on the server that
reads chunks from the worker; uploads into the project use the chunked protocol of chapter XIII (1 MiB chunks, temp
file then rename, never overwrite, writes serialized). Guest read gets no workspace: the view has no variant for it.

The **file index** for `@` completion belongs to the same owner, so completion consumes the index instead of scanning
on its own: built from the environment's listing (else git or a walk, at most 50k paths), rebuilt at most once per
second while files change, discarded after a move. Review comments drafted on files and diffs are browser state until
sent; sending them is an ordinary `Conversation.send`.

## Terminals

Terminals must survive server and worker restarts, so their PTYs live in a **detached terminal host process**, one per
data directory, with its own process lock; it exits after 10 minutes with no terminals and no clients. The terminals
plugin on the server is the owner the UI talks to: list (title, cwd, environment, size, exit status), open at the
session's cwd and environment (refused for archived sessions), attach, close (asking first if a foreground job runs).
Terminals are **owner only**.

Bytes do not go over object links. Attaching opens a **channel** (chapter XIII) with a single-use token (30 s): JSON
control on the object, bytes on the channel, with its own acknowledged window (256 KiB, acknowledgements per 64 KiB; a
viewer that falls behind gets a fresh screen snapshot; an 8 MiB backlog disconnects). Attaching gets the current
screen from a headless emulator with 10k lines of scrollback.

:::review | Review: the terminal host process (#23)
The terminal host runs its own code. Is it part of the revision, reloaded or restarted with it (and running terminals
end), or deliberately outside it with a "host runs older code" notice as in p2? Open in `design.md` §26.
:::

## Session files

Attachments (25 MiB, at most 20 per message), sent-file snapshots made by the agent's `send_file` tool, versioned
artifacts (HTML, SVG, Markdown, text; 2 MiB; each update a new immutable version) and shell spill files are all
per-session bytes with caps, immutable ids and range reads; p2 has two upload routes, two caps and two directory
layouts for them. The proposal is one owner:

```ts
export const SessionFiles = remote("p3.session-files", {
  version: 1,
  input: obj({ session: str() }),
  placement: () => Server(),                                  // readable without a worker
  variants: { writer: { … }, reader: { … }, worker: { … } },
});
```

`SessionFiles { session }` on the server holds the index (per kind, readable without a worker), the chunked upload
and read protocol, the caps per kind, copying on clone and fork, and deletion with the session. Attachments are copied
into a remote environment before an input is admitted, with no fallback on failure. Artifact previews run in a
sandboxed frame with its own CSP and no app identity; ordinary file previews allow only safe types.

:::review | Review: session files (#17)
Proposed in `design.md` §26, not decided. Open sub-points: one preview limit (p2 has 256 KiB for sent files and
512 KiB for artifacts), what a fork copies of the artifact list, and how attachments are copied into remote
environments. Related: #22, whether on-disk layouts such as downloads and uploads get versions like documents.
:::

## Ports and Radius

The **radius plugin** keeps the outbound relay connection, a native in a host-lifetime object on the server: sign-in
by device code from the CLI (credential in a private file), token refresh, a heartbeat in the link adapter (20 s ping,
60 s timeout; TCP does not notice a sleeping laptop), backoff from 1 to 30 s, a disable switch. The relay delivers two
kinds of channels:

```ts
// radius/server.ts (the entry point: one line, as in chapter I)
radius.onChannel((ws) => host.accept(webSocketLink(ws), { principal: { kind: "owner", access: "relay" } }));
radius.onForward((channel) => proxyToForward(channel, host.registry(RadiusForwards).value));
```

Object links become owner principals with `access: "relay"`: owner, but treated as remote (no localhost-only
powers). p2 had to fake a loopback request with a secret header for this; with `accept` that is gone.

Forward channels go to `localhost:<port>` (Host, Origin and Location rewritten; 502 when nothing listens; anonymous
visitors only to public forwards). Which forwards exist is not radius's business: it owns a registry,
`radius.forwards`, and the **ports plugin** contributes its forwards (at most 50, random ids, a public toggle that
needs confirmation, an agent tool `ports` for top-level owner-initiated conversations). Without the ports plugin the
table is empty and radius still works: an optional dependency is a registry owned by the dependent (chapter XIII). The
ports plugin closes forwards of archived sessions with a routine on `catalog.sessions` (chapter XIX).

:::review | Review: may a plugin call `accept`?
`design.md` §3 shows the Radius line in the server's start code and calls entry points "app or adapter code". If
radius is a plugin, its facet needs the host's `accept`, which no other part of this guide gives a plugin. The
alternative is that the start code keeps the entry point and gets channels from the radius object. Not specified.
:::

## Models and credentials

The **models plugin** owns the model runtime (pi-ai's models with custom providers and the model cache) in a
host-lifetime object, and the credentials. It contributes the runtime to `HarnessModels` (chapter XIV), so after a
models reload the next request uses the new runtime while a running stream finishes on the old one. **Credentials
never go to clients**: the views expose providers, login methods and which type is signed in, never tokens. Every
secret is registered for redaction in one place, the log capture.

Views: a model catalog for pickers (names, ids, context windows, thinking levels; at most 300 matches in the web),
logout (refused during a login), refresh a provider's model list. The default model and the cycling scope are
settings (chapter XVIII).

### Login

A login is the guide's flow example (chapter XII): a **job** on the server that runs pi-ai's login, and a flow that
shows its steps to the starting owner.

```ts
const LoginJob = defineJob("models.login", {
  version: 1, args: obj({ provider: str(), type: AuthType }), progress: LoginState, result: obj({ ok: bool() }),
  concurrency: 1,                                                    // one login at a time on the server
});

const login = self.job(LoginJob, {
  run: async ({ provider, type }, ctx) => {
    await runtime.value.login(provider, type, {
      signal: ctx.signal,                                            // 10 minute deadline, cancel, leaving
      prompt: (prompt) => steps.ask(prompt, ctx),                    // text, secret, select, manual_code
      notify: (event) => steps.notice(event, ctx),                   // info, auth_url, device_code, progress
    });
    return { ok: true };
  },
  finish: async (done, tx) => { /* record the outcome; refresh the model list */ },
});
```

`prompt` is a promise-based callback inside the work; the resolver stays in the job (`steps.ask` records the step in
the flow state and waits for `answer`), and nothing crosses an object boundary. On a relayed connection the device
code method is selected automatically. The flow is visible only to the owner principal that started it; others are
refused. Leaving ends it: when the starting owner's references are all gone (presence, not an unmount), a routine
aborts the job. Codes, URLs and typed secrets are redacted from logs.

## Prompt resources

`AGENTS.md`, skills and templates are read in the session's environment, watched (poll fallback, last valid state),
and expanded on the worker before sending. The **prompt plugin** owns them per session on the worker, contributes the
system prompt section and skills to `HarnessExtensions` as readable contributions (a change recomposes), and exposes a
readiness readable: the first input of a fresh worker waits until it is ready (chapter XIX). After a move the watchers
reopen at the new location.

## Code mode

Code mode is a plugin (chapter XIV): its `pi-codemode` sandbox is a native; scripts call tools as nested Durable calls
and replay after a restart; the tool entry looks up the current sandbox when it starts. A reload seals and drains the
old sandbox for at most 30 s. The on/off switch is a setting.

## Logs and notices

**Log capture** tees stdout and stderr of the server, workers and detached hosts without changing their behaviour,
redacts known secrets and credential patterns, and keeps bounded rings (at most 128 sources, 1,000 lines or 256 KiB
each). Detached hosts publish redacted snapshots to a private file. Logs are read without waking a stopped worker.
**Notices** are the one channel from chapter XVIII; dismissal stores only notice ids.

## Dev and reload

The dev plugin is chapter XV's reload control for p3: a source watcher marks plugins dirty and never applies anything;
the `reload_plugins` agent tool and a control in the owner's shell reload the changed plugins, or restart all hosts for
base code (through the supervisor, reopening the sessions that were running). UI bundles are published only after a
successful backend change; a web page detects a new manifest and reloads with its drafts and navigation state saved;
the TUI swaps its sandboxed UI code with a snapshot of its state. A local Unix socket (`0700`) accepts development
commands without a network admin port.

## The shells

The web and TUI shells are UI facets over the objects above. Two rules matter for Chord:

- **UI state survives navigation, reload and reconnect on purpose.** Composer drafts, pending sends with their request
  ids, reading positions and review drafts are kept in tab storage or the TUI's replacement snapshot. A reconnect
  re-holds and gets snapshots; nothing is lost that was not in flight.
- **Leaving is never derived from an unmount.** A plugin reload remounts components (chapter XV). Cancelling a login,
  closing an overlay or giving up a lease is an explicit action or a dropped reference.

The TUI launcher keeps downloaded UI code in a permission-dropped worker with no access to files, network or
credentials; local side effects (copy, upload, download, open a URL, an external editor) need a real user gesture or a
confirmation. That is app code around Chord, not part of it.

## Transport

The last domain, transport, is chapter XVII: one message format, per-part limits (16 MiB compressed and 64 MiB decoded
on client WebSockets, instead of p2's 1 MiB input cap and 32 pending calls), one byte window per link, re-holds with
snapshots after a reconnect, and a protocol version that makes an outdated web page reload.

:::note | Built so far
None of p3 exists. pi-ai's login API, pi-codemode and the `pi-env` daemon exist and are used by p2 today; the HTTP
component and channels are deferred until after the kernel's first real proof (chapter XIII).
:::

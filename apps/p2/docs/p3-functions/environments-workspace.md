# Functionality map: environments, execution, terminals, workspace, file index, ports, radius remote access

Read-only map of what the app must do in environments, execution, terminals, workspace, file index, ports and remote access, drawn from the p2 code.

**Legend.** Who: O = owner; GR = guest read; GW = guest with write access; W = session worker; S = system. Where: Srv = server; Wkr = session worker; Web; TUI; Rem = remote env; Host = detached terminal host. Durability: E = ephemeral; R = until restart; P = persisted; T = transcript-bound.

### Environments (local, SSH)

| domain | function | data | durability | who | where | depends on |
|---|---|---|---|---|---|---|
| env | list configured remote envs with config, test result, session count | ≤ tens × ~300 B | P (config), R (test) | O | Srv, Web, TUI | session catalog |
| env | add or edit env: name, host, user, port, identity file, shell path, login shell, shell env vars | ~300 B each | P | O | Srv, Web | validation |
| env | validate: name format; no leading `-`, whitespace or control chars in host/user; no `"` in identity file | – | – | S | Srv | – |
| env | invalid config file keeps last valid set and shows an error | error string | R | O | Srv, Web, TUI | config watch |
| env | config file edited by hand is picked up (file watch, polling fallback) | – | R | S | Srv | file watch |
| env | delete env, refused while any session (archived too) uses it; removes its managed key | – | P | O | Srv, Web | session catalog |
| env | env revision = hash of config; part of env identity ("same id sees same files") | 12 hex chars | derived | S | Srv, Wkr | – |
| env | generate an ed25519 key per env, kept in the private data dir, adopted as identity file; existing key kept | key files | P | O | Srv, Web | key tool |
| env | upload a private key (≤ 16 KiB, passphrase keys refused), derive the public key | key files | P | O | Srv, Web | key tool |
| env | show the public key to install on the host (lookup debounced 300 ms) | ~100 B | – | O | Web | – |
| env | connection test: connect like a session (detect, deploy daemon, start), latency, platform, arch, home, version, watch mode, warnings | ~500 B | R (per revision) | O | Srv, Web, TUI | SSH, daemon deploy |
| env | unknown or changed host key: show fingerprints, trust after confirm, or forget | key lines | P (own known_hosts) | O | Srv, Web, TUI | test |
| env | host keys kept apart from the user's known_hosts, aliased per env name | file | P | S | Srv, Host | – |
| env | warm SSH connections of all envs when the folder picker opens (drop?: opens every env, even unused ones) | – | E | O | Srv | browse connection |
| env | browse an env's directories: `~` and relative paths, symlinks followed, ≤ 10k entries scanned, ≤ 1000 shown, "truncated" flag | ≤ ~100 KB | E | O | Srv, Web | browse connection |
| env | browse this device's directories (same caps) | same | E | O | Srv, Web | – |
| env | one shared browse connection per env, closed after 10 min idle or on config/key change | SSH connection | R | S | Srv | – |
| env | recent directories per env offered in the picker | from session list | derived | O | Web | session catalog |
| env | resolve a working directory for a new or moved session, optionally create it, check it is a directory | path | – | O | Srv | browse connection |
| env | TUI `/envs`: list, mark current, Enter moves the session, Ctrl+T test, Ctrl+K review host key, Ctrl+F forget | – | E | O | TUI | relocation, test |
| env | sessions on a changed env restart their worker once idle (no running tasks, same generation) | pending map ~ sessions × 40 B | R | S | Srv | worker status, catalog |
| env | separate copy of test results (drop?: duplicates the persisted test state) | – | R | S | Srv | – |
| env | worker opens an env-config watcher it never reads (drop?: unused) | watcher | R | S | Wkr | – |
| env | full list as a method next to the live list (drop?: same data as the live state) | – | – | O | Srv | – |

### Execution

| domain | function | data | durability | who | where | depends on |
|---|---|---|---|---|---|---|
| exec | local execution env at the session cwd | – | R | W | Wkr | – |
| exec | remote execution env over SSH (pi-env daemon), connects at first operation; offline is that operation's error | SSH connection | R | W | Wkr, Rem | env config, daemon deploy |
| exec | a remote session never falls back to local tools; unknown env refuses | – | – | S | Wkr | – |
| exec | daemon binary per remote platform/arch, deployed over SSH; local dev build or override variable | binaries ~ MB | P (remote) | S | Wkr, Host, Rem | – |
| exec | subagent with its own cwd on the same connection | – | R | W | Wkr | – |
| exec | path rules of the remote OS (Windows/POSIX), remote home `~` | – | – | S | Wkr | connection |
| exec | prompt names the SSH host the tools run on | string | – | S | Wkr | env config |
| exec | move a session between this device and envs, or between directories: history stays, files not copied; refused while work runs (fence) | location | P | O | Srv, Wkr, Web, TUI | dir resolve, idle check |
| exec | after a move, watchers reopen at the new location; old envs close after commit | – | R | S | Wkr | location change |
| exec | private data dir denied to file views on this device (canonical check) | path | – | S | Wkr | – |
| exec | active calls counted so a move or idle stop waits | counters | R | S | Wkr | – |

### Terminals

| domain | function | data | durability | who | where | depends on |
|---|---|---|---|---|---|---|
| term | list a session's terminals (title, cwd, env, size, created, exit status) | ~200 B each | R (host lifetime) | O | Host, Srv, Web | – |
| term | open a terminal at the session's cwd and env; refused for archived sessions | PTY | R (host) | O | Host, Srv, Web, Rem | session info, env config |
| term | terminals survive server and worker restarts (detached host, one per data dir, process lock) | – | until host exits | S | Host | – |
| term | host exits after 10 min with no terminals and no clients | – | – | S | Host | – |
| term | attach to an existing terminal; only one of this session | – | E | O | Srv, Web | list |
| term | attaching gets the current screen (headless emulator, 10k-line scrollback snapshot) | ≤ MB | R | O | Host | emulator wasm |
| term | several viewers share one terminal; resize follows; last viewer's theme answers color queries; light/dark change reported | – | R | O | Host, Web | – |
| term | output flow control: 256 KiB window, acks per 64 KiB, a viewer that falls behind gets a fresh snapshot; 8 MiB backlog cap disconnects | counters | E | S | Host, Srv, Web | – |
| term | input typed before the program starts is buffered (≤ 8 MiB) | bytes | E | O | Host | – |
| term | close: asks first if a foreground job runs (shows its name), force close kills | – | – | O | Host, Web | – |
| term | title tracked from the program | string | R | S | Host | – |
| term | one connection per env, reused, closed when no terminal runs on it; daemon checked for PTY support | connection | R | S | Host, Rem | env config |
| term | byte channel opened with a single-use token (30 s), owner only; JSON on the control channel, bytes only on the byte channel | token | E | O | Srv, Web | – |
| term | "host runs older code" notice; restart ends running terminals | version hash | E | O | Srv, Web | host version |
| term | host startup and failure log, bounded and redacted | ≤ KB | P (bounded) | O | Host, logs | logs |
| term | web: side or bottom placement, panel height, key-row toggle | localStorage | P (browser) | O | Web | – |
| term | web: on-screen key row with sticky Ctrl/Alt, clipboard paste, long-press native menu, mobile IME edits retyped, touch scroll with fling, mouse reporting | – | E | O | Web | – |
| term | web: parse output in time slices per frame so floods don't freeze the page | – | E | S | Web | – |
| term | TUI terminals: none today | – | – | – | – | – |

### Workspace (files, git, review, uploads)

| domain | function | data | durability | who | where | depends on |
|---|---|---|---|---|---|---|
| ws | list a folder: dirs first, gitignored entries marked, ≤ 2000 entries, `.git` hidden | ≤ ~200 KB | E | O, GW | Wkr, Web, TUI | exec env, git |
| ws | read a file: ≤ 1 MiB text, binary detected, truncated flag | ≤ 1 MiB | E | O, GW | Wkr, Web, TUI | exec env |
| ws | file as of a commit | ≤ 1 MiB | E | O, GW | Wkr, Web | git |
| ws | git status: branch, head, changes incl. untracked and conflicts, ≤ 5000 | ≤ 1 MiB | E | O, GW | Wkr, Web, TUI | git |
| ws | diff vs HEAD: context lines (3, 10, 25, full), untracked shown as added, unborn branch, ≤ 512 KiB | ≤ 512 KiB | E | O, GW | Wkr, Web, TUI | git |
| ws | commit log: paged, unpushed commits marked, upstream name | ≤ 512 KiB | E | O, GW | Wkr, Web | git |
| ws | one commit's message, changed files and per-file diff | ≤ 1 MiB | E | O, GW | Wkr, Web | git |
| ws | literal text search: smart case, include/exclude globs, ≤ 500 matches, ≤ 20 per file, works outside a repo | ≤ 256 KiB | E | O, GW | Wkr, Web, TUI | git |
| ws | all file paths for name filtering (git tracked+untracked, else walk ≤ 50k paths / 5000 dirs) | ≤ 4 MiB | E | O, GW | Wkr, Web | git |
| ws | change notifications (watch tree, HEAD, index, config; debounced 100 ms) → viewers reload | counter | R | S | Wkr, Web, TUI | file watch |
| ws | confinement: path rules, canonical root, no `.git`, private dir denied (also excluded from search) | – | – | S | Wkr | – |
| ws | git hardening: no optional locks, no fsmonitor, filters disabled, no prompts or pager, no system config, 10 s timeout, output caps | – | – | S | Wkr | – |
| ws | view of the viewed conversation's own cwd (subagent worktree) | – | – | S | Wkr | conversation cwd |
| ws | download a workspace file (≤ 25 MiB; media by byte range; sandboxed attachment headers) | stream | E | O, GW | Srv, Wkr | read chunks |
| ws | preview: images, audio, video, rendered Markdown | – | E | O, GW | Web | download |
| ws | upload into a project folder: ≤ 25 MiB, 1 MiB chunks, temp file then rename, never overwrite, abort cleans up, writes serialized | ≤ 25 MiB | P (project files) | O, GW | Srv, Wkr, Web | exec env |
| ws | line or range review comments on a file or diff, quoting the line, sent as the user's next message (steer or follow-up) | ≤ KB each | P (browser) until sent | O, GW | Web | chat send |
| ws | review draft and open comment editor survive page reloads, per conversation | localStorage | P (browser) | O, GW | Web | – |
| ws | outdated comment marked when its line changed | – | E | S | Web | – |
| ws | UI: tabs (files, changes, history, search, terminal), wrap toggle, panel width, scroll memory, prefetch, split view | localStorage | P (browser) | O, GW | Web | – |
| ws | TUI `/files`, `/changes`, `/grep` (read-only) | – | E | O, GW | TUI | queries above |
| ws | TUI footer shows the git branch, refreshed on changes (500 ms debounce) | string | E | O, GW | TUI | status, changes |
| ws | an open panel counts as a worker viewer (keep-alive) | counter | R | S | Wkr | – |

### Session files and blobs

| domain | function | data | durability | who | where | depends on |
|---|---|---|---|---|---|---|
| blob | upload attachments to a session (≤ 25 MiB; image MIME types detected; stored outside the project) | ≤ 25 MiB each | P | O, GW | Srv, Web, TUI | – |
| blob | resolve attachment ids to files of that session only; ≤ 20 per message | metadata | – | W | Wkr | uploads |
| blob | copy attachments to the remote env before input is accepted; local copy kept for inline images | ≤ 25 MiB | P (remote) | S | Wkr, Rem | exec env |
| blob | download snapshots: immutable private copy (≤ 25 MiB) made by the agent's send-file tool; link shown to viewers | ≤ 25 MiB | P | W makes; O, GR download | Wkr, Srv | – |
| blob | serve a snapshot (cross-site requests refused; media by byte range) | stream | E | O, GR | Srv | – |
| blob | clone/fork copies the session's uploads, downloads and artifacts | dirs | P | S | Srv | – |
| blob | cleanup on archive or delete: none (drop? no: p3 needs it on session delete) | – | – | – | – | – |
| blob | server-side snapshot save method that nothing calls (drop?: unused) | – | – | – | – | – |

### File index

| domain | function | data | durability | who | where | depends on |
|---|---|---|---|---|---|---|
| idx | `@` completion: rank like pi (exact, prefix, substring, then fuzzy), dirs +10, limit 20 (max 100), kind filter | index ≤ 50k items | R (cache, kept 60 s) | O, GW | Wkr, Web, TUI | listing |
| idx | Tab directory listing for path completion | ≤ 2000 entries | E | O, GW | Wkr, TUI, Web | folder list |
| idx | completion refuses paths outside the cwd (`/`, `~`, `..`) | – | – | S | Wkr | – |
| idx | build from the env's own listing, else from git/walk; at most one rebuild per second while files change; discarded after a move | – | R | S | Wkr | exec env, change notifications |

### Ports and forwards

| domain | function | data | durability | who | where | depends on |
|---|---|---|---|---|---|---|
| port | list forwards with name, private/public URL, opener session title | ≤ 50 × 200 B | P | O | Srv, Web, TUI | radius origin |
| port | add (≤ 50; p2's own port refused; random id; removed then re-added = new URL), remove, toggle public (confirmed) | – | P | O | Srv, Web, TUI | – |
| port | agent tool `ports` list/open/close: top-level conversation only; owner-initiated or peer input only; idempotent | – | P | W (session from the worker's identity) | Wkr, Srv | input origin |
| port | sessions on remote envs cannot forward | – | – | S | Srv | session info |
| port | forwards a session opened close when it is archived, and at start for already-archived sessions | – | P | S | Srv | archive event |
| port | tool cards web and TUI (only Radius-shaped URLs shown) | – | T | O, GR | Web, TUI | – |

### Remote access (radius) and proxy trust

| domain | function | data | durability | who | where | depends on |
|---|---|---|---|---|---|---|
| radius | sign in to Radius by device code from a CLI; credential, server id, public origin in a private file | ~2 KB | P | O | CLI, Srv | – |
| radius | outbound relay connection: owner check, token refresh, heartbeat (20 s ping, 60 s timeout), backoff 1–30 s, signed-out recheck every 30 s, disable switch | socket | R | S | Srv | credential |
| radius | relayed browser requests become loopback requests marked with a per-process secret: owner, but treated as remote (no localhost-only powers); secret redacted from logs | secret | R | S | Srv | – |
| radius | flow control: HTTP credit, congestion pause, one socket per WebSocket channel; old relay protocol versions kept (drop?: if the relay is current) | – | E | S | Srv | – |
| radius | forward channels → `localhost:<port>`: Host/Origin/Location rewritten, 502 when nothing listens, unknown forward 404, anonymous only to public forwards, stream channels refused | – | E | S | Srv | forwards |
| radius | remember the brain's public origin for forward links, saved across restarts | string | P | S | Srv | – |
| radius | status lines in logs | – | E | O | Srv | logs |
| access | any value of the proxy header removes device (localhost) trust | – | – | S | Srv | – |
| access | proxy marker object that serves nothing (drop?: the rule lives in host code) | – | – | – | – | – |

### (1) Cross-cutting needs

| need | where it shows up |
|---|---|
| blob storage per session with copy on clone and cleanup on delete | uploads, download snapshots, artifacts; workspace downloads are streamed |
| chunked byte transfer between server, worker and browser, with ranges | workspace download and upload, attachment copy to remote |
| per-session execution env that follows moves and reopens watchers | workspace, file index, attachments, prompt, terminals (by session cwd and env) |
| resolved env config needed on server, worker and terminal host | SSH options, host-key file, shell env |
| long-lived processes outside the server with their own revision | terminal host, deployed remote daemons |
| connection pools with idle close and invalidation on config change | browse connections, terminal-host connections, worker env |
| keep-alive and activity: panel viewers, active calls, move fence, idle stop | workspace, file index, relocation |
| readers that must not start or keep a worker | session lists, env session counts, terminal list (served by the host) |
| cancellation tied to an HTTP disconnect, plus cleanup that is not cancelled | workspace upload abort |
| caps everywhere (sizes, counts, timeouts) | 25 MiB, 1 MiB, 2000, 5000, 50k, 10 s, 8 MiB backlog |
| bounded, redacted logs for separate processes | terminal host, radius secret |
| browser-local drafts | review comments, editor, placement and width |
| owner-only versus full-guest gating per function | terminals and envs owner only; workspace and index for full guests |
| secrets kept in private files, never in state | keys, radius credential |

### (2) Functions duplicated across plugins today

| function | copies |
|---|---|
| env config parsing and SSH options | envs server, envs worker, terminal host (copied modules) |
| SSH connection to an env | worker env, browse connection, test connection, terminal host |
| private data-dir denial and confinement | workspace backend, upload writer, file index |
| full file listing | workspace (git/walk), file index (env listing, then workspace) |
| download snapshot read/write | files server and send-file worker (both write the same directory) |
| upload handling | attachment uploads and workspace uploads (two routes, two caps, two layouts) |
| byte-range and media headers | files download route and workspace download route |
| session data-dir layout | files plugin and session clone/copy code |
| env test results | persisted test state and an in-memory copy |
| folder picker caps and symlink following | local listing and remote listing |
| session count per env | env list and delete check |
| remote OS path rules | envs, files worker, prompt |

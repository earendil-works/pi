# Functionality map: sessions, sharing and guests, devices and owner access, status and presence, search, subagents, provider logins

**Legend.**
- Durability: E ephemeral · R until restart · P persisted · T transcript-bound (forks and rewinds with history).
- Who: O owner · Gr guest read · Gw guest write · W worker · S system.
- Where: Srv server · Wk session worker · Web · TUI · Env remote environment · CLI.

## Sessions

| function | data | dur | who | where | depends on |
|---|---|---|---|---|---|
| create session in a directory, local or on an environment; optional create-dir; optional title; model and thinking default to the last used | row ~300 B | P | O | Srv, Web, TUI, Env | dir check, model list |
| check directory: absolute, `~` expanded, is a directory; remote: resolved on the environment | path | E | O | Srv, Env | environments |
| refuse a model the configuration doesn't know | model ref | E | O | Srv | model catalog |
| list all sessions live: pinned first, then recent; never starts workers | N × 300 B | P | O; Gr: sessions shared with them, not archived | Srv→Web, TUI | — |
| suggest default cwd and environment for a new session (most recent active) | derived | E | O | Srv | list |
| rename: 1–120 chars, whitespace collapsed; an explicit title is never auto-replaced | title, edited flag | P | O | Srv, Web, TUI | — |
| automatic title: first user message, line breaks to spaces, 100 chars | text | P | S | Srv | message indexing |
| agent renames the session via a tool (root conversation only; tool explains when to rename) | title | P | W | Wk→Srv | rename |
| updated-at from message activity, never moves back; a move counts as activity | timestamp | P | S | Srv | message feed |
| pin / unpin; pinned filter in TUI | bool | P | O | Web, TUI | — |
| model and thinking level follow the root conversation's configuration | model ref | P | W | Wk→Srv | conversations |
| archive: stop the worker whatever it does; end guest access; close session-owned port forwards; keep storage | flag, time | P | O | Srv | worker stop, revocation, ports |
| restore; guests regain access | flag | P | O | Srv | sharing |
| browse and search archived sessions separately | — | E | O | Web, TUI | search |
| relocate (cwd and/or environment) | location | P | O | Srv, Wk, Env | worker lifecycle, subagents |
| relocate · guards: refuse while busy (name the running subagents); refuse a cross-machine move if a subagent has its own cwd | — | — | — | — | — |
| relocate · steps: fence the worker; update the record; move the running worker in place (60 s, else restart); release the fence on failure | — | — | — | — | — |
| clone: store plus artifacts/downloads/uploads under a new ID, worker paused, refused while work runs, title "(copy)"; dirs 0700, files 0600, no links, no overwrite; partial copy removed on failure | session files (MB) | P | O | Srv | worker pause, session files |
| fork before a user message of the main conversation: active context as of the entry before it, edits applied, head marker; title "(fork)"; failure archives the copy; subagent conversations not supported | entry drafts KB–MB | P | O | Srv + 2 Wk | history read, empty-seed check |
| delete session — p2 has none (needed: removes all per-session data everywhere) | all | — | O | all | every per-session store |
| worker start parameters from the session record; refuse archived (except an index rebuild without resuming); refuse an unconfigured environment | init | E | S | Srv | record, environments |
| start worker on demand; idle stop after 5 min without viewers, calls or tasks | — | R | S | Srv | keep-alive |
| failed worker start sticks with its error until the owner retries | error text | R | O retry; Gr sees no error | Srv, Web, TUI | — |
| worker generation fences stale reports | counter | R | S | Srv | — |
| TUI selector: current folder vs all, fuzzy title/cwd/ID, sorts threaded/recent/relevance, show IDs, confirm archive, `+ New session` | — | E | O (Gr list) | TUI | list, children, search |
| `/new [env:]path`, `/cd`, `/name`; completion of environment names and directories | — | E | O | TUI | directory listing |
| web drawer rows: busy, error, unread, subagents; Session sheet: rename, pin, share, cwd picker, archive (navigates away) | — | E | O | Web | status, children, read marks |
| catalog schema upgrades (drop? p3 starts empty) | — | — | S | Srv | — |

## Access: owner, devices, guests, sharing

| function | data | dur | who | where | depends on |
|---|---|---|---|---|---|
| loopback without cookie = device owner (TUI, CLI, first page load) | — | — | S | Srv | — |
| loopback owner browser cookie: wins over a guest cookie; tells the owner's browser from a fresh profile on the join page | 32 B secret file | P | S | Srv, Web | — |
| browser requests from another site get no principal, except a top-level navigation | — | — | S | Srv | — |
| one-time sign-in token: new one per server start in a private file; `owner-link` prints the link; 10 min, single use, ≤32 outstanding, memory only | 32 B | R | local O mints; devices cannot | Srv, CLI, Web, TUI | — |
| sign-in page: token from the fragment or pasted; claim body ≤1 KB, same-origin | — | E | anyone with token | Srv | token |
| device cookie: signed (HMAC), per port, 30 days, checked per request (expiry, revocation, signature) | key 32 B | P | S | Srv | key file |
| sign out this device (revoked until its expiry) / all devices (rotate key, clear tokens); live connections end; TUI via launcher consent | revocation list | P | O | Srv, Web, TUI | revocation |
| one-time migration of the old cookie scheme (drop?) | — | P | S | Srv | — |
| share link per session and mode (read-only, read/write), ≤1 each, created on first copy; URL on the first tunnel host, else loopback | 43-char token | P | O | Srv, Web, TUI | session open |
| confirm a read/write link on a remote environment ("guests can run commands there") | — | E | O | Web, TUI | session env |
| reset link: new token, its guests lose access at once | — | P | O | Srv | revocation |
| join page: server-rendered, CSP nonce, title and access text; owner or already-joined guest redirected | — | E | anyone with link | Srv | session title |
| join: name unverified, cleaned, ≤40, unique per session ("Ann (2)"); ≤1000 guests per link; cookie 30 days HttpOnly Strict; body ≤2 KB, same-origin | guest ~200 B | P | link holder | Srv | link |
| same browser keeps its identity; a removed guest cannot mint a new one | — | P | S | Srv | — |
| guest grant per request: session, mode, revision; void while the session is archived or unknown | — | E | S | Srv | session state |
| revision bump on remove, reset, archive or restore ends live objects and sockets on server and workers | int | P | S | Srv, Wk | — |
| remove (block) a guest | flag | P | O | Web, TUI | revocation |
| a guest holds one grant per session; a browser joining more links gains their sessions; it lands in the session shared or joined last | grant row ~100 B | P | S | Srv | links |
| share with a person by email (while connected to Radius): they open the brain in Radius, in any organization, signed in with that email; no cookie, no link; Enter copies the session's Radius address | email on the guest row | P | O | Srv, TUI, Radius | Radius relay principal |
| report the emails with grants on unarchived sessions to Radius after every change and connect; Radius admits and lists the brain for them, and learns nothing else | email list | P (in Radius) | S | Srv→Radius | grants, archive |
| connected guests now (name, mode), per tab | — | E | O | Web, TUI | presence |
| guest reaches only its session: worker, files, subagents | — | — | S | Srv | grant |
| guest UI: name and access in the header; read-only replaces the editor; full mode can send, upload, stop | — | E | Gr / Gw | Web, TUI | grant |
| guest last-seen written, never read (drop?) | ts | P | S | Srv | — |
| copy a link from the TUI through the launcher's consent | — | E | O | TUI | — |

## Status and presence

| function | data | dur | who | where | depends on |
|---|---|---|---|---|---|
| per session: running, error, live task count, busy conversations (foreground only), usage and cost | ~200 B per session | R | O all; Gr own, no error text | Srv→Web, TUI | worker reports |
| worker reports its task graph and usage on each change; retried after reload conflicts | — | E | W | Wk→Srv | — |
| worker keep-alive counts Durable tasks (today fed by the status reporter) | count | R | S | Wk | task graph |
| viewer count per session (unique per page or TUI) | — | E | O, Gr own | Web, TUI | presence |
| TUI footer: env:cwd (branch) • title › subagent; tokens, cache hit, context %/window, session total cost, model and thinking | derived | E | O, Gr | TUI | conversation view, catalog |
| `/session` details | — | E | O, Gr | TUI | footer |
| retry a failed worker; notify the failure once | — | E | O | Web, TUI | worker lifecycle |

## Search

| function | data | dur | who | where | depends on |
|---|---|---|---|---|---|
| index user and assistant messages of root and subagent conversations; skip shell output, Durable internal inputs, sender headers | ~transcript text | P (derived, rebuilt on schema change) | W→S | Wk→Srv | message stream, conversation list |
| catch up from a per-conversation cursor after each commit; 200 per page; cursor moves after the whole range; idempotent | cursors | P | S | Wk, Srv | — |
| search: title/cwd substring plus literal message terms (all required, no regex or phrases); active or archived scope; ≤41 hits, snippet ≤300, query ≤500; TUI debounce 200 ms | — | E | O | Srv, Web, TUI | index, list |
| open a hit at its session and conversation | — | E | O | Web, TUI | — |
| rebuild one session's index: stop, drop, rescan; archived without resuming (drop? no UI seen in this area) | — | E | O | Srv, Wk | worker lifecycle |
| unread: latest root answer vs owner read mark, shared by all owner devices; marked when the root conversation is visible; seeded as read at first creation | 2 ints per session | P (marks), derived (answers) | O | Srv, Web | index |

## Subagents

| function | data | dur | who | where | depends on |
|---|---|---|---|---|---|
| spawn named subagent: model, thinking (clamped), tool subset, optional own existing cwd, first message | registry ~200 B each | T | W (agent tool) | Wk, Env | models, conversations |
| send (steer / follow-up), configure, stop, archive/restore, status, models (≤200, 10 s) | — | T | W | Wk | — |
| fetch latest answer (scan ≤2000 entries) | — | E | W | Wk | — |
| report each answer to the main agent exactly once; withdraw a message stuck in the queue | tasks | T | S | Wk | background tasks |
| subagents cannot spawn subagents | rule | T | S | Wk | — |
| code-mode one-shot agents: read-only, listed on the script card | registry | T | W | Wk | code mode |
| children list per session for the sidebar without workers (name, model, thinking, tools, cwd, last entry, archived) | ~200 B per child | P (server copy) | O, Gr own | Srv, Web, TUI | worker reports |
| archive/restore from UI; refused for one-shots | flag | T | O, Gw | Web, TUI | — |
| `/agents`, `/main`, back-to-main link, TUI tool card | — | E | O, Gr | Web, TUI | — |
| follow session cwd on relocate unless own cwd | — | T | S | Wk | relocate |
| mirror of conversation model/tools into the registry (drop? duplicates conversation config) | — | T | S | Wk | — |

## Models and logins

| function | data | dur | who | where | depends on |
|---|---|---|---|---|---|
| providers with login methods and signed-in type | small | derived | any O | Srv, Web, TUI | model config |
| login by API key or OAuth: one at a time on the server | — | — | — | Srv, Web, TUI | credential store |
| login · prompts: text, secret, select, pasted code | — | — | — | — | — |
| login · notices: auth URL, device code, progress, info | — | — | — | — | — |
| login · limits: 10 min deadline; device-ID file | — | — | — | — | — |
| login · behaviour: device code auto-selected on remote connections; model list refreshed after | — | — | — | — | — |
| login · state: small, E (finished state kept until dismissed); visible only to the starting owner, others are refused | small | E | starting O | — | — |
| URL open and copy through the launcher | — | — | — | — | — |
| cancel when the starting owner leaves everywhere (sheet closed, disconnect); back navigation cancels | — | E | S | Srv | presence |
| cancel, dismiss | — | E | O | Web, TUI | — |
| redact codes, URLs and typed secrets from logs; credentials never sent to clients | — | — | S | Srv | logs |
| logout (refused during a login), delete cached models | auth file | P | O | Srv | — |
| refresh a provider's model list, return the count | model cache | P | O | Srv | — |
| `/login [provider]`, `/logout`, with completion | — | E | O | TUI | — |

## (1) Cross-cutting needs

| need | where it shows |
|---|---|
| readers that must not start workers | session list, status, children, unread, search all need server-side copies |
| worker→server reports with a generation fence | status, children, index feed |
| catch-up after commits (cursor plus wake signal) | search indexer, subagent reporter |
| per-session data across hosts with copy, archive, delete | store, artifacts, downloads, uploads, links, guests, index rows, read marks, children, forwards |
| presence and leaving | guests connected, viewer counts, login abandon, idle stop |
| keep-alive | tasks, calls, viewers |
| cancellation of multi-step operations that outlive the caller | relocate, clone, fork, index rebuild |
| revocation of live principals | guest remove/reset/archive, device logout |
| secrets | redaction, file mode 0600, no credentials to clients |
| server-rendered pages | sign-in, join (CSP nonce) |
| size caps and timeouts | title 120, name 40, 1000 guests, 2 KB/1 KB bodies, query 500, 41 hits, 10 min token/login, 60 s move, 5 min idle |
| blob directories per session | artifacts, downloads, uploads |
| launcher consent actions in the TUI | copy, open URL, sign out |

## (2) Duplicated today

| function | places |
|---|---|
| "archived?" checks | worker start, share open, relocate, clone, fork |
| title cleaning | session rename, agent tool |
| `~` and path resolution | create, relocate, TUI location parser, web picker |
| presence leases | guests, viewers, login abandon |
| subagent registry read | subagents, code-mode agent, search |
| generation-fenced report stores | status, children |
| commit catch-up loops | search, subagents |
| revocation fan-out | sharing archive, link reset, device logout |
| thinking-level validation and clamping | sessions, subagents |
| server-page rendering with nonce | join, sign-in |

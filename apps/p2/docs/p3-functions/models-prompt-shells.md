# Functionality map: models, credentials, settings, prompt resources, code mode, coding tools, one-shot agents, logs, dev and reload, PowerShell, web and TUI shells

**Legend.**
- **Dur** (durability): E = ephemeral, R = until restart, P = persisted, T = transcript-bound.
- **Who:** O = owner, GR = guest read, GW = guest write (send access), W = worker, S = system.
- **Where:** Sv = server, Wk = session worker, Web, TUI, L = TUI launcher (visitor's machine), RE = remote environment.

## Models, credentials, settings

| function | data | Dur | Who | Where | depends on |
|---|---|---|---|---|---|
| List the models of signed-in providers (the faux provider in demo mode) | ~hundreds of entries: id, name, thinking levels, context window; ~100 KB | R | O | Sv, Web, TUI | credentials, models.json, catalog cache |
| Compose custom providers, models and overrides from models.json (baseUrl, api, headers, compat, cost, thinking map, input limits) | models.json, KB | P (owner-edited file) | O edits, S reads | Sv, Wk | config values |
| Resolve config values: `!cmd` (10 s timeout), `$VAR`, `${VAR}`, `$$`; register the result as a secret | — | E | S | Sv, Wk | redaction |
| Hot-reload settings.json, models.json, models-store.json and auth.json: watch, re-read once on a half-written file, keep the last valid state, report errors per file | fingerprints | R | S | Sv and every Wk separately | file watch |
| Fall back to a 2 s poll when the watcher fails | — | R | S | Sv, Wk | — |
| Default model for new sessions: setting, then env `P2_PROVIDER`/`P2_MODEL`, then the first signed-in model; thinking level clamped to the model | settings | P | O sets, all read | Sv, Web, TUI | catalog |
| Set the default model and thinking level ("set as default" from a picker) | settings.json | P | O | Web, TUI → Sv | settings |
| Model scope for cycling: `enabledModels` patterns, globs, `:level` suffix, model ids that contain colons; set and clear | ≤500 patterns | P | O | TUI only (none on web) | catalog |
| Pick the conversation's model and thinking level | conversation agent config | T | O; guests see a read-only line | Web, TUI → Wk | conversations |
| Cycle models (Ctrl+P / Shift+Ctrl+P over the scope) and thinking levels (Shift+Tab) | — | E | O | TUI | scope |
| Refuse an unknown model at session create, at configure, and at worker start (visible error with Retry) | — | E | S | Sv, Wk | catalog |
| Model access for runs: a request in flight keeps the configuration generation it started with | provider objects | R | W | Wk | credentials |
| Run settings read at each decision: stream (transport, timeout, retries, cache retention), retry, compaction, tool execution, steering and follow-up modes | small | P | O edits file | Wk | settings |
| Catalog cache (models-store.json): restore offline, refresh from the network on demand | per provider, KB–MB | P | S | Sv writes, Wk reads | — |
| Providers with their login methods and signed-in type; never secrets | small | R | O | Sv, Web, TUI | catalog |
| Sign in with an API key (secret prompt) or OAuth (URL, device code, pasted code, account select); 10 min deadline; one login at a time server-wide; it belongs to the starting device | prompts, notices | E (credential P) | O | Sv, Web, TUI | credentials, questions |
| Remote owner: device-code login selected automatically | — | E | S | Sv | login |
| Answer, cancel or dismiss a login prompt; select answers validated; secret answers redacted before use | — | E | O (starting device) | Web, TUI | redaction |
| Abandon a login when its owner closes the sheet everywhere or disconnects | — | E | S | Sv | presence |
| Device identity for providers that need one (device.json) | UUID | P | S | Sv | — |
| Sign out of a provider (credential and cached catalog removed); refused while a login runs | — | P | O | Sv | credentials |
| Refresh a provider's models; report the count | cache | P | O | Sv | catalog |
| Credentials in auth.json: locked, validated, fail-closed at startup, last-good kept on a bad edit, keys from env or command, never sent to clients | KB | P | S; written by server and workers (OAuth refresh) | Sv, Wk | locked file |
| Owner display name on new owner entries (≤40 chars, no `<>` or control characters) | — | P | O | Wk | settings |
| Code mode on/off, applied live in every worker | bool | P | O (file edit) | Wk | settings |
| Show a model error in the transcript as a display-only entry, deduped and recovered at start | small per error | T | O, GR | Wk | conversations |
| Per-model cost rates and tiers for the cost panel | — | R | O, GR | Web | catalog |
| Show settings, model and credential load errors | strings | R | O | Web, TUI | — |
| (drop?) Fake provider with scripted prompts inside product code | — | E | S | Sv, Wk | move to test fixtures |

## Prompt resources

| function | data | Dur | Who | Where | depends on |
|---|---|---|---|---|---|
| Global AGENTS.md (data directory, always local) plus AGENTS.md from the filesystem root down to cwd, read in the session's environment | ≤ tens of KB | R | S | Wk, RE | environment files |
| Discover skills: `<data>/skills` or `~/.pi/p2/skills` on a remote, plus `<cwd>/.pi/skills`. Rules: a SKILL.md directory is one skill; root `.md` files count; frontmatter name and description; skip hidden and node_modules; first of a name wins | list of skills | R | S | Wk, RE | environment |
| Skills block in the system prompt; `disable-model-invocation` skills hidden from the model | KB | R | S | Wk | discovery |
| Prompt templates: global and `<cwd>/.pi/prompts` `.md` files, `description`, `argument-hint` | list | R | S | Wk, RE | environment |
| Watch all of these (recursive, directory creation); poll fallback 30 s remote, 2 s local; 60 s load timeout; keep the last valid state plus an error | — | R | S | Wk, RE | file watch |
| Reload from the new cwd and machine after a relocation | — | R | S | Wk | location |
| A local session's first message waits for the first load | — | E | S | Wk | input gate |
| App guide section (app source, docs, config, skills paths) | text | R | S | Wk | — |
| List templates and skills for `/` completion | names, descriptions | R | O, GW (not viewers) | TUI; web has no completion UI | — |
| Expand `/name args` (bash-style args, `$1`, `$@`, `${@:N:L}`, defaults) and `/skill:name args` (SKILL.md read at invocation) on the worker before send | text ≤1 MB | E | O, GW | Wk; Web composer, TUI | environment |

## Code mode, coding tools, one-shot agents, PowerShell

| function | data | Dur | Who | Where | depends on |
|---|---|---|---|---|---|
| Run model-written JS (QuickJS VM, worker thread) that calls the conversation's tools as nested durable calls | script, journal | T | model in turns by O or GW | Wk | conversations |
| Resume an interrupted script by replaying its journal; same VM fingerprint (fixed 256 MiB heap), else it ends with "sandbox changed" | journal | P | S | Wk | Durable |
| Script deadline; output bounded to the token budget, overflow spilled to a file | — | T | S | Wk | — |
| Offer or withdraw the tool live via the setting; a running script keeps its tool | — | P | O | Wk | settings |
| (drop?) "Removed mid-script" report, then abort; only a reload artefact | — | E | S | Wk | — |
| Code mode tool card: script, nested calls, agent rows | — | T | O, GR | Web, TUI | renderers |
| read, write, edit, bash in the session's environment; send access permits tool actions (not filesystem isolation) | output caps | T | O, GW | Wk, RE | environments |
| Preamble (speaker rules) and cwd section ("tools run on remote env X, SSH host Y") | text | R | S | Wk | location, environments |
| Tool cards: bash, read, write, edit (diff), grep, find, ls | — | T | O, GR | Web, TUI | — |
| One-shot agent (scripts only): fresh child conversation, prompt plus JSON Schema; parse plain or fenced JSON, validate, up to 3 retries with feedback; resolves to the value | child transcript | T (owned by the call) | W (script) | Wk | conversations, models, code mode |
| Agent model, thinking level and tool subset (default: the caller's); validated before any commit | — | T | W | Wk | catalog |
| Reattach after a restart (task document holds the child id; submissions `agent:N` deduped) | id | P | S | Wk | Durable |
| Aborting the call aborts the child's work | — | E | S | Wk | ownership |
| Child read-only for people (Stop allowed) and follows the session cwd | policy | T | S | Wk | conversations |
| Agent rows on the script card (label, model); transcript opens read-only; not in the sidebar; cost counts toward the session | metadata | T | O, GR | Web, TUI | session cost |
| PowerShell tool only on Windows: local from the platform, remote from the environment's OS report; ask again every 30 s if unreachable and after a move | bool | R | S | Wk, RE | environments |

## Logs and notices

| function | data | Dur | Who | Where | depends on |
|---|---|---|---|---|---|
| Copy (tee) server stdout and stderr into a redacted ring without changing real output | 1000 lines / 256 KiB per source, 128 sources, lines ≤16 KiB | R | S | Sv | redaction |
| Worker stdout, stderr and lifecycle under `session:<id>`; stderr tail (4000 chars) for the crash message | same bounds | R (server memory) | S | Sv, Wk | — |
| Terminal host and dev supervisor publish redacted snapshot files; the server imports changes every 300 ms with dedupe; a final synchronous snapshot on exit | ≤2 MiB files | P | S | Sv, detached processes | file format |
| (drop?) Importing those files by polling; they could be pushed over IPC | — | — | — | — | — |
| Redact secrets: config files (auth, radius, models, settings, envs, owner key/token), secret env vars, resolved config values, login answers, codes and URLs, auth headers, Bearer/Basic, URL passwords, `sk-` keys; old secrets kept after rotation | secret set | R | S | Sv, Wk, detached | — |
| View a source: filter, follow the tail, copy the visible lines, switch source; never starts a worker | ≤1000 lines | R | O | Web, TUI | — |
| Owner notices: latest error per source (≤50) from host errors, worker failures, refused reloads and stderr `Error:` lines; dismiss | — | R | O | Sv, Web lane, TUI status lines and `/notices` | — |
| Notice summary when a TUI opens; new notices shown as they arrive | — | E | O | TUI | — |
| Dev notices merged with error cards; dismissal remembered per browser (identities only) | — | P (browser) | O | Web | — |
| Worker start failure: error, Retry, Show logs; the failure is cached so background references do not respawn the worker | — | R | O | Sv, Web, TUI | sessions |

## Dev and reload

| function | data | Dur | Who | Where | depends on |
|---|---|---|---|---|---|
| Watch plugin and runtime files; mark dirty only; track the files each bundle and host actually loaded | dirty set | R | S | Sv (dev) | — |
| Reload the dirty or named plugins on the server and running workers; rebuild web and TUI bundles; refuse a removal while it is held; report the selection or the reason | — | R | O | Sv, Wk | bundles |
| Supervised restart (graceful, SIGKILL after 10 s); restore non-archived workers; no duplicate inputs | running set (supervisor memory) | R | O | supervisor | — |
| (drop?) Seeding running sessions through `P2_DEV_RESUME` | — | — | — | — | — |
| Dev status and buttons (GET/POST `/__p2_dev`); "Server code changed" list | status | R | O | Web, TUI (consent) | notices |
| CLI `npm run reload [-- names] [--restart]` over a 0600 Unix socket | — | E | account | host | — |
| `reload_plugins` agent tool: dev server only, local session on the p2 checkout, root conversation, owner-initiated turn (attribution from the calling entry, nested calls walk up to it), not replayed after a crash; plus a prompt section about it | — | E | O-initiated | Wk | turn attribution |
| Web: poll the manifest every 5 s while visible; reload on a new version or a newer link protocol | — | E | O, GR | Web | — |
| TUI: poll the hash every 1 s; prepare a new worker; carry a ≤1 MiB snapshot (viewed identity, drafts, pending send ids, reading positions, toggles); swap; `/reload` forces | — | E | O, GR | TUI, L | — |
| Serve bundles: content-named files, old files kept briefly, lazy first build, a failed build keeps the previous one; owners and admitted guests only | ≤8 MiB | R | O, guests | Sv | — |

## Web shell

| function | data | Dur | Who | Where | depends on |
|---|---|---|---|---|---|
| Layout: sidebar (grouped by where tools run, pinned first, most recently active directory first, working and unread markers), main area, phone drawer, collapse state | — | browser | O; guests see their session | Web | sessions |
| Navigation stack: `/s/<id>/c/<n>` URLs, modal layers with locators, workspace and terminal carry-over, scroll memory, sessionStorage, Android CloseWatcher, Escape | — | tab | all | Web | — |
| Composer state kept across navigation: draft (also in sessionStorage), attachments, reply target, Stop notice | — | tab | O, GW | Web | — |
| New-session choices kept while browsing | — | E | O | Web | — |
| Theme per browser (system/light/dark), no flash on load, synced across tabs | — | P (browser) | all | Web | — |
| Reconnect with backoff ≤5 s; detect an ended share (HEAD /) and stop reconnecting | — | E | all | Web | access |
| Installable app (manifest, icons), CSP nonce | — | — | all | Web | — |
| Listing cache for Back and revisits | — | E | all | Web | — |

## TUI shell

| function | data | Dur | Who | Where | depends on |
|---|---|---|---|---|---|
| Sign in: loopback is the device owner; remote HTTPS owner link or share link (display name) redeemed into a per-origin cookie (0600); an ended share exits and is forgotten | config.json | P (visitor) | O, guest | L | access |
| Fetch a bounded, SHA-256-checked bundle; run it in a permission-dropped worker (no fs, net or env); watchdog at 512 MiB RSS | ≤8 MiB | E | O, admitted guests | L, TUI | bundles |
| Filter output (safe sequences, 64 KiB frames); track terminal modes and restore them on exit, crash and swap | — | E | S | L | — |
| Actions under a grant (own key or consent screen): upload a file or clipboard image, paste, copy, open URL, download, external editor, suspend, save prefs (diff), dev reload, sign out (this or all owner devices) | — | E | O (guests some) | L | — |
| Visitor preferences: pi keybindings, settings and themes (read only), p2 prefs.json, watched; server defaults (tui.json) below them; privileged bindings never from the server | KB | P (visitor, server) | visitor, O | L, Sv | — |
| Query terminal colors (OSC 10/11/4, mode 2031) | — | E | S | L | theme |
| Commands: pi ids, contexts, rebinding, conflict check, F1 palette, `/hotkeys`, `/settings`, `/keybindings`, `/quit`, `/reload`, thinking and tool-output toggles | — | E | all | TUI | — |
| Fullscreen layout; reading position kept while output grows; drafts per (session, conversation) | — | E | all | TUI | — |
| Reconnect with backoff; references rebind | — | E | all | L, TUI | — |

## (1) Cross-cutting needs

| need | where it shows up |
|---|---|
| Config files with a single writer | settings, models and auth files are watched by the server and every worker; auth.json is written by both |
| Secrets | central redaction; credentials never reach clients; workers need auth for model calls |
| Watching files in an environment (local or SSH) | prompt files, OS probe, workspace, file index; needs poll fallback, timeouts, last-valid state, re-arm after relocation |
| Background work with no viewer | scripts, one-shot agents, logins (10 min), reloads; they keep the worker alive and are aborted with their owner |
| Cancellation chains | script → nested calls → child conversation; login cancel or abandon; reload aborts |
| Readers that must not start workers | logs for `session:<id>`, sidebar markers, cached failure state |
| Bounded buffers | logs, TUI snapshot (1 MiB), frames (4 MiB / 64 KiB), tool output, bundles (8 MiB) |
| Turn attribution | owner, guest or peer, for privileged tools (`reload_plugins`) and the speaker preamble |
| Client code delivery | version push, swap with state carry-over, guest-limited assets |
| Client-side consent | the TUI grant model |
| Deterministic fake provider | for tests |

## (2) Functions duplicated today

| duplicated function | places |
|---|---|
| Watch, last-valid state, retry once | models config loader, prompt watcher, TUI preferences watcher, dev watcher, logs file import |
| Config and credentials loaded per process | server plus each worker; both write auth.json |
| Drafts | web sessionStorage, TUI snapshot, server drafts |
| Model lookup and choice resolution | chat, subagents, agent, sessions; thinking clamp in config.ts and subagents |
| Turn attribution | conversations' origin.ts, copied into dev-tools |
| Following the session location | prompt, PowerShell, dev-tools, workspace, file index |
| "Offer tool only when" switches | code mode, PowerShell, dev-tools |
| Registering secrets for redaction | models, login, radius, server env scan, worker |
| Notice channels | log notices, dev notices, model-error entries, TUI grant notices, web notice lane |
| Staleness checks | web poll every 5 s, TUI poll every 1 s, protocol-mismatch reload |
| Reconnect backoff | web, TUI, `useObject`'s 500 ms re-hold |
| Log source labels | web and TUI |
| `/` expansion | web composer and TUI |
| Themes | web and TUI, separately |
| Environment file reading | prompt, workspace, file index |

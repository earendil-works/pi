# Functionality map: conversations, agent loop, chat mode, drafts, cross-session messages, sent files, artifacts

Read-only, based on origin/private `5abe3f6d6`. Abbreviations:
- **who:** O owner, GR guest who can read, GW guest who can write (full grant), W session worker, S system.
- **where:** srv server, wkr session worker, web, tui, env (remote execution environment).
- **durability:** eph ephemeral, rst until restart, pers persisted, tx transcript-bound.

## Viewing a conversation

| domain | function | data | durability | who | where | depends on |
|---|---|---|---|---|---|---|
| conv | View a conversation live: newest entries (≤100 or 512 KiB, at least 20) plus all conversation docs | entries ~KB each; window up to 512 KiB | tx | O, GR | wkr→web, tui | watch conversation |
| conv | Window start stays put while within 1.5× the limits, so new entries arrive as small appends | previous window start | eph | S | wkr | view |
| conv | Page older history: 100 entries / 1 MB / 2000 scanned per page; compaction and reset markers always included | pages ≤1 MB | tx | O, GR | wkr | view |
| conv | Keep entries that a compaction or reset dropped from the view; client keeps pages of 4 conversations | client cache | eph | O, GR | web, tui | history paging |
| conv | Jump to an entry (search hit, quoted message), loading older pages until it is shown, then highlight it | entry id | eph | O, GR | web | history paging, search |
| conv | Context usage (estimated tokens vs. model window), latest response's cache usage | numbers | tx (derived) | O, GR | wkr→web, tui | model metadata |
| conv | Cost sheet: each response's cost, cache hit, provider, model, stop reason | ~100 B per response | tx | O, GR | wkr→web, tui | view |
| conv | Model metadata for viewers: name, window, thinking levels; no credentials | small | eph | O, GR | wkr | model catalog |
| conv | Working indicator: retry countdown, deferred response, compaction (with reason and attempt), running tool, working | live doc | tx | O, GR | web, tui | view |
| conv | Render the transcript: thinking (toggle), per-tool cards (bash, codemode with its nested calls, read, write, edit diff, subagent, artifact, ports, send_file), inline images, failures, markers, subagent reports | entries | tx | O, GR | web, tui | renderer extensions |
| conv | Show a tool cut short by a restart as "interrupted" (not failed) | error text pattern | tx | O, GR | web, tui | — |
| conv | "Stopped" marker after Stop until an aborted response shows | client flag | eph | O, GW | web | stop |
| conv | Tool paths relative to the conversation's own cwd; open a file from a card in the workspace | cwd | eph | O, GW | web | workspace |
| conv | Expand tools / show thinking toggles; reading position kept per conversation across switches and reloads | client state | rst (TUI snapshot) | O, GR | web, tui | — |
| conv | Follow output, scroll-to-bottom button, keep the reader's position while sending | client state | eph | O, GR | web, tui | — |
| conv | Read-only bar for view-only guests ("Joined as X (unverified)"); share-ended screen | grant name | eph | GR | web, tui | access |
| conv | "Session unavailable" with Retry and Show logs (owner), "ask the owner" (guest) | worker error | rst | O, GR | web | worker status, logs |
| conv | Leave the view with a notice if the session is archived or removed elsewhere | catalog row | eph | O, GR | web | session list |

## Sending and the queue

| domain | function | data | durability | who | where | depends on |
|---|---|---|---|---|---|---|
| conv | Send a message: text ≤1 MB, at least text or one attachment | text | tx | O, GW | web, tui→wkr | admission rules |
| conv | Retried send with the same request id is admitted once, per author (id ≤200) | request id | tx (Durable) | S | wkr | — |
| conv | While busy: steer the current run (default) or queue a follow-up | mode | tx | O, GW | wkr | — |
| conv | Wait before admitting input until prompt resources are loaded (first message of a fresh worker) | — | eph | S | wkr | prompt resources |
| conv | Attribute input: speaker block in the model message, structured author in the entry; owner name read at write time | author | tx | S | wkr | settings |
| conv | Legacy speaker-block parsing of old entries (drop? p3 starts empty) | — | tx | S | all | — |
| conv | Expand `/template` and `/skill:` on the worker before sending | text | eph | O, GW | wkr | prompt resources |
| conv | `@` and Tab file completion | file index | eph | O, GW | web, tui | file index |
| conv | List queued inputs with their mode | inbox | tx | O, GW | web, tui | view |
| conv | Queue item back to editor: caller's text returns; other authors' texts become their restored drafts | texts | tx + drafts | O, GW | wkr | restored drafts |
| conv | Remove a queue item (discarded, whoever wrote it) | — | tx | O, GW | wkr | — |
| conv | Stop: withdraw every queued input, abort the run; own texts to editor, others' to their restored drafts; allowed even when read-only | texts | tx + drafts | O, GW | wkr | restored drafts |
| conv | Withdraw own queued inputs (Alt+Up), report how many were already placed | texts | tx | O, GW | wkr, tui | — |
| drafts | Restored drafts per (conversation, author); claimed once, first tab wins | ~KB each | rst (should be pers) | O, GW (own) | wkr→web, tui | stop, dequeue |
| drafts | Composer draft survives navigation: web one draft in sessionStorage; TUI per conversation plus across worker swaps | text | eph / rst | O, GW | web, tui | — |
| drafts | TUI pending send ids reused, sent once connected ("Sending when connected…") | request id | rst | O, GW | tui | reconnect |
| drafts | TUI drafts and snapshots partitioned per scope, pending sends never replayed into another scope | snapshot | rst | O, GW | tui | project plugins |

## Configuration and conversation actions

| domain | function | data | durability | who | where | depends on |
|---|---|---|---|---|---|---|
| conv | Choose model and thinking level: owner only, known model, known level | ref | tx | O | wkr | model catalog |
| conv | The root conversation's model also updates the session's default (sidebar, next worker start) | ref | pers | S | srv | session list |
| conv | Compact now (instructions ≤10k); abort running compactions (Escape) | task id | tx | O, GW | wkr | — |
| conv | Start a new context with a handoff (≤100k); owner only | text | tx | O | wkr | — |
| conv | Read-only conversations (scripts' one-shot agents): refuse send, dequeue, configure, compact, shell; Stop allowed; set at creation | flag | tx | S | wkr | subagents |
| conv | Fork at a person's message into a new session, the message waiting in its editor (root conversation only) | — | pers | O | tui, srv | session clone |
| conv | Clone the whole session | — | pers | O | srv | session clone |
| conv | Copy the last answer (TUI via launcher confirm, ≤1 MiB; web copy button) | text | eph | O, GR | web, tui | launcher |
| conv | External editor (Ctrl+G); double Ctrl+C exits; double Escape opens fork | text | eph | O, GW | tui | launcher |
| conv | Open subagent and one-shot conversations; subagent bar shows tools, cwd, archive/restore | child list | pers | O, GW (archive) | web, tui | subagents |
| conv | New-session screen: folder, env, model, first message with attachments | — | pers | O | web | sessions, uploads |
| conv | Inline images ≤5 MiB if the model accepts images, otherwise list the path | image bytes | tx | S | wkr | uploads, model metadata |

## Shell commands

| domain | function | data | durability | who | where | depends on |
|---|---|---|---|---|---|---|
| conv | `!cmd` (output joins context) and `!!cmd` (display only): one per conversation, in the conversation's cwd on its environment | command ≤100k | tx (entry) | O, GW | wkr, env | execution env |
| conv | Live output tail: 50 KB / 2000 lines, sampled every 200 ms, at most 100 KiB/s; full output spilled to a file | ≤50 KB live | eph | O, GR | wkr→web, tui | — |
| conv | Shell result becomes an entry, placed at the run's next boundary while busy; never starts a run | entry | tx | S | wkr | — |
| conv | Cancel a command: its author or the owner; timeout reported | — | eph | O, GW | wkr | — |
| conv | Retried shell request runs once (100 keys kept) | ids | rst | S | wkr | — |
| conv | Shell cancelled when the conversation has no viewer for 30 s, or on reload (drop? accidental) | — | — | S | wkr | — |

## Chat mode

| domain | function | data | durability | who | where | depends on |
|---|---|---|---|---|---|---|
| chatmode | Switch per conversation: owner switches, everyone sees it; forks and new subagents start off | bool | tx-side doc | O / GR | wkr | — |
| chatmode | Messages without `@pi` become display-only chat entries (author, text, attachments, reply) | entry | tx | O, GW | wkr | send |
| chatmode | `@pi` mention: digest of the chat since the last mention, recording which entries it passed on | ≤100 messages, ≤20 files, ≤4 images; scan ≤2000 | tx | O, GW | wkr | send, uploads |
| chatmode | Composer chip with the count of chat messages not yet passed on | count | eph | O, GR | web, tui | view |
| chatmode | Reply to a person's or Pi's message: client names the entry, worker derives author and a 60-char quote | quote | tx | O, GW | web, tui, wkr | — |
| chatmode | Quote line and "with N chat messages" note in the transcript; dashed bubble; `@pi` completion first; hint text | — | — | O, GR | web, tui | renderers |

## Cross-session messages

| domain | function | data | durability | who | where | depends on |
|---|---|---|---|---|---|---|
| xconv | Agent lists other top-level sessions: id, title, model, working/idle/stopped; archived excluded; ≤200 | ~20 KB | eph | W (root only) | srv | session list, worker status |
| xconv | Agent sends another session an attributed message (≤32 KiB, steer or follow-up); starts the recipient's worker | text | tx (recipient) | W | srv→wkr | start worker |
| xconv | Send is idempotent by tool call id; retried once if the recipient's worker went away | ids | tx | S | srv, wkr | — |
| xconv | Agent reads another session's latest completed answer without sending (≤64 KiB, scans ≤2000, busy flag) | text | eph | W | wkr | — |
| xconv | Only owner-initiated turns or authenticated peer messages may use it (follows nested calls ≤32 deep, scans ≤2000); guests never | — | — | S | wkr | attribution |
| xconv | Refuse a stale worker generation, sending to yourself, archived sender or recipient; recheck after start | — | — | S | srv | worker hosts |
| xconv | System prompt section describing the tool | text | — | S | wkr | prompt |
| xconv | Peer input shown with sender label; owner opens the peer session, restoring it if archived | — | tx | O (link), GR (label) | web | session list |
| xconv | Sender attribution as a JSON text prefix (drop? use a structured author) | — | tx | S | — | — |

## Uploads (attachments)

| domain | function | data | durability | who | where | depends on |
|---|---|---|---|---|---|---|
| files | Upload an attachment: ≤25 MiB, same origin, outside the project directory | blob ≤25 MiB | pers | O, GW | web→srv | — |
| files | At most 20 per message; ids resolved only to this session's uploads | ids | pers | S | wkr | — |
| files | Copy attachments to a remote environment before admission; no fallback on failure | blob | pers (env) | S | wkr, env | execution env |
| files | TUI attach through the launcher (picker, path confirm, Ctrl+V); remove last or all | upload id | rst | O, GW | tui | launcher |

## Sent files

| domain | function | data | durability | who | where | depends on |
|---|---|---|---|---|---|---|
| sent | Agent offers a file: private snapshot ≤25 MiB read through the environment (remote too), optional name | blob | pers | W | wkr, env→data dir | execution env |
| sent | Download for viewers: cross-site refused, byte ranges for audio/video, safe filename | stream | pers | O, GR | srv | session list |
| sent | Card in the transcript; viewer panel with preview (image, audio, video, text) | — | tx | O, GR | web | — |
| sent | TUI list of files sent in the loaded transcript; text preview ≤256 KiB (binary detected); save or open in browser | ≤256 KiB | eph | O, GR | tui, wkr | launcher |
| sent | Workspace also creates download snapshots | blob | pers | O | srv | workspace |

## Artifacts

| domain | function | data | durability | who | where | depends on |
|---|---|---|---|---|---|---|
| artif | Agent creates or updates an artifact: html, svg, markdown or text; ≤2 MiB; slug name; title ≤200; new immutable numbered version each time | ≤2 MiB per version | pers | W | wkr→data dir | — |
| artif | Per-conversation index, not rewound by compaction or reset; forks start empty | ~100 B per version | pers | S | wkr | — |
| artif | List: count button, picker newest first | list | pers | O, GR | web, tui | index |
| artif | View: HTML/SVG in a sandboxed frame with CSP (https CDNs allowed, no app identity); markdown rendered; text; download; open tab | ≤2 MiB | pers | O, GR | srv, web | — |
| artif | Preview diagnostics bridge: console errors, CSP violations, WebGL loss, ≤50 kept | messages | eph | O, GR | web | — |
| artif | TUI card (title, type, version, text content when expanded); inline view ≤512 KiB (HTML/SVG as source); open in browser; download | ≤512 KiB | eph | O, GR | tui, wkr | launcher |

## Session lifecycle and liveness

| domain | function | data | durability | who | where | depends on |
|---|---|---|---|---|---|---|
| lifecycle | Clone copies uploads, downloads and artifacts | blobs | pers | O | srv | clone |
| lifecycle | Delete or archive cleans up blobs (missing today) | — | — | S | srv | session delete |
| presence | Worker stays up while a person views; running calls block idle stop; sends refused during a move | counters | eph | S | wkr | keep-alive |
| presence | Viewer count in the footer | count | eph | O, GR | web | presence |

## (1) Cross-cutting needs

| need | where it shows |
|---|---|
| Blob storage with caps, immutable ids, private modes, range reads | uploads, sent files, artifacts, shell spill files |
| Per-session data that clone copies and delete removes | blobs, restored drafts, chat-mode switch, artifact index |
| Transcript-bound vs. app state | chat-mode switch and artifact index have "fork starts empty" and "not rewound" semantics |
| Readers that must not start a worker | artifact list and preview, sent-file preview, cost sheet, peer state list |
| Long work outliving the call, with cancel, dedupe and display until placed | shell, peer send |
| Cancellation | Stop, abort compaction, abort shell, caller abort, worker going away |
| Keep-alive vs. presence | viewers vs. lingering tabs vs. active calls vs. tasks |
| Idempotency per author request id | send, write, shell, peer send |
| Authorization split | view / send / owner-only, applied in every route and method |
| Launcher grants for TUI side effects | copy, attach, download, open in browser, external editor |
| Bounded scans | history, mention digest, attribution, latest answer: each ≤2000 entries |
| Remote-environment copies | attachments, sent files |

## (2) Functions duplicated today

| function | duplicated in |
|---|---|
| Input gate loop | send, write, shell, peer send |
| Latest answer text | TUI copy, web copy, peer answer scan |
| Peer sender parsing | transcript rendering, tool attribution check |
| Artifact list | client-side from the transcript, and the worker index |
| Download snapshot writers | send_file, workspace |
| Size and ID validation | uploads, downloads, artifacts each have their own |
| Restoring texts to the editor | web and TUI each implement it |
| Per-conversation state polling via commit signal plus loop | chat-mode, artifacts |
| Transcript building and rendering | web and TUI each have their own renderers (shared builder) |
| Preview limits | 256 KiB sent files vs. 512 KiB artifacts |

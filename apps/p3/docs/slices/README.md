# Slices

Each slice is small enough for the owner to review in one sitting. Its brief says what it builds and what to know;
before it is built, the brief is filled out in detail, starting with p2's features in its area (`../workflow.md`).

| # | Slice | Brief | State |
| --- | --- | --- | --- |
| 1 | Base and sessions | `01-base-and-sessions.md` | redone on Chord's slice 14 with p3's own kit (2026-11-15), built, reviews next |
| 26 | The release build, the command and several Pis | `26-release.md` | built (all three parts, with review round 1's fixes), review round 2 next |
| 27 | The terminal client scaffold | (brief to come) | next after 26 |
| 25 | Sign-in with Radius | `25-radius-sign-in.md` | brief, research done (2026-11-15) |
| 28 | Telemetry: metrics always, traces kept by outcome, full tracing on demand, a size budget | `28-telemetry.md` | brief, measured on p2 (2026-11-16); decisions open |
| 2 | Apply from anywhere | `02-apply.md` | brief |
| 3 | Talk to a session | `03-transcript.md` | brief |
| 7 | Models | `07-models.md` | brief |
| 8 | Environments and coding tools | `08-environments.md` | brief |
| 9 | Prompt | `09-prompt.md` | brief |
| 10 | Agents | `10-agents.md` | brief |
| 18 | Session lifecycle | `18-session-lifecycle.md` | brief |
| 12 | Files and artifacts | `12-files.md` | brief |
| 19 | Workspace and terminals | `19-workspace.md` | brief |
| 11 | Questions | `11-questions.md` | brief |
| 13 | MCP | `13-mcp.md` | brief |
| 14 | Views | `14-views.md` | brief |
| 15 | Groupings | `15-groupings.md` | designed in part (talks) |
| 20 | Status, search and notices | `20-status-search.md` | brief |
| 21 | Remote access, forwards and backups | `21-remote.md` | brief |
| 22 | Discord, chat mode and voice | `22-channels.md` | brief |
| 16 | Web and terminal | `16-ui.md` | waiting for the team's Elanor port |
| 4 | Admission (Chord) | `04-admission.md` | built in Chord (slice 14, `8270d9af6`); p3 uses it from slice 5 |
| 5 | People and apps | `05-people-and-apps.md` | designed in part |
| 6 | Locks | `06-locks.md` | designed |
| 23 | The plugin guide | `23-plugin-guide.md` | brief |
| 24 | Worker runners | `24-runners.md` | brief |
| 17 | Org | `17-org.md` | later |

Rows are in build order (the numbers are ids): p2's features first, then what p3 adds (decision "Fundamentals first; Chord fixed
from an analysis of all features"). The order may change as we learn; a reordering is a decision recorded in
`../decisions.md`. The Chord changes p3 needed for its lists, rows by key, joins and admission are Chord's slice 14
(`packages/chord/docs/slice-14.md`, committed `92e1db6ca` and `8270d9af6`); its carry-over is in
`packages/chord/docs/slices.md`.

## p2's features by slice

The domains of p2's functionality map (`apps/p2/docs/p3-functions/README.md`) and p2's plugins, and the slice that
builds each in p3. A slice's details list every feature of its rows.

| p2 domain (map #) and plugins | Slice |
| --- | --- |
| Sessions (1): create, live list, rename, archive, restore | 1 |
| Sessions (1): pin, automatic and agent titles, relocate, clone, fork, delete, unread; workers (2): idle stop, sticky failure, archive stops the worker; `sessions`, `tree`, `drafts` (session part) | 18 |
| Conversations and agent (3): live view, paging, send, steer, queue, stop, model and thinking, compact, resume; `chat`, `drafts`, `quiet-tools` | 3 |
| Shell commands (4) | 8 |
| Chat mode (5): `chat-mode` | 22 |
| Agents (6), code mode (7): `subagents`, `agent`, `agent-plugins`, `codemode`, `conversations`, `history` | 10 |
| Session files (8): `files`, `artifacts`, `send-file` | 12 |
| Environments and execution (9): `envs`, `locations`, `powershell`, `coding-tools` | 8 |
| Workspace (10), terminals (11): `workspace`, `file-index`, `terminals` | 19 |
| Access (12): `sharing`, `devices`, `login` (owner sign-in) | 5 (sign-in with Radius: 25) |
| Models, credentials, settings (13): `models`, `login`, `settings`, `cache-warming` | 7 |
| Prompt resources (14): `prompt`, `scope-prompt` | 9 |
| Status and presence (15), search (16), logs and notices (18): `status`, `search`, `logs` | 20 |
| Telemetry (18): `telemetry` (the store, the Traces tools; the pane: 14, 16) | 28 |
| Remote access and forwards (17): `radius`, `ports`, `proxy-marker`; backups: `backup`, `sync` | 21 |
| Dev and reload (19): `dev-tools` | 2 (the agent's tools: 14) |
| Web shell (20), TUI shell (21): `web-shell` | 16 |
| Transport (22) | Chord (built) |
| Questions and approvals | 11 |
| Views, artifacts in the transcript, glyphs: `views`, `glyphs` | 14 |
| Groupings: `rollups`, `projects`, `familiar` (Home) | 15 |
| MCP: `mcp` | 13 |
| Discord, voice: `discord`, `voice` | 22 |
| The owner's own plugins in the user root (mail, calendar) | not base: apps or user plugins |

## Open, not yet in a slice

- **Chord's size:** a size audit only once p3 is built, and only where needed (decision "Chord is cut down at the end,
  if needed"). Chord's source is about 66k lines (`host/` 13k, `store/` 9k, the kit 4k, `delta/` 4k).
- **The page bundle:** `chord/web` minified is about 468 KB, 141 KB gzipped, when nothing is trimmed (a sync client is
  typically 20 to 40 KB). Measure p2's real page bundle by module (esbuild's metafile) before the UI slices.
- **Chord's slice 14 carry-over:** lists over several sources, examples 73 to 75, the link-level reload suite, shared
  reads between readers (`packages/chord/docs/slices.md`).
- **The server as the hub** is the scale-up bottleneck (slice 24, "Not now").

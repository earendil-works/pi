# Session Handoff Extension — v1 Design

Status: **approved design, not yet built** · Author: Kyle Disch (decisions) + Claude (spec) · Date: 2026-08-10

## What this is

A pi extension that automates session-to-session handoff. Every session leaves a
durable **handoff note** on disk — either a rich, LLM-composed one via `/handoff`,
or a mechanical digest written automatically when the session ends. New sessions
auto-detect the newest pending note and inject it as a briefing alongside the
user's first message.

This differs from upstream's `examples/extensions/handoff.ts`, which is an
in-process, interactive-only baton pass (generate prompt → edit → `ctx.newSession`)
that writes nothing to disk and cannot survive process exit. Ours is a dead drop:
it works across process boundaries, in non-interactive modes, and without the
user remembering to do anything.

### Locked decisions (Kyle, 2026-08-10)

1. **Storage:** project-local `.pi/handoffs/` with dated history (not latest-only).
2. **Ingestion:** first-message memo (`custom_message`, `deliverAs: "nextTurn"`).
3. **Consumed notes:** archived, never deleted.
4. **Auto-note at shutdown:** mechanical digest; no LLM calls in the exit path.
   `/handoff` is the rich, LLM-composed path.
5. **Format:** Markdown + YAML frontmatter.
6. **Forward-compat requirement:** every note carries a `kickoff` field — a
   ready-made opening prompt a future autonomous spawner can use to start the
   successor session (v2 north star: sessions detect stopping points / context
   fullness, spawn successors, ping Kyle via messaging when decisions are needed).

## Storage layout

```
<project>/.pi/handoffs/
  2026-08-10T22-15-00-000Z_a1b2c3d4.md     # pending note(s); newest = current
  archive/
    2026-08-09T18-02-11-421Z_99ffee01.md   # consumed or superseded notes
```

- Filename mirrors pi's session-file naming: ISO timestamp (`:`/`.` → `-`) +
  `_` + first 8 chars of the *writing* session's id. Lexicographic sort = age sort.
- **Pending vs consumed is encoded by location** (top level vs `archive/`), not a
  status field. On archive, `consumed_by` / `consumed_at` (or `superseded_by`)
  frontmatter is appended for audit.
- All writes are atomic: write to `<name>.md.tmp`, then `rename()`. No reader can
  ever see a half-written note.
- **Git hygiene:** the writer idempotently appends `.pi/handoffs/` to
  `<repo>/.git/info/exclude` (local-only ignore; never touches the project's
  tracked `.gitignore`). Skipped when cwd is not a git repo. We ignore
  `.pi/handoffs/` specifically — never all of `.pi/`, which some repos track
  (including this one).
- Scope is exact-cwd: notes are found by scanning `<ctx.cwd>/.pi/handoffs/`.
  Running pi from a subdirectory won't find project-root notes (v1 limitation;
  walk-up detection is a possible v1.1).

## Note format

```markdown
---
schema: pi-handoff/v1
session_id: 019feda9-55bc-797d-8b97-4fe03f430270
session_file: /Users/kyle/.pi/agent/sessions/--...--/2026-08-10T21-52-05-564Z_019feda9....jsonl
cwd: /Users/kyle/Projects/foo
created: 2026-08-10T22:15:00.000Z
source: command            # "command" (/handoff, LLM-composed) | "digest" (shutdown, mechanical)
model: google/gemini-3.6-flash
kickoff: "Continue implementing the reader module; start by wiring archive-on-delivery."
---

## Context
What we were doing, decisions made, key findings.

## Next steps
The concrete task the successor should pick up.

## Files touched
- read: path/a.ts, path/b.ts
- modified: path/c.ts

## Last exchange        (digest-source notes only)
**User:** <last user message>
**Assistant:** <first lines of last assistant reply>
```

Frontmatter is machine-read by the extension (schema check, kickoff extraction,
consumed stamping); the body is for humans and for the successor's LLM context.
A note that fails frontmatter parsing is treated as not-pending: warned about
once, left in place, never ingested or archived.

## Components and their exact pi hooks

The extension is a standard jiti-loaded factory (`export default function (pi: ExtensionAPI)`),
developed at `.pi/extensions/handoff/` in this fork (auto-loads when running pi
here — instant dogfooding), later symlinked from `~/.pi/agent/extensions/handoff`
for all-projects use. Pi's loader de-dupes by resolved path, so the symlink and
the project-local copy never double-load.

```
.pi/extensions/handoff/
  index.ts        # factory: registers command + event hooks, wires modules
  notes.ts        # note types, frontmatter serialize/parse, atomic write, archive ops
  digest.ts       # session entries → mechanical digest fields (pure functions)
  compose.ts      # /handoff LLM composition (prompt + ctx.modelRegistry.complete)
  reader.ts       # pending-note detection, memo injection, archive-on-delivery
  ghost.ts        # ask_predecessor: answer questions from the predecessor's transcript
  DESIGN.md       # this document
```

No npm dependencies — `node:fs`/`node:path` plus `@earendil-works/pi-coding-agent`
imports only. Keeps installation = "copy or symlink the folder."

### Writer A — `/handoff [goal]` (rich, LLM-composed)

- **Hook:** `pi.registerCommand("handoff", { handler })` — handlers get
  `ExtensionCommandContext`. The name is free (upstream's example lives in
  `examples/` and is not auto-discovered; if a user loads both, pi suffixes
  `/handoff:1`, `/handoff:2` rather than colliding).
- **Gather:** `ctx.sessionManager.buildContextEntries()` — *not* the hand-rolled
  branch walk upstream's example uses (it duplicates compaction logic and has
  drifted before). Serialize with the exported `convertToLlm` +
  `serializeConversation` helpers. Compaction-aware is right *here* because the
  serializer turns a compaction entry into a summary message, so elided history
  still reaches the composer; Writer B needs the opposite (see below).
- **Compose:** one-shot `ctx.modelRegistry.complete(ctx.model, …)` with
  `cacheRetention: "none"` and a fresh `sessionId` (uuidv7) so the call never
  pollutes the user's session. System prompt requests the note body sections plus
  a one-line `kickoff`. The optional `goal` argument steers "Next steps";
  without it, the prompt asks for state summary + natural next step (upstream
  hard-requires a goal; we don't — automation is the point).
- **Review:** in TUI mode, show the draft in `ctx.ui.editor()` for edit/approval
  before writing. When `ctx.hasUI` is false (`-p` / JSON modes), skip review and
  write directly — degrade gracefully where upstream hard-fails.
- **Write:** atomic write to `.pi/handoffs/`, then `ctx.ui.notify` the path.
- **Optional successor spawn:** in TUI mode, `ctx.ui.confirm("Start successor
  session now?")` → `ctx.newSession({ parentSession, withSession })`. This
  composes with the reader for free: `newSession` fires `session_start
  {reason:"new"}`, our own reader detects the just-written note and injects it.
  All post-switch work uses only the `withSession` callback's fresh context
  (captured `ctx`/`pi` are invalidated after replacement — the documented
  footgun that has bitten upstream's example before).
- Sets an in-memory `wroteNoteThisSession` flag (see Writer B).

### Writer B — shutdown digest (mechanical safety net)

- **Hook:** `pi.on("session_shutdown", handler)`, acting **only when
  `event.reason === "quit"`** — the event also fires for `reload`/`new`/`resume`/
  `fork`, which must not each drop a note.
- **Skip when:** `wroteNoteThisSession` is set (the `/handoff` note is richer; a
  later digest would supersede it as "newest" with worse content — accepted v1
  simplification: work done *after* `/handoff` but before quit isn't re-captured);
  no assistant message exists on the active branch (nothing happened — also covers
  the fact that pi's session file isn't even flushed to disk until the first
  assistant reply); or `getSessionFile()` is undefined (`--no-session` ephemeral
  runs — the user asked not to be recorded; honor it).
- **Entry source:** `ctx.sessionManager.getBranch()` — the active leaf-to-root
  path, every entry type, no compaction fold. Not `getEntries()` (flat
  append-order across *all* branches, so a `/tree` rewind leaks abandoned work
  into the digest) and not `buildContextEntries()` (drops everything before
  `firstKeptEntryId`; since this walk reads only `message` entries, that would
  silently shrink "files touched" to the post-compaction tail).
- **Digest fields** (pure in-memory walk of `ctx.sessionManager` — no LLM, no
  network, bounded, idempotent; a hung shutdown handler hangs pi's exit):
  last user message; first ~15 lines of last assistant reply; files touched
  (walk assistant `toolCall` content blocks for `read`/`write`/`edit` path
  arguments, deduped into read vs modified); current model; session file path +
  id; mechanical `kickoff` = `"Continue: <first line of last user message>"`.
- **Files-touched bounds:** each list is capped at 20 paths and 600 characters,
  with an `(and N earlier omitted)` suffix. The cap keeps the **most recently
  touched** paths, not the first: the walk above is deliberately un-folded, so on
  a compacted session the list is long, and the successor needs the files that
  were in flight at exit rather than the ones opened while getting oriented.
  Paths are never truncated mid-string — one that cannot be shown whole is
  omitted and counted, since a chopped path still reads as a real one.
- Works identically in all modes (`notify` only when `ctx.hasUI`).
- Known limits, accepted: shutdown is best-effort in pi (fatal-error exits and
  SIGKILL skip it). `/handoff` is the reliable path; this is the seatbelt.

### Reader — detect + inject + archive

- **Detect** on `pi.on("session_start")` for `reason` `"startup"` or `"new"`
  only. `resume`/`fork` sessions carry their own live context — injecting another
  session's briefing there invites confusion (judgment call; revisit if wrong).
  Scan `<ctx.cwd>/.pi/handoffs/*.md`, parse frontmatter, pick the newest valid
  pending note.
- **Inject:** `pi.sendMessage({ customType: "handoff", content: memo, display:
  true }, { deliverAs: "nextTurn" })`. The memo = banner line ("Handoff from
  session <id-prefix>, ended <time>") + note body + session-recording pointer +
  one line listing any older pending notes. `nextTurn` parks it until the first
  real prompt — no LLM call is burned on an idle session, and the memo persists
  as a first-class `custom_message` entry in the successor's transcript. Crucially
  this is **spawn-agnostic**: the "first prompt" can come from a human, `pi -p`,
  RPC, or a future autonomous spawner — the memo attaches regardless.
- **Archive on delivery, not on detection:** `session_start` only *queues* the
  memo and remembers the note path in memory. The first `before_agent_start`
  (i.e., the user actually submitted a prompt — the memo is now really being
  delivered) moves **all** pending notes to `archive/`: the ingested one stamped
  `consumed_by: <session id>` / `consumed_at`, older ones stamped
  `superseded_by: <ingested note filename>`. If the session is opened and quit
  without a prompt, the note stays pending for the next session — the briefing
  is never lost to an aborted start.
- **Concurrency:** two sessions starting at once may both queue the same note;
  the second archive `rename()` fails ENOENT and is swallowed. Both ingesting
  the same briefing is acceptable; losing it is not. (Pi's v3 session layer has
  no locking either; atomic rename is our only primitive and it's sufficient.)

### Nice-to-have (build only if trivial): `pi.registerMessageRenderer("handoff", …)`
for a styled memo box in the TUI. Default `custom_message` styling is acceptable
for v1.

## Failure modes considered

| Failure | Behavior |
|---|---|
| Corrupt/unparseable note | Warn once, leave in place, never ingest/archive |
| Shutdown handler slow/hung | Impossible by construction: no network, no LLM, in-memory walk + one atomic write |
| Session file not yet on disk | Digest skips (no assistant message ⇒ nothing to hand off) |
| `.jsonl` hazard in session dirs | N/A — notes are `.md` in the project, never in `~/.pi/agent/sessions/` |
| Stale ctx after `newSession` | All post-switch work confined to `withSession` callback |
| Extension throws anywhere | Pi contains it (logged, other extensions unaffected) — but every handler still guards its own I/O |
| Both our extension and upstream example loaded | Commands suffix to `/handoff:1`, `/handoff:2`; no data conflict (example writes nothing) |

## Build plan (value-ordered slices)

1. **`notes.ts` + Writer B** — storage, format, atomic ops, shutdown digest.
2. **Reader** — detection, memo injection, archive-on-delivery.
   *After slices 1+2 the automated loop already works end-to-end with zero LLM involvement.*
3. **Writer A** — `/handoff` LLM composition, editor review, optional successor spawn.
4. **Polish** — git-exclude hygiene, older-notes notice line, message renderer.

Each slice: unit tests for the pure modules (`notes.ts` parse/serialize
round-trip, `digest.ts` entry-walking against a fixture session JSONL — the real
specimen at `~/.pi/agent/sessions/--Users-kyledisch-Projects-pi--/` is a good
fixture source), plus a manual smoke via `pi -e .pi/extensions/handoff/index.ts`
in a scratch project. LLM smoke tests use Google Gemini free tier only — never
Anthropic subscription auth (bills per-token).

## Verification gates

This extension lives outside `packages/`, so none of the repo's own gates reach it:
`.pi/**` is absent from `tsconfig.json`'s `include` and `biome.json`'s `files.includes`,
and it is not an npm workspace, so `npm run check` and `npm test` skip it silently.

Tests and typecheck are gated by their own workflow, `.github/workflows/handoff-ext.yml`,
kept as a separate file so rebasing this fork onto upstream pi never conflicts there. Run
the same two commands locally from the repo root:

```
node node_modules/vitest/dist/cli.js --run --config .pi/extensions/handoff/vitest.config.ts
npx tsgo --noEmit -p .pi/extensions/handoff/tsconfig.json
```

Formatting is the remaining gap: `biome check` ignores the path by config, and covering it
would mean editing `biome.json` — a shared upstream file. Format by hand when needed with
`--config-path` pointing at a copy of `biome.json` whose `files.includes` is
`["**/*.ts", "!**/node_modules/**/*"]`.

### What the unit tests do *not* cover: `index.ts`

`index.ts` is the one module with no test file, and that is a standing decision rather than an
oversight. It has runtime (non-type) imports from `@earendil-works/pi-ai`, `pi-coding-agent`, and
`pi-tui`; importing it from a test under this vitest config fails with `Cannot find module
'…/handoff/string_decoder'`. Every other module keeps its pi imports type-only, which is why they
are importable — `reader-wiring.test.ts` works only because `reader.ts` obeys that rule.

**The blocker is a vitest resolution setting, not an architectural one, and the difference matters
— an earlier draft of this section claimed the latter and was wrong.** Adding
`test.server.deps.external: [/.*/]` to `vitest.config.ts` makes `index.ts` importable with no
source change at all (measured: the full suite plus one added `index.ts` import probe passes with
the key, and the same probe fails without it — stated relatively because the suite's own count has
since grown past the 104 recorded at the time). No
extraction is required. What that key costs is the reason it is not taken: it hands every `.ts` in
this suite to Node's type-stripping instead of vite's transform, changing how all five existing
test files are loaded to buy coverage of one. That tradeoff deserves its own change, evaluated on
its own, rather than riding along with a bug fix.

So for v1: keep `index.ts` thin — registration and wiring, with the logic it wires living in the
tested modules — and cover it by manual smoke run (`pi-test.sh -e .pi/extensions/handoff/index.ts`,
Gemini free tier). The exposure is real and worth naming: the editor round-trip, the
successor-spawn confirm, and the `mode`-vs-`hasUI` gate are verified by hand or not at all.
Anything that grows past wiring should move out of `index.ts` rather than being tested in place.

## Ghost responder — `ask_predecessor` (added 2026-08-11)

The successor's escape hatch when the briefing isn't enough: a tool that answers
clarifying questions **as the previous session**, from that session's saved
transcript (`session_file` in the note frontmatter). One isolated LLM call
(`cacheRetention: "none"`, own session id — same isolation as `/handoff`'s
composer) over transcript + question; no coordination with the predecessor, which
may be days gone. When both sessions are alive simultaneously, the live channel is
the sibling `intercom` extension — the two compose rather than compete.

- **Hook:** `pi.registerTool("ask_predecessor", …)`; errors are thrown (pi's
  tool-error contract), never returned as text.
- **Predecessor selection** (`findPredecessor`, disk-scan so it survives
  `/reload`): the archived note stamped `consumed_by` = this session, else the
  newest pending note, else the newest archived note; notes without
  `session_file` are skipped everywhere.
- **Transcript rendering** (`renderTranscript`): active branch only (walk
  `parentId` up from the last entry — same rewind reasoning as the digest's
  `getBranch()`), user/assistant text plus `[ran <tool> <args-preview>]` markers
  (arguments capped at 200 chars) and `[<tool> result] <head-preview>` lines
  (300 chars) — so "what did you run/send/see?" is answerable — tail-capped at
  150k chars overall.
- `notes.ts` gained `listArchivedNotePaths`; everything else is additive.

## Explicitly out of scope for v1 (v2 hooks noted)

- Context-fullness watcher (`ctx.getContextUsage()` checked on `agent_settled`)
  proposing or auto-running `/handoff`.
- Autonomous successor spawning (the `kickoff` field is the contract it will consume).
- Messaging integration (Slack/Telegram ping at decision points).
- Repo-scoped event ledger (the dated-history `handoffs/` dir is its seed).
- Walk-up note detection from subdirectories; cross-cwd note routing.

---

**Run-config note:** build this with a fresh session started from this file —
recommended **Opus 5, effort high** (well-specified build, no open design
questions): `claude --model claude-opus-5 --effort high`, opening prompt
"Implement .pi/extensions/handoff/DESIGN.md, slice by slice."

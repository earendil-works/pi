# p3 handoff: everything needed to continue

Written 2026-11-06 by the Chord v2 / p3 session (conversation 8b6ab5cc-8f95-421b-989a-de109636ff5a), at the owner's
request before a context handoff. Read this file first, in full, then the reading list below, in full.

## 1. What p3 is and where it stands

- p3 is the successor of p2 (Pi Mobile), built **tabula rasa on the Chord v2 app kit**, next to p2. The owner:
  "leave p2 to the kids". p2 stays his daily driver on the phone until p3 replaces it.
- **p3 lives on `main`** of github.com/earendil-works/pi, in `/home/badlogic/pi`, in `apps/p3/` (owner, 2026-11-07:
  "switch to main, p3 can live there too, branch sucks"; the `p3` branch was rebased onto main and merged, b89b2232c).
  No branches, no worktrees: work in `/home/badlogic/pi` on main; other sessions share the checkout (commit only your
  own files).
- **Nothing is specced or built yet.** Next action: write the **step-0 skeleton spec** (section 4) as a Radius artifact
  with the explainer skill, get two reviews, bring it to the owner.
- **Specs are "nice Radius artifacts using our beautiful explainer"** (owner): Markdown in `apps/p3/docs/<step>/book.md`,
  built with the explainer skill (`/home/badlogic/.pi/p2/skills/explainer/SKILL.md`, read it first; build:
  `node /home/badlogic/.pi/p2/skills/explainer/build.mjs <book.md> -o <index.html>`), published with organization visibility:
  `mcporter call radius.artifacts_create title="..." visibility=organization content_type=text/html content=@<index.html> --no-oauth --output json`
  (new version: `radius.artifacts_versions_publish slug=<id> content_type=text/html content=@<file>`). mcporter is in
  the Node bin dir below. Inline SVG diagrams in specs; sequence diagrams as SVG, never ASCII art.

## 2. The owner's rules (binding)

- He wants things done, but genuinely new decisions go to him **one at a time**, explained with concrete code and
  sequence diagrams (SVG), no invented APIs. Record each decision at once in `packages/chord/docs/decisions.md` (Chord
  decisions, on main) or `apps/p3/docs/decisions.md` (p3 decisions) and push.
- **NEVER commit (or push) source code before the owner reviewed it** (owner, 2026-11-06: "never ever commit again
  before i review"; "i don't need to review docs, only source code"): docs, specs and decision entries may be committed
  without his review; code (src, tests, examples, configs) only after he reviewed the diff.
- Subagents on `radius/claude-opus-5-5` (never Fable, not direct anthropic); correctness reviewers also GPT-6 Astra and
  GPT-6.1 Sol (`openai-codex/gpt-6-astra`, `openai-codex/gpt-6.1-sol`) when the owner asks. Subagents never commit. Build subagents work in the shared checkout on main (no worktrees, owner).
- Never a file write and a dependent git command or subagent message in one parallel batch.
- NEVER call history_handoff unless the owner explicitly asks.
- Radius artifacts get organization visibility (owner, 2026-11-08); never public without asking. Never print credentials.
- Cross-session messages (`conversations send`) only work in turns the owner started.
- Voice mode (when the system prompt has a voice section): short spoken sentences, no markdown, hand long work to a
  doer subagent.
- He is often at his limit: keep answers short, concrete, one decision at a time, recommendation first. When he is
  overwhelmed, say where we stand in a few lines.
- He dislikes p2-isms carried over ("admission fences, input gates, choices, peers": p2 internals renamed instead of
  questioned) and parallel object systems next to Chord ("use Chord as designed").

## 3. p3 principles and decisions so far (owner)

- **Process per step:** a minimal spec in Chord terms (Radius explainer artifact) → two reviewers (one adversarial,
  one against design.md) → owner approval → build (subagent in the checkout, Chord code style, tests, example) → two code
  reviewers → fixes → commit on main (code only after the owner reviewed it) → the owner beats it up → next step. Pluggability check for every part:
  could a third-party plugin provide this, or an alternative, the same way?
- **Vocabulary stays small:** hosts, one owner object per thing (shared store + per-principal views, design §6),
  registries as extension points (§17), the harness (§24), tools. No p2 names unless they earn it.
- **One provider per thing:** same host via a registry; across hosts via object methods and state.
- **Natives only in objects**, reached through registries; derives JSON only; in-process values that change are
  `self.writable` set by a routine; no throwing `nativeOf` getters, no throwing registry composes to "park".
- **Tables are first-class:** anything listed, queried, paged or filtered is a table (`self.table`, `self.query`).
- **External state is followed (`self.follow`), never copied**; long work is a job; methods that should feel instant
  await their own effects on the answering host; roots inside methods take the method's ctx; a session's worker owns
  its data and pushes what the server's index shows, never pulls (decision "App authoring rules confirmed by the p2
  audit", 2026-11-05).
- **Optimistic UI:** `useOptimistic` on the web, `TuiScope.optimistic(read, reduce?)` in terminals; Chord guarantees a
  call's answer follows its state (decision 2026-11-05).
- **Reloads:** restart-only with old work finishing on old code, `reloadDrainTimeout` 5 s (decision 2026-11-05, design
  §21). Keep base code thin, put the UI into plugins, so almost every change is a plugin reload. Base code changes
  (API modules, start script, Chord/React, base bundles, worker entry) need a server restart.
- **Tool access:** `origin` (owner-only turns) is OUT (illusory against prompt injection); `scope` stays (structural);
  no new fields on tool declarations; no hardcoded tool lists; script-only tools via Durable `callers: ["tools"]`; the
  extensions registry's compose applies the tool_search fallback when code mode is absent.
- **Resources** (renamed from "contents"/"stuff"): anything brought into a session is usable by everyone who can send
  inputs there; nothing personal is brought implicitly; tools see only the session's resources. A session-owned
  document `{ kind: "everything" } | { kind: "locked"; things: ThingAddress[] }` (address = contract name + params),
  served and checked by the session's worker (local reads, tools refuse at use, tool lists stay stable), synced,
  copied on fork/clone. UI: "Lock down this session" with one row per plugin via a slot. Resources as Chord types +
  params, never a parallel resource system (the owner rejected ResourceKind/providers/refs/handles).
- **Multi-user:** designed, deferred; must stay possible. Per-user stuff is state keyed by user id in server stores
  (not a user host kind); default user auto-created; MCP accounts via an envelope `{ account?, input }`.
- **Models:** plugins can provide model providers (a providers registry; shape undecided). Workers get only access
  tokens of the session's providers as view state; the server refreshes.
- **Config files:** one owner on the server per file; workers follow its state and write through its methods.
- **SSH:** one owner per environment. Hands (pi-env on machines) connect to the brain (server) in the target model.
- **Performance:** data plane in the worker (model calls, tool streams); per-call checks are local reads; cache
  credentials; measure startup IPC round trips on the phone.
- **Where things live:** nothing about turns, drivers or tool access goes into Chord or the kit; it is the harness's
  (p3 plugins).

## 4. Step order (proposed by cbe4592b and me; the owner said the order is open; step 0 first is agreed)

0. **Skeleton:** app kit `startServer`/`startWorker`; an API package (`@p3/app/v1`, per-kind modules); server + worker
   kind `session({ id })`, each session with its own store; the Harness (host-lifetime local object in the session
   worker, Durable opened paused on the session store, resumed after load, design §24); the extensions registry (one
   Durable Extension per plugin, writable); the `chord(fn, context)` helper (host in Durable's base context, §24 Q6);
   the session catalog as a server **table** with per-principal views, the worker pushing title/status; owner sign-in
   (kit: one-time link token); a thin web base with the chat UI and session list as plugins; optimistic create/send; a
   fake model provider as the first entry of a providers registry. Done when: create a session, send, streamed fake
   reply, survives page reload, plugin reload and server restart; tests; runs on the phone next to p2 (own data dir,
   e.g. `~/.p3`, own port: propose, not decided).
1. Models (providers registry, real providers).
2. Hands: local and SSH environments as providers, coding tools.
3. Resources and sharing (lock down, guests).
4. MCP.
5. Subagents, one-shot agents, code mode.
6. Files (uploads, artifacts, files tool).
7. Discord (needs sharing, resources, sandboxes).
8. The rest: Radius, ports, terminals, TUI, voice.

## 5. Reading list (read in full before writing the step-0 spec)

State and history:
- `/home/badlogic/chord-state.md`: session state, rules, where things are (it predates p3; its "Open now" reload items
  are settled by the 2026-11-05 decisions).
- `/home/badlogic/chord-notes/p3-kickoff.md`: the Discord session's briefing condensed. The full briefing is in
  conversation 8b6ab5cc (history_search "Tabula rasa" or "top grade garbage").

Chord (the rulebook):
- `packages/chord/docs/design.md`, all of it. For p3 above all: §3 (hosts, links, routes), §4 (principals), §5-§8, §9-§11
  (documents, store, tables, live queries), §12-§15 (derives, natives, routines, jobs), §17 (registries), §19
  (presence), §21 (reload), §22 (wire), §23 (HTTP, workers, the app kit, web and TUI surfaces, messages/languages),
  §24 (Durable integration: the harness object, registries for models/envs/extensions, Q6 `chord(fn, ctx)`), §29
  (telemetry).
- `packages/chord/docs/decisions.md`: every entry dated 2026-11-01 to 2026-11-06 (plugin model, app kit points 1-5,
  slice 11 P3-P9, i18n, themes, reload model, answers follow state, app authoring rules, worker base, per-host stores
  and Files v2).
- `packages/chord/docs/plugin-authoring.md`, `packages/chord/src/node/app/README.md` (the kit),
  `src/node/workers/README.md`, `src/node/surfaces/README.md`, `src/node/plugins/README.md`, `src/registries/README.md`,
  `src/react/README.md`, `src/tui/README.md`, `packages/chord/docs/guide-plugins-hosts/book.md` (incl. Optimistic UI).
- The kit tutorial `packages/chord/docs/tutorial/book.md` and its app `packages/chord/test/examples/61-tutorial/`
  (a complete kit app: the closest thing to a p3 skeleton); examples 58-themes, 59-chat, 60-session-sync, 63, 64, 65-files.
- Code of the kit: `packages/chord/src/node/app/` (app.ts, worker.ts, files.ts, layout.ts, owner.ts, sessions.ts,
  pairing.ts), `src/node/surfaces/` (web.ts, tui.ts, bundle.ts, published.ts), `src/node/workers/`.

Durable:
- `packages/durable/docs/spec.md` (harness, conversations, tasks, extensions, `callers`, forks), and the harness entry
  points p2 uses (`apps/p2/src/runtime/durable.ts`, `apps/p2/src/hosts/worker.ts`) as a reference of what is needed,
  not of how to do it.

p2 (reference only; do not port its structure):
- `apps/p2/docs/p2-notes.md`, `apps/p2/docs/optimistic-ui.md`, `apps/p2/docs/remote-envs.md` (sandboxes),
  `/home/badlogic/chord-notes/p2-optimistic-audit.md`.
- Research (copies in `/home/badlogic/chord-notes/research/`): `agents-workspaces.md` (OpenCode workspaces and
  providers, Ultimate, Amp Spaces: borrow OpenCode's provider contract for sandboxes, Amp's settings merge),
  `session-stuff.md` (every resource consumer in p2), `worker-redesign.md` and `service-objects.md` (the REJECTED
  redesign: a catalogue of p2's mess, not a model), `reviews/worker-astra.md`, `reviews/worker-sol.md` (real problems to
  avoid: derives producing functions; startup cycles; a lost relocation fence; MCP lease not re-sent on server
  reactivation; unstable provider tool schemas; envs not pluggable when listing is server-only and SSH-typed;
  location mover retries; private-path checks).

Radius artifacts (owner-facing; read with mcporter `radius.artifacts_read` / `artifacts_files_download`):
- Tool access "Who May Call What" 01m6r4rywzfyg8t8azyzpvg6fs (16 scenarios: a requirements list for resources and
  sharing); multi-user 01m6rat6w9ew8sssmyrm0rpg4j and users 01m6rt283dee0spr5xv0k6hmkb; brain-and-hands
  01m6rhhgvrfgj94pn1wf9jmn5w (brain = server + sessions, each session one Durable harness; hands = pi-env on machines
  connecting to the server; Radius = the outbound brain connection: relay, forwards, model gateway, artifacts, MCP);
  research 01m6s536gge4gv8bsn7g4apppy; services (rejected) 01m6sc0dvte2wsszcy4xkd14rs.

## 6. Working setup on slayer

- Node 24: `export PATH=/home/badlogic/node-v24.4.1-linux-x64/bin:$PATH`. Node 26 for TUI tests:
  `LD_LIBRARY_PATH=$HOME/node26-lib /tmp/n2613/node-v26.13.0-linux-x64/bin/node`. Chromium:
  `CHROMIUM_BIN=$HOME/.local/bin/chromium-docker`.
- Fresh worktrees need `npm ci --ignore-scripts` and a copy of the gitignored model data:
  `cp -r /home/badlogic/pi/packages/ai/src/providers/data <worktree>/packages/ai/src/providers/`.
- Checks: `npm run check` (root), app checks in `apps/<app>` (`npm run check`). Chord tests from `packages/chord`:
  `node ../../node_modules/vitest/dist/cli.js --run <paths>` (full suite after `npm run build`).
- Commits: explicit paths, `{feat,fix,docs}(scope): ...`, push `git push origin main`; main's CI:
  `gh run list --repo earendil-works/pi --branch main --workflow CI`.

## 7. Other open threads (not p3, keep track)

- Phone: runs pi main d07548004 + later deploys by phone dev (session d602d653, deploys only in owner-started turns).
  Not yet on the phone as of writing: c96e368e2 (remote bash abort fix, packages/env, needs a restart), 1ff411300
  (composer tap fix; the owner said it works, maybe through a plugin reload). Tell phone dev "deploy" when the owner
  says so.
- Phone dev was asked to adopt the deploy rule "pull; if p2's dev state says no restart is needed, `npm run reload`,
  else restart" for pure web changes (p2 rebuilds its web bundle on every plugin reload; pages reload on a new
  manifest).
- Discord session cbe4592b has an uncommitted p2 fix (transcript rows re-rendering) waiting for the owner.
- Chord carry-over: the kit cannot rebuild a surface's base bundle without a restart (build when p3 needs it); a
  generic app-defined record on calls from trusted links (only if many resources need drivers-like data across hosts).
- Armin's worker-start proposals (route retries with backoff replacing R2, refusal vs transient, ready timeout) are
  parked; fold into p3's hands/workers step.
- Idle reusable subagents: restart-study (built the reload model), reload-review-2 (adversarial reviewer),
  reload-final-3, s8-spec-opus, telemetry-gaps, trace-chapter. The owner's own: issue-10959, ultimate, p3-walkthrough.

# Handoff: Chord v2 and p3 (read this first after every compaction)

Maintained by the redesign session (`8b6ab5cc-8f95-421b-989a-de109636ff5a`, runs in p2 on the phone; its tools run on
slayer). Updated whenever the state changes, together with the decision log. Use `history_search`/`history_read` for anything
not written here.

## 1. What we are doing

Redesigning Chord (the object runtime) and p2 (Pi Mobile) from scratch as **Chord v2** (`packages/chord/src`)
and **p3** (`apps/p3`, later). Goal (owner): a minimal, powerful runtime with the fewest footguns, no memory leaks, the
best possible performance and easy-to-grok code (size is not a goal by itself: owner, 2026-10-27).

## 2. The process (owner's)

Chord v2 is built in **vertical slices** (`packages/chord/docs/slices.md`), each the thinnest end-to-end path
through the layers it needs. Per slice: a spec written by this session (`slice-N.md`), reviews of the spec (Astra,
Fable), the owner's approval, a build by a fresh Opus builder (never commits unless told), reviews of the uncommitted
code (this session, Astra, Fable), fixes, the owner's review, commit. Every slice adds runnable examples
(`test/examples/NN-topic.ts`); hot-path slices add benchmarks (`benchmarks.md`). Code follows the root
AGENTS.md section "Chord v2 Code Style". Decisions go into the log at once and into `design.md` in the same commit.

## 3. Where we are (update this section)

**UPDATE 2026-11-03 midday (supersedes what follows):** p2 runs on Chord v2: private `16329187c` (switch), phone
deployed 12:38 (backup `~/p2-backup-20261103-1235/`, data-report --compare only growth, verify-sessions clean).
Phone lesson: a pull without restart is not inert (the dev server hot-reloads changed plugins). Biome fix for the
phone's WASM fallback `6c425c2c5`. Upstream since: loud mistakes `5bd014b1c` (+ test race `0c7c74198`), workers type
fix `51bb8f5c0`, tutorial `24d3993b2` (Radius 01m6g8fnaqfdsa8ad21y2dfpy8; p2 chapter example waiting in
`/tmp/tutorial/p2-chapter-example/`), int table keys `d7704516e`. Footguns list `/home/badlogic/p2-port/chord-footguns.md`
(13 + 4 tutorial); owner: no trial app, p3 finds and fixes as we go. Open: C1 delete Chord v1 (`src/old`), C2 p2 TUI
on Chord's child-process sandbox, place the tutorial's p2 example, Chord gaps (React state across plugin reload vs
P4, one-time read forces restart, contract imports in tests, `invalid` not exported), i18n build, slice 9.

**UPDATE 2026-11-03 night (history):** Chord v2 is the package root: upstream `e9c0ff4d8` (CI green),
private `ce43d89b8` (p2 imports v1 from `/old`); Chord docs now `packages/chord/docs/` (decisions.md, design.md,
slices.md), examples `test/examples/`. 59-chat on a table upstream `3c7a9ca0e`. Decision "p2 moves to Chord v2, then
v1 is deleted" (`d5c4b80eb`, owner yes to all 11 points; 7 = createHttp later). Running overnight (owner wants the
port done by morning, no phone deploy): `ui-back` (Opus; brief `/tmp/ui-back-brief.md`, report `/tmp/ui-back/report.md`;
worktree `pi-ui-back` + `/home/badlogic/bundled-ui-work`; reverts Cristina's `1cf20071f`, ports bundled-ui UI changes
back, bundled-ui builds from pi-private; UNCOMMITTED until the owner checks in the morning) and `p2-port` (Opus;
worktree `/home/badlogic/pi-p2-v2`, brief `/home/badlogic/p2-port/build-brief.md`, plan `/home/badlogic/p2-port/plan.md`;
P1-P3, S0 now; after ui-back, bring its result into pi-p2-v2 and tell p2-port to do S1-S8 with the UI; I make local
checkpoint commits there, never pushed until reviewed). Chord move scripts kept in `/home/badlogic/chord-root-move/`.
bundled-ui is public on purpose (jsDelivr needs it); its git history holds the UI source.

**UPDATE 2026-11-03 (history):** slice 11 committed upstream `5bc414516` (CI green), merged into
private `46905bc1c`. Decided and recorded: i18n (`9c248717d`, built after slice 11: carry-over), Chord v2 becomes the
package's root (`1d81a6972`: src/old, /json and /watch subpaths, short Node subpaths, docs -> docs, no version
bump). schema-guard scripts deleted (owner). `chord-root` is doing the real run (brief `/tmp/chord-root-run-brief.md`,
scripts `/home/badlogic/chord-root-move/`): worktrees `pi-chord-up` (upstream part) and `pi-chord-priv` (p2's part);
then an Opus reviews package description/README wording; then commit upstream, merge into private, commit p2's part.
Next after that: i18n build, telemetry (slice 9), small examples; p3 work packages after the meeting.

**UPDATE 2026-11-02 late night (history):**
- Slice 11 sandbox is a child process (decision "The terminal's sandbox is a child process", upstream `128912d24`,
  design `10cf3264f`, slice-11.md `65c85bda2`). Opus rounds: recheck 2 (`/tmp/s11-recheck2-opus.md`: E7 getter on
  process prototypes, E8 SIGUSR1, E9 attach before yes, E10-E13) fixed by audit-builder (round 3); recheck 3 running
  in `s8-spec-opus` (`/tmp/s11-recheck3-opus.md`). pi-s11 is a local commit `wip slice 11` (made with --no-verify:
  REDO the final commit with hooks, amend message), rebased on upstream/main (no conflicts), slices.md carry-over
  cleaned and "What exists" gained 11-13, package-lock regenerated with npm 11.21.1 (`/tmp/npmlatest`, the repo's
  lock needs a newer npm than node 24's 11.4.2) and left unstaged; `npm run check` clean; full Chord tests running
  (`/tmp/s11-final-tests.log`). Then: commit (amend, PI_ALLOW_LOCKFILE_CHANGE=1 with package-lock.json), push
  upstream, CI, merge into private.
- `chord-root` subagent (Opus) in `/home/badlogic/pi-chord-root` (worktree of origin/private): trial of making Chord v2
  the package root, old v1 to `src/old` or p2 (Durable and env import the root too), as a re-runnable script
  (`/tmp/chord-root/`), brief `/tmp/chord-root-brief.md`, report `/tmp/chord-root/report.md`. Owner wants pi-private
  merged (into pi) this week.

**CURRENT STATE 2026-11-02 (night); the older paragraphs below are history.**
- **Owner's working mode now:** "go ahead, just do all the things. tired of reviewing": this session writes specs,
  runs builds, reviews and fix rounds, commits and merges without asking per point; only genuinely new decisions go to
  him (explain with code; one at a time). All subagents on `anthropic/claude-opus-5-5` (never Fable: "costs too
  much"; `s8-spec-fable` is just a name, it runs Opus). Sol (`s8-spec-sol`) and fresh reviewers keep failing with
  model_error on security reviews: drop them, use Opus (`s8-spec-opus`) alone if needed.
- **Committed upstream (CI green, merged into private `edf7b4bed`):** slices 10, 12 (`9823079ad`, plugin model), 13
  (`072e413bf`, app kit), the schema switch (pi-schema, TypeBox gone except coding agent; `6536f8012`, `be039fb31`,
  `a6bde34`, `6291b9bcc`), example `60-session-sync` (`15f00a786`). p2 migrated to pi-schema in private; phone runs
  `66641ca8c` (voice fixes round 2) + sts-server `08f6cf8d6` (partial transcripts) deployed on slayer.
- **Slice 11 (web and TUI) is building, uncommitted:** `audit-builder` in `/home/badlogic/pi-s11` (base upstream
  `d6af4d18e`; later docs commits not imported: rebase at commit). Built: surfaces, `startPage`, React hooks, themes,
  TUI launcher + sandbox, app-kit follow-ups (`startServer`, `exportData`/`importData` without stopping), example
  `59-chat` (worker per channel, uploads), fix round 1 done. **Now:** the TUI sandbox becomes a **child process**
  (owner decided after Opus escaped the hardened worker twice: `/tmp/s11-recheck-opus.md` E1 `Set.prototype.has`, E2
  `EventEmitter.prototype.emit` → real `process`): pipes not the terminal, env {}, `--permission`,
  `--no-experimental-sqlite`, length-prefixed frames, allowlist kept as second layer, V8 eval-flag toggle dropped,
  E3-E6 launcher fixes, escape tests ported, benchmark vs the worker (startup, 160 KB frame loop, key latency).
  Then: Opus recheck/escape round, fix, commit (rebase on upstream, check, Chord tests, CI), merge into private.
  Known gap: the child can still signal user processes (`process.kill`); in the Node gist.
- **Node gist for Matteo** (owner forwarded): https://gist.github.com/badlogic/a83cd80d0669dbcf77e029ac7b25ac96
  (`/tmp/node-gist/`): sqlite ignores fs permissions (and writes despite ERR_ACCESS_DENIED), fd/tty writable, real
  `process` via EventEmitter.prototype; asks: sqlite checks, fd permission, per-Worker permissions, signals/env.
- **Decided today, recorded in `decisions.md` (upstream), not all folded into design.md yet:** plugin model points
  1-8 (folded §21), app kit points 1-5 (folded §23), slice 11 P3-P9, looks and themes, `chord.plugins` as manifest,
  App kit naming and export, sync applies batches with the host stopped, p3 meeting summary (Armin), p3 notes
  (subagent `context: "inherit"`, `/tree` as in-session forks).
- **Open with the owner:** i18n for the app kit (explainer `docs/i18n/`, Radius 01m6ek54jff7atbe4rrkg1w3zz v3:
  `defineMessages` per plugin, shared `messages.ts`, `t.message` typed messages as data, `Translations` registry per
  host, locale per user, servers send keys) - asked "record as decided?", no answer yet. Building it would follow slice 11.
- **Meeting doc for p3** (2026-11-03): `docs/p3-features/` (book.md with {{img}}/{{clip}} tokens; build with
  `/tmp/p3-doc/inline.py` then the explainer build; pictures in `/tmp/p3-prep/shots/`), Radius 01m6efr04nezms4zx32p7pp0w1
  v2. Research files `/tmp/p3-prep/{features,extensions,envs,sync-example}.md`. Other explainers today: theming
  (`docs/theming/`, 01m6ecp0ndf8hb1m0ea6dqy8jn), plugin primer (01m69waqspfwwt21bjhvsp5w28), schema charts
  (01m69x3dz2fsg9k1r33vde7hv6 v6).
- **Worktrees:** `/home/badlogic/pi-observers` (docs, detach to upstream/main before each edit), `pi-s11` (slice 11),
  `pi-sync-ex` (sync example, committed), `pi-s12`, `pi-s13` (committed slices), `pi-schema-switch`,
  `pi-schema-chord`, `pi-schema-pkg` (schema work, committed; guard scripts untracked in pi-schema-switch,
  `packages/coding-agent/scripts/schema-guard/`, owner never decided keep/drop), `p2-voice`, `p2-shots`,
  `p2-schema` (private, committed), `/home/badlogic/pi-private` (private), `p2-live`, `pi-mono` (owner's). Phone deploys
  only through the phone dev session `d602d653-61f1-4f99-aa54-99267e9dbf4e`, from owner-started turns.
- **Next after slice 11:** i18n (if decided), telemetry (slice 9), the small-examples pass; p3 work packages after the
  2026-11-03 meeting.
- **Process lesson (again):** never run a file write and the dependent git command in one parallel tool batch (it
  happened 3 more times today).

State as of 2026-10-28: **slices 6b and 8 are committed upstream** (pi `main`: 6b `14b4c56e5`, the design-audit fixes
for slices 1-6a `391e83fb1`, slice 8 `6eb99ad65`; CI green; merged into `private` `c684ee727`). Since 2026-10-27 all
of Chord v2 (`src`, its tests and `packages/chord/docs`, the decision log `decisions.md` included) lives in
pi upstream: commit there first (worktree `/home/badlogic/pi-observers`, detach to `upstream/main`), then merge into
`private`. p2's check is clean on `c684ee727`; the phone runs `ff7cdfeae` (p2 itself unchanged since). Next: slice 7
(reload and rollout): spec written by this session reading the code itself, decisions one at a time, spec reviews,
build, reviews. Then slice 9 (telemetry; C11 `ctx.trace` to decide).

**State 2026-10-29 (afternoon):** slice 7a (the dependency model) is committed upstream (`339847eb1`, CI green, merged
into `private`). Slice order now (owner): 7b reload in the kernel, 7c loader and dev, 10 HTTP and workers, 11 web and
TUI (the app kit, optional `chord/*` subpaths), 9 telemetry last. 7b's brief `docs/slice-7b/` (artifact
`slice-7b`, Radius `01m63r5q1febvtwpwqxrz76zn5`) and its six points are decided ("Slice 7b's open points, as
recommended"; plugin npm dependencies bundled, external by opt-in). **7b is building:** spec `slice-7b.md`
(`0c3675e64`), `s7b-builder` (radius/claude-opus-5-5) in `/home/badlogic/pi-7b`, brief `/tmp/s7b-builder-brief.md`, notes
`/tmp/s7b-build-notes.md`; then build reviews by `s8-spec-{astra,fable,opus,sol}` (Opus on radius), fixes, commit.
All Opus subagents run on `radius/claude-opus-5-5` (owner). The old `docs/explainer/` is stale (rewrite or delete:
owner). Dependency model docs: `docs/dependencies/`.

**State 2026-10-30 (afternoon):** slice 7b is committed (`4b535d57e`), and so is the **simplification audit**
(`50af8c160`, CI green, merged into `private`): decisions A1-A15 in `decisions.md` ("Simplification audit"); cut
`installing` and the static registry cycle edges; retry by a hop budget (`retry.hops`); a fresh `bound` after a swap;
one rule after a live failure; `parked_long` for any long park (`state`); one seal token; about 255 code lines fewer.
Accepted noise: the text codec's small calls (+4-8%, code shape of its decoder, `benchmarks.md`). **Slice 7c (plugins)
spec** is written (`docs/slice-7c.md`, uncommitted in `/home/badlogic/pi-observers` with its decision "Slice 7c's
points" and design §21; patch backup `/tmp/7c-docs.patch`); spec reviews by Fable and Opus
(`/tmp/s7c-spec-review-{fable,opus}.md`) are folded only in part: the owner decided Q1 (b) a `mapStack(error)` helper,
Q2 a facet throwing while evaluating fails its host's whole step, Q4 copied files may not import their plugin's packages,
Q5 no kept esbuild contexts and remote shipping in 10/11 but the build result is plain data exposed for them; **open:
Q3, per plugin at startup and reload** (the owner wants it analysed: why all-or-nothing was chosen, history #66178,
#67234-#67252; my analysis says v2's closed schemas, version binding with waiting, ownership and registry versions remove
the old counter-traces; next step proposed: Opus and Fable punch holes, then the owner decides). The mechanical review
fixes (complete facet sets per host, relative source maps, host-package namespaces, `import.meta` as build errors,
watcher ignores, require order, discovery details) still need folding into the spec. Then: 7c build, 10, 11, 9.
`audit-builder` (radius/claude-opus-5-5) is idle with the v2 code in context.

**State 2026-10-30 (evening):** **slice 7c (plugins) is committed upstream** (`a14cdf90f`, docs `b7e824952`):
`src/node/plugins/` (discovery, esbuild builds, vm evaluation, `pluginFile`, `mapStack`, `installDependencies`,
the watcher, `rollout`), `host.load`/`host.reload` per plugin with the closure rule, `details.committed` on an abort
after a reload's commit (owner "yes"), examples 35-39 as folders with real plugin directories (owner: full coverage),
benchmarks in `benchmarks.md`. Fix round 1 had 19 items from four build reviews and rechecks (all clean). The previous
paragraph's 7c state is superseded. Reading the sources (owner, 2026-10-30): understand the APIs (every
`src/*/README.md` and `index.ts`, `node/plugins/README.md`, the `Self`/`StoreSelf`/`Ctx`/`Host` interfaces);
read implementations in full only where this session or a subagent changes them (all of `src` is ~1.26 MB, more
than one context). Slice 10 (HTTP and workers): spec `slice-10.md` approved (owner: "just build it, have it reviewed, ensure we have
cute examples"); decisions in "Slice 10's points" (D1-D12, D10b, R1-R6, Q1-Q6, "The app kit is malleable by plugins";
no automatic worker restarts, no route backoff timer); two spec review rounds folded (`/tmp/s10-spec-review*-*.md`).
**Building:** `audit-builder` in `/home/badlogic/pi-7b` (detached at upstream `bc9a20f84`), brief
`/tmp/s10-builder-brief.md`, notes `/tmp/s10-build-notes.md`; examples 40-43+ must be small and cute. Then build
reviews by `s8-spec-{astra,fable,opus,sol}`, fixes, commit upstream. Then 11, 9, the small-examples pass.

**State 2026-10-31 (evening):** slice 10 (HTTP and workers) is built in `/home/badlogic/pi-7b` (uncommitted, base
upstream `bc9a20f84`), through fix rounds 1-3 (briefs `/tmp/s10-fix{1,2}-brief.md`, notes `/tmp/s10-fix1-notes.md`);
four build reviews, three security audits and two recheck rounds (`/tmp/s10-build-review-*.md`,
`/tmp/s10-security-*.md`, `/tmp/s10-recheck*-*.md`); Sol's second recheck found three leftovers (nodeRequest on TRACE
and userinfo Hosts, the authenticator chain after close, an aborted unread mounted `bytes` body leaking its scope) to
send to `audit-builder`; then fold spec and design §23, commit, CI, merge. Many decisions today (decision log, entries
dated 2026-10-31: origins only from relays, the HTTP security baseline with relays, the HTTP server as a native object,
a fetch core with Node as the easy path, settings are arguments, CSP nonce per response, API versions in import paths,
plugins import by name (to be reversed: see the plugin model proposal `docs/plugin-model/`), worker errors in
public). Open with the owner: the plugin model's six points, Chord's own frozen schema module replacing TypeBox (pi-ai
widening to accept both), slice 11 P3 onward (`slice-11.md` draft), the app kit design pass (`chord/app`, with
user management and worker-less shapes). Docs written today: `docs/http-workers/` (Radius
01m692mkyzekvr2advcnn9hb1g), `docs/guide-plugins-hosts/` (tutorial, Radius 01m693kb2re9aa54c51cynbsy1, v10),
`docs/plugin-model/` (Radius 01m69nqg5te8vrbhvat1vb2fkq). Explainers go to Radius by default (owner).

**State 2026-10-31 (night):** **slice 10 is committed upstream** (`8959ad6e6`, fixes `cc08278a6` build without DOM
types, `20362c155` a CI heap bound; docs `b22c5f694`: design §23, `slice-10.md` as built, explainer version 2; CI
green; merged into `private`). Fix rounds 4-5 closed Sol's leftovers (`/tmp/s10-recheck3-sol.md` clean, 2,235
tests). **Schema package** decided (`81f3cd412`, "A schema package beneath pi-ai and Chord"); measurement
`/tmp/schema-measure.md` (cfworker accurate but 16-330x slower than TypeBox's JIT; omptype weak on JSON Schema and
`new Function`; a closure-compiled prototype `/tmp/schema-measure/proto.mjs` matches TypeBox's speed): recommended
our own closure-compiled validator, 1.5-2.5k lines; open with the owner: write its design, and moving `Type` to
`pi-ai/typebox`. **Plugin model** open, explained to the owner as eight points (1 reverse import-by-name, 2 the app's
API with Chord re-exported and generations, 3 API split per host kind, 4 host kinds on registry tokens, 5 third-party
contracts, 6 `testPlugin`, 7 single-file plugins, 8 built-in plugins). All Claude subagents run on
`anthropic/claude-opus-5-5` (owner, 2026-10-31; replaces radius Opus/Fable). `schema-measure` (anthropic Opus) holds
the schema measurement context.

**State 2026-11-01 (morning):** **TypeBox is gone from pi** except the coding agent (for extensions): pi-schema
(`@earendil-works/pi-schema`, its own closure-compiled validator, no eval; opt-in coercion `compile(s, { coerce: true
})` with `coerce`/`parse`, the superset of TypeBox's `Value.Convert` and pi-ai's old rules; `Static` also types
TypeBox-built schemas) is under pi-ai (`6536f8012`), pi-agent-core, pi-durable, Chord v1 and v2 (`be039fb31`, JSON and
fingerprints identical, `format` an annotation), benchmark vs ata/Ajv/Zod/TypeBox/cfworker/omptype (`a6bde34`,
Radius 01m69x3dz2fsg9k1r33vde7hv6), TypeBox `Static` fallback (`6291b9bcc`); decisions "A schema package beneath
pi-ai and Chord" and "The schema switch". Extensions guarded by `packages/coding-agent/scripts/schema-guard/`
(untracked, in `/home/badlogic/pi-schema-switch`; baselines `/tmp/schema-guard/`). p2 migrated in private
(`387404afc`, every schema's JSON unchanged), private pushed `23f7c90c1`. Next: phone redeploy when the owner asks
(through the phone dev session, owner-started turn only); then the plugin model (primer `docs/plugin-primer/`,
Radius 01m69waqspfwwt21bjhvsp5w28, eight open points).

**State 2026-11-01 (afternoon):** the plugin model (points 1-8), the app kit (points 1-5) and slice 11 (P3-P9) are
decided (decision log, 2026-11-01) and folded into design §21 ("The plugin model") and §23 ("The app kit", "Web and
TUI"). Owner: "go ahead, just do all the things. tired of reviewing": this session writes specs, runs builds and
reviews and commits without asking per point (only truly new decisions go to him). Slice order now 12 (plugin model,
`slice-12.md`), 13 (app kit, `slice-13.md`), 11 (web and TUI on the kit, `slice-11.md` rewritten), 9 (telemetry).
**Slice 12 is building:** `audit-builder` (anthropic Opus) in `/home/badlogic/pi-s12`, brief `/tmp/s12-builder-brief.md`,
notes `/tmp/s12-build-notes.md`. Then reviews by `s8-spec-opus` and `s8-spec-sol`, fixes, commit, then 13, then 11.
Separately: `voice-doer` audits and fixes p2's voice mechanics in `/home/badlogic/p2-voice` (brief
`/tmp/voice-audit-brief.md`; owner's rule: VAD may misfire, only Parakeet's real text interrupts; stop work at once
when the user speaks; speak text before tool calls; choppy audio); deploy through the phone dev session when done.

### Committed Chord v2

- L1, slices 1, 2, 3a, 3b, 4a, 4b, 5 (`4a5b45c45`), the simplification pass (`79a0206dc`), the watch adaptation
  (`cc2d61f53`), 6a (`6bd526ebd`), 6b (`14b4c56e5`), audit fixes (`391e83fb1`), 8 (`6eb99ad65`). Order: 8 before 7
  (owner, 2026-10-27: reload has to reload real registries). Specs `slice-6b.md`, `slice-8.md` (built).

### Decided 2026-10-26/27 (decision log, each entry folded into design.md and the spec)

- Slice 6a's first-draft points: "The host's store and how it is opened", "A Chord transaction enters the commit step
  as Durable's does", "The table API in `self.tx`", "Chunks of `rows` migrations" (100), "`lastSeq` instead of
  \"head\"", "Export archives are operations, the encoding is pluggable", "Writes, commits, batches, archives", "The
  outbox is optional, internal and versioned", "The `json(...)` column helper", "The commit-step benchmark", "Slice 6a's
  three code questions" (ctx on keyed reads, the paused deadline, `client` host kind).
- General model (owner: "model discussion done"): "Facet documents are removed" (C16), "Facets only declare" (no
  routines), "Documents and the line belong to the object, not the attempt", "Job runs belong to the object;
  singletons stay resident", "The seal fence", "A live object can fail", "A native restart drains first", "Keyed
  state members, `local` contracts only". Lazy creation, activation waiting for `self.get` dependencies and automatic
  retry stay. Owner's rule: **Chord and Durable align as much as possible** (design §1.10).
- First spec review: "Writes carry their versions; archives are lossless", "Store errors: Durable's rule",
  "`runCounted` in `chord/sqlite`" (pi `8025c414d`, verified in workerd: `rowsWritten` counts index writes),
  "Restricted names instead of assigned table names", "Nullable columns and the `set` form", "The migration API: the
  reviewers' consensus" (the owner delegates the shape), "Cold keyed loads on the line", "Slice 6a small items" (20,
  among them: no hand-written memory backend, tests on SQLite `:memory:`).
- Second spec review: "Second spec review: the majority" (`evolveTable`, spec section 15). "State and job names are
  restricted too", "Size is not a goal by itself" (no cut pass). Build reviews: "Slice 6a build reviews" (member
  sources re-bound by name across attempts, the migration yield, counters).

### Next

1. Slice 7 (reload and rollout): spec (the slice 7 carry-over in `slices.md`, including slice 8's "Registries on
   reload"), spec reviews, build, reviews to the bar. Builder model Opus 5.5; reviewers `s8-spec-{astra,fable,opus,sol}`
   have slice 8's context.
2. Slice 9: telemetry.

### Waiting and other

- **Other:** the owner's own conversations: `ultimate` (Daniel's Ultimate), `issue-10959`, `p3-walkthrough`; leave.
- **Deferred decisions** (design §26): jobs as objects, where a flow lives, project plugins, a DO profile, p3 domain
  points 17-23, #24-#26, #28, #29.
- **Process lessons (2026-10-26, revised 2026-10-27):** the bar is decision "The performance and memory bar, and
  converging reviews" (CPU within about 5% of HEAD per hot path, memory no worse beyond noise, GC probes); reviewers
  benchmark against a HEAD copy (bursts, alternating, pinned; allocation and retained memory). Re-reviews reuse the
  same reviewers (restore them; archiving keeps their context); a fix round adds no new decisions or features. Never message the phone session from a turn not started by the owner
  (it is refused). When a reviewer on an OpenAI model (Astra, Sol) fails with a model error during security work, it
  was likely a refusal: send it a message that this is a defensive review of our own open-source code (pi, packages/chord),
  run against local copies, then let it continue (owner, 2026-10-31). Never commit a file write and the dependent git commit in one parallel tool batch (it happened
  three times: the commit missed the edit). Never call `history_handoff` unless the owner says so; the app may compact
  on its own, so keep this section current (2026-10-27: it was stale at a compaction).

## 4. Read, in this order

1. This file.
2. `packages/chord/docs/decisions.md` (the decision log; later entries win).
3. `packages/chord/docs/design.md` (the one current statement of every rule) and `slices.md` (the slice plan,
   the feature map and the carry-over).
4. The current slice's spec (`slice-6a.md`, draft; `slice-5.md` as built), `store/book.md` (the store design) and
   `benchmarks.md`.
5. The code in `packages/chord/src/` (contracts, data, documents, state, host, jobs, link, remote), `test`,
   Chord's shared `src/watch.ts` and `src/sqlite`, and Durable's `session/session.ts` and storages (for 6b).
6. Background when needed: `durable-observers/book.md`, `p3-reviews/`, `apps/p2/docs/research/`.

## 5. The owner's rules (binding)

- **Never decide for the owner.** Present problems with a concrete example and proposals; he decides. Small API shapes
  too. Subagents' questions go to him, relayed with options and a recommendation.
- **One issue at a time.** Do not move on until he says so. When he says to finish a discussion first, do not spawn
  subagents or start work.
- **Write every decision into the decision log immediately**, fold it into `design.md`, and mark every log entry it
  supersedes ("**superseded in part** by …" or strike-through), all in the same commit.
- Explain with concrete code, data and short traces; prose alone is impenetrable. Short lines, phone-readable.
- Be honest; no improvising; no complexity to please. Reuse before writing (Delta, `state.ts`, context, output,
  `chord/sqlite`, Durable).
- No development or test modes: one behavior everywhere (owner).
- Style: tagged unions always; no ceremony; no `any`; erasable TypeScript; top-level imports; no backward
  compatibility unless asked.
- Design docs are written by this session, not by a subagent without context.
- **Carry-over (owner, 2026-10-22):** everything deferred to a later layer is recorded in
  the section "Carry-over" of `packages/chord/docs/slices.md` under that slice, in the same change; each slice's spec includes its
  section and the build checks it off.
- **Code style (owner, 2026-10-22):** all Chord v2 code follows the section "Chord v2 Code Style" in the root
  AGENTS.md (in every agent's context); every code brief and every review names it.
- **Code subagents never commit or push unless told to** (owner, 2026-10-22): implement until done and report; reviewers
  review; the subagent fixes; the owner reviews the uncommitted changes in p2's workspace tab; then this session tells it
  to commit. New Chord v2 code lives in `packages/chord/src/` (pi upstream since 2026-10-27, `93029a0f1`).

## 6. Environment and flows

- slayer: repo `/home/badlogic/pi-private`, branch `private`; remotes `origin` (pi-private), `upstream` (pi). Node 24:
  `/home/badlogic/node-v24.4.1-linux-x64/bin`. Commit docs with explicit paths; push `origin HEAD:private`; when a push
  is rejected: `git fetch origin && git merge --no-edit origin/private` (never rebase or stash).
- **Everything outside `apps/` is pi first, Chord v2 and its docs included** (owner, 2026-10-27: Chord v2 and all
  its docs, the decision log too, live in pi upstream: `packages/chord/src`, `test`, `docs`,
  `docs/decisions.md`): worktree of `upstream/main` (`/home/badlogic/pi-observers`, `npm ci --ignore-scripts`,
  `(cd packages/ai && npm run hydrate-model-data)`, `npm run check`, explicit test files only, never the full Durable
  suite (paid e2e), push to `upstream main`, wait for green CI, then merge `upstream/main` into `private`).
- Chord v2 tests: from `packages/chord`, `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run
  test`. Playground: `apps/chord-playground`.
- Subagents: none of this session's are active (all archived on 2026-10-26); `ultimate`, `issue-10959`,
  `p3-walkthrough` are the owner's (leave). Worktrees: `/home/badlogic/p2-live` (runs the live p2 server, tmux `p2`;
  keep); `/home/badlogic/pi-observers` (upstream pi worktree used for today's pi changes, detached at `6c384aa30`,
  clean; reuse for the next pi change after `git fetch upstream && git checkout --detach upstream/main` and
  `npm ci --ignore-scripts`). Durable/Chord tests without a build: vitest configs `/tmp/observers/vitest.durable.config.ts`
  and `/tmp/observers/vitest.chord.config.ts` (alias pi-ai and pi-telemetry to src). The phone dev session `d602d653-61f1-4f99-aa54-99267e9dbf4e` deploys p2
  to the phone on request (only from owner-initiated turns).
- Radius artifacts: always `visibility=private` (mcporter usage in `/home/badlogic/AGENTS.md`). Explainer build:
  `node /home/badlogic/.pi/p2/skills/explainer/build.mjs <md> -o <html>`; the store book and walkthrough are
  published as private artifacts (book `01m5g0jztafkrvk6kq8w88h6hx`, walkthrough `01m5g0ms6demgtyyfdznhxnfre`).

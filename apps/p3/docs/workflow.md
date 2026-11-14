# Workflow

How p3 is built (owner, 2026-11-14). The p3 session is the builder; reviewers are subagents; the owner decides and
does the final review.

## A slice, step by step

1. **Brief.** Every slice has a brief in `slices/` from the start: its goal, what it builds, what it depends on, what
   to read, what is decided and what is open. Briefs are short.
2. **Details.** Before building, the builder fills out the brief in detail: the files, the contracts and objects (only
   real Chord and kit APIs, named by file, or defined right there), how it works, the tests case by case, the numbers
   it must meet (below), and a "Read first, in full" list (below). For every part: could a third-party plugin provide
   this, or an alternative, the same way? Docs are committed without review.
3. **Build.** On a branch of a worktree off origin/main (open: the owner said "no worktree" on 2026-11-06, when p3 had
   its own branch; the shared checkout's main is far behind). Chord v2 code style (root `AGENTS.md`) for p3 code too.
   `cd apps/p3 && npm run check` (the root check skips `apps/`) and the slice's tests pass. From slice 2 on, every
   plugin the slice touches is edited and applied while used in the reload tests: nothing lost, the restart mark off.
4. **Review, round 1.** GPT-6.1 Sol (fit with Chord's design and code), GPT-6 Astra (adversarial: races, failures,
   cost) and Fable 5.2 (simplicity, a second opinion) read the code against the brief. Not overzealous: what matters,
   not esoteric cases.
5. **Fix.** Findings are fixed. A finding that needs a decision goes to the owner first (below).
6. **Review, round 2,** by the same three on the fixed code; **fix** again.
7. **Walkthrough.** A book-style explainer (`slices/NN-name/walkthrough/`, built with the explainer skill, not
   interactive): what was built, why and how, in the order to read the code.
8. **Owner review.** The owner reviews the code with Fable. Code is committed only after his approval.
9. **Update the docs:** the brief (as built), `overview.md`, `names.md`, `decisions.md`.

## Reading

A slice's brief lists what to read in full before detailing or building it: the docs (with sections), the Chord, kit,
Durable and pi-ai source files, the p2 precedents, and the private reviews on slayer. Always also: `names.md`,
`decisions.md` in full, and `packages/chord/docs/design.md` in full (root `AGENTS.md`). Archive docs use older names;
translate them with `names.md`.

## Decisions

Whenever a decision comes up (while detailing, building or fixing), work stops on what depends on it and it goes to
the owner: one at a time, the problem with a concrete example, the options, a recommendation. His answer is recorded
in `decisions.md` at once.

## Tests

Fast and extensive, in three tiers:

1. **Plugin tests:** one plugin's facet alone (`testPlugin`, or the facet loaded on one host): milliseconds.
2. **Topology tests:** the server and session workers as hosts in one process, linked in memory, stores on SQLite
   `:memory:` (a temporary file where a restart is tested), the faux model scripted per test. Each test has its own
   topology. Most coverage lives here.
3. **End-to-end tests:** a few, through the real app: `startServer`, forked workers, a client over WebSocket. Long
   ones (browser) run only when asked or nightly, never in the default run.

Isolated and deterministic (decision "Tests are isolated and deterministic"). Each slice reports the suite's time.

## Numbers

p3 must be fast and use little memory (owner, 2026-11-14; decision "Efficiency is a requirement"). Every slice
measures, on slayer and on the phone, what it touches:

- a worker's start: from the first hold to its first answer;
- a worker's RSS when idle, without what Node shares between processes;
- the server's start and RSS;
- bytes on the wire for common actions (opening a session, switching conversations, a streamed answer).

A small benchmark script per slice, results in the brief. A slice that makes a number worse says why. The rules from
p2's findings (`archive/efficiency.md`): page-wide objects held once, outside keyed subtrees; lists per session or
paged, never all children of all sessions; compression at the origin on every Node host; a byte budget per common
action.

## Handoff

When the owner says "handoff", the builder writes a handoff whose first section is "Read first, in full": the exact
docs and sources (paths, line ranges if long) and the history entries the next context must load completely, ordered
by importance; then the state, the decisions, what is open and the files involved. Then `history_handoff`. Never
without the owner asking.

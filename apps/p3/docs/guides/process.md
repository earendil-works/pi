# Doing a package

How a package of Pi Roam (p3) goes from "what is it" to the nightly. From the team's process board (onsite, Mario's
team), adapted from `../workflow.md` for a team where each owner and their agent builds one package.

## Code you never change

These belong to Mario (`../decisions.md`, "Packages: owners, audits, sign-off and browser testing"). **Agents never
change them:**

- **Chord and Durable:** `packages/chord/`, `packages/durable/`.
- **p3's shared base code:** `apps/p3/src/kit/`, `apps/p3/src/api/`, `apps/p3/src/bootstrap/`,
  `apps/p3/src/install.ts`.
- **p3's shared test harnesses:** `apps/p3/test/topology.ts`, `apps/p3/test/launched.ts`, `apps/p3/test/commands.ts`.

When your package needs a change there, **stop** work on what depends on it, and write it up:

1. **The problem:** what your package cannot do without the change.
2. **A concrete example:** the call, the case or the trace that shows it.
3. **The change it needs:** the smallest one, in which file, and who else it affects.

Then tell your user (the package owner) to take it to Mario. Do not work around it in your plugin, and do not make
the change yourself, not even in a test copy you commit.

## Who decides

| Who | Does |
| --- | --- |
| Mario | owns p3, Chord and Durable, and p3's shared base and test code (above). Decides what crosses packages: base code, the API (`@earendil-works/p3/v1`), names, the order of work, and everything in `../decisions.md` before the split |
| the package owner (a person) | owns one package. Decides inside it, records each decision, signs the package off with the team |
| the owner's agent | the builder: writes the brief, builds, tests, measures, writes the explainer. Never decides; asks its owner |
| reviewers | agents on other models than the builder's. They read the code against the brief |
| the full team | audits and signs off every package |
| Colin and Jakob | test a signed-off package before it goes into the nightly |

- **A decision inside the package** (a table's columns, a contract's shape, which p2 feature to drop) is the package
  owner's. Record it in `../decisions.md` at once: the date, who decided, what, why.
- **A decision that touches another package** is taken with that package's owner. One that touches base code, the
  API, `names.md` or an earlier decision in `decisions.md` goes to Mario.
- **How to ask.** One decision at a time: the problem, a concrete example, the options, a recommendation. Work stops
  on what depends on it until the answer comes. The answer goes into `decisions.md` the same day.
- **Agents never decide.** An agent that finds a decision stops and asks its owner (the `team` tool, or the owner's
  session), with the four parts above.

## The steps

### 1. Take the package

Each package has a Linear issue. Each package has its own label in Linear; every issue of the package carries it.
The issue names the owner and links the brief.

### 2. What: look at p2 first

p2 (Pi Mobile, `apps/p2/`) is what exists today. Look at it before you design anything:

- **What exists:** p2's plugins in your area (`apps/p2/plugins/<name>/`), its docs (`apps/p2/docs/`), the functionality
  map (`apps/p2/docs/p3-functions/README.md`), and `../slices/README.md` ("p2's features by slice") for which slice
  holds which p2 domain.
- **What sucks:** use it, on a phone first. Mobile first: the phone is where p2 is used most and where it is slowest
  (worker starts take seconds there, `../decisions.md`, "Docs, slices and the workflow").
- **Can third-party plugins extend it, how and where:** for every part, ask whether another plugin could add to it or
  replace it the same way. Name the extension points: registries (`defineRegistry`, design §17), contracts other
  plugins read (named queries, column sets), slots in views (PROPOSED: slice 14).
- **The polished final version:** describe what the finished package does for a person, not only what this round
  builds.

**p2 is inspiration only. Nothing is copied:** no p2 structure, no p2 code, no p2 file layout carried over. p3 builds
each feature clean on Chord and p3's kit (`../decisions.md`, "Slices give p2's features, clean").

### 3. The brief

Before you build, write a short brief. Where: `apps/p3/docs/slices/NN-name.md`, the existing brief of the slice
your package belongs to, filled out (`../slices/README.md` lists them). **Open:** whether packages keep the per-slice
briefs or get a brief per package. Until Mario decides, fill out the slice's brief and say in its first lines which
package it is.

A brief has these parts, in this order (`../slices/27-terminal.md` and `../slices/28-telemetry.md` are good models):

1. **Goal and state:** one paragraph; built, brief, or decisions open.
2. **p2's features in this area:** a table, one row per feature: built in this package, carried to a named package
   or slice, or proposed to drop (the owner decides each drop).
3. **Extension points:** what other plugins add, and how (registry, contract, slot).
4. **How it works:** what runs where (server, worker, page, terminal), one request traced through it.
5. **Files:** every file created or changed, one line each.
6. **Contracts and objects:** real Chord and p3 APIs only, named by file, or defined right there and marked
   PROPOSED.
7. **Tests, case by case:** per tier (`testing.md`).
8. **Numbers to meet:** targets with their precedents (`performance.md`).
9. **Decisions:** open ones, each as problem, example, options, recommendation.
10. **Read first, in full:** the docs (with sections) and source files the next builder must read.
11. **Carried:** what is left for later, and where it goes.

Docs, briefs and decisions are committed without review (`../workflow.md`).

### 4. How: build

- **Everything is a plugin.** Behaviour lives in `apps/p3/plugins/<name>/`. Base code is vocabulary (the principal,
  the API, the kit, the process entries); a package does not grow it (`../overview.md`, Goals).
- **Follow the guides:** `building.md` for the shape and the rules, Chord v2 code style (root `AGENTS.md`) for every
  file.
- **Never change Chord, Durable, or p3's shared base and test code** ("Code you never change", above). When you need
  a change there, stop, write it up (the problem, a concrete example, the change it needs) and tell your user to take
  it to Mario. p3 has needed such changes before (Chord's `memberNames` for `forward`; the close function
  `links.opened(request, principal, close)` hands a sign-in; Chord's worker base minified): each went through Mario.
- **A plugin that needs a change in another plugin** talks to that plugin's owner. Never edit another package's
  files; agree on the contract change, its owner makes it (a version bump with `accepts` for the old version,
  `plugin-authoring.md`, "Contracts and versions").
- **Base code a package needs** (a new API export, a kit change, a new facet kind, a topology that loads your
  plugin): the same write-up, to Mario.
- **Tests and numbers:** as `testing.md` and `performance.md` say, before you report.

### 5. Review

Before the push, the builder has the package reviewed, as its own quality step, by agents on other models than the
builder's (`../workflow.md`, steps 4 to 6): one for fit
with Chord's design and code, one adversarial (races, failures, cost), one for simplicity. Not overzealous: what
matters, not esoteric cases. Findings are fixed; a finding that needs a decision goes to the owner first. Two rounds.
Every reproduction a reviewer writes becomes a regression test.

### 6. Push to main; the whole team audits

Push to main in the shared checkout (rules below), once the reviews' findings are fixed. Then **the whole team
audits** the package: whoever pushed it posts a short video or explainer (step 7) on the package's Linear issue and
in #packages on Discord, and the team signs it off (step 8).

### 7. The explainer

The explainer is the walkthrough of `../workflow.md` (step 7), written for the team: what was built, how and why, so
the team can sign it off without reading the source.

- **Self-contained:** the reader has no access to the source.
- **Code over prose:** the real code of each part, shown and explained piece by piece.
- **It starts with the list of every source file created and touched,** each with one line and its size.
- **Be creative where it explains better:** one request followed through every file, traces of real runs, diagrams,
  before and after, "what breaks if this line goes", the tests that pin each rule.

Where: `apps/p3/docs/slices/NN-name/walkthrough/` (slices 1 and 26 have one). The explainer skill
(`~/.pi/p2/skills/explainer/` on slayer) builds a book-style page where its layout helps.

### 8. Sign-off

- **Posted by whoever pushed:** a short video or explainer on the package's Linear issue and in #packages on Discord.
  UI work: a video or a live demo, on a phone and on a desktop. Non-UI work (security, storage, the release): a
  5-minute explainer, from the walkthrough.
- **Browser checks on devices, by people who have them** (UI work): Safari on iOS, Firefox on Android, Chrome on
  Android. Beyond headless Chromium these are manual (`testing.md`, "UI tests"), and part of the sign-off.
- **The whole team audits and signs off.**
- **Then Colin and Jakob test it.** What they find goes back to step 4.
- **Then it goes into the nightly.**

### 9. Update the docs

In the same commit as the code, or right after it:

- the brief: an "As built" section (what was built, where it differs from the plan, the numbers measured);
- `../decisions.md`: every decision taken, as it was taken;
- `../names.md`: every new name;
- `../overview.md`: the package's row in "Plugins", if what it owns changed;
- `../chord-practices.md`: every mistake made and its fix, in "Mistakes we made";
- these guides, where they were wrong or silent.

## Git in the shared checkout

Work happens in `/home/badlogic/pi` on slayer, on main, no worktree (`../decisions.md`, "No worktree"). Other
sessions work in the same checkout at the same time. From the root `AGENTS.md`, "Git":

- Commit only files you changed. Stage explicit paths: `git add <path> <path>`.
- When other sessions have staged files, commit with `--`: `git commit -m "<message>" -- <paths>`.
- Before committing: `git status`, and check you stage only your files.
- Pull with `git pull --no-rebase --no-edit` before you push. Never force push.
- Never: `git add -A`, `git add .`, `git stash`, `git reset --hard`, `git checkout .`, `git clean -fd`,
  `git commit --no-verify`.
- Messages: `feat(p3): ...`, `fix(p3): ...`, `docs(p3): ...`; informative, no emojis.
- A rebase conflict in a file you did not change: abort and ask.

## Handoffs

When an agent's context runs out, it hands off only when its owner asks. The handoff starts with "Read first, in
full": the exact docs and source files (with line ranges if long) and the history entries the next context must load,
ordered by importance; then the state, the decisions, what is open and the files involved (`../workflow.md`,
"Handoff").

## Checklist

1. A Linear issue with the package's label, the owner named.
2. p2 looked at, on a phone first: what exists, what sucks, what third parties could extend.
3. The brief written: p2's features (built, carried, dropped), extension points, files, contracts, tests, numbers,
   decisions, "Read first".
4. Every decision asked one at a time and recorded in `decisions.md`.
5. Built as plugins. No change to Chord, Durable, p3's shared base and test code, or another package's files; each
   needed change written up (problem, example, change) and taken to Mario by the user.
6. `cd apps/p3 && npm run check` clean; the package's tests and `npm test` pass, serial and loaded.
7. Numbers measured and in the brief.
8. Mutation check done; reviewers' reproductions are tests.
9. Two review rounds by other models, findings fixed.
10. Pushed to main, explicit paths only.
11. Explainer written; video or explainer posted on the Linear issue and in #packages; UI checked by hand in Safari on
    iOS, Firefox and Chrome on Android; team audit and sign-off; Colin and Jakob tested.
12. Docs updated: brief "As built", `decisions.md`, `names.md`, `overview.md`, `chord-practices.md`.

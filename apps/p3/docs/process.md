# Doing a package

A package is one part of p3 with one owner (a person) and one Linear issue. The owner's agent builds it. This guide is
the path from the issue to the nightly.

## Where the work is planned: Linear

Project "Pi next" in team Earendil (issue keys `ERNDL-…`), three levels:

- **Area:** a parent issue per area (UI/UX and UI tech, Services, AuthZ and sharing, Net and storage, Harness,
  Distribution, Apps, Voice, Efficiency, Comms, ...), naming its owners; a label per area in the group "Pi area"
  (`area:ui`, `area:services`, ...).
- **Item = package:** a sub-issue of its area, with the area's label. It holds the scope, the old p3 slices and p3
  sources in its area, the p2 plugins, docs and screenshots to look at, the open points, and the plan (step 3).
- **Sub-items:** one sub-issue per part of the package, created by the owner while planning it.

Statuses are Linear's: Backlog, Todo, In Progress, In Review, Done. Decisions taken inside the package are recorded
in its item issue as they are taken.

The stage of a package is a label in the group "Pi stage", one at a time, set on the item issue: **Design** (steps
1 to 3), **Implementation** (steps 4 to 7), **Review** (step 8). Every package starts in Design. Whoever moves the
package to the next stage changes the label in the same moment and says why in a comment on the issue.

## Never change these

They belong to Mario:

- Chord and Durable: `packages/chord/`, `packages/durable/`;
- p3's base code: `apps/p3/src/kit/`, `apps/p3/src/api/`, `apps/p3/src/bootstrap/`, `apps/p3/src/install.ts`;
- p3's test harnesses: `apps/p3/test/topology.ts`, `apps/p3/test/launched.ts`, `apps/p3/test/commands.ts`;
- another package's plugin: agree with its owner; its owner changes it.

When your package needs a change there, **stop** the work that depends on it and write the change up:

1. the problem: what your package cannot do without it;
2. a concrete example: the call, the case or the trace that shows it;
3. the change: the smallest one, in which file, and what else it affects.

Then tell your user to take it to Mario (or to the other package's owner). Never work around it inside your plugin.

## Who decides

- Inside the package (a table's columns, a contract's shape, dropping a p2 feature): the package owner.
- Across packages: the owners of both.
- Base code, the API, names (`names.md`), Chord, Durable, anything in `decisions.md`: Mario.
- **The agent never decides.** It asks its user, one decision at a time: the problem, a concrete example, the
  options, a recommendation. Work that depends on the answer waits. The answer goes into the Linear issue at once.

## The steps

Three stages, each with its label in the group "Pi stage" on the item issue. At every step: a guide that was wrong or
silent is fixed in the commit that shows it, and a mistake you made and its fix go into `chord-practices.md`, "Mistakes
we made".

### Design

Label `Design`; every package starts here. The stage ends when the plan is complete and its open decisions are taken;
the owner then sets `Implementation`.

1. **The issue.** Read the package's item issue and its area's parent issue. Everything below is written into the item
   issue or one of its sub-issues.
2. **Look at p2 first, on a phone.** What exists in this area (p2's plugins in `apps/p2/plugins/`, the functionality
   map `apps/p2/docs/p3-functions/`, the old brief in `slices/` for this area), and what sucks about it. Then: what
   should the polished final version be, and where can third-party plugins extend or replace it (a registry, a
   contract others read, a slot in a view)? **p2 is inspiration only: no p2 code, structure or file layout is
   carried over.**
3. **The plan, in the item issue,** before building, with a sub-issue per part:
   - p2's features in the area, each: built now, carried to another package, or proposed to drop (the owner decides
     drops);
   - the extension points;
   - how it works: what runs on the server, in a session's worker, in the page, one request traced through;
   - the files to create or change;
   - the contracts and objects, as real Chord and p3 APIs (with their file) or marked PROPOSED;
   - the tests, case by case (`testing.md`), and the numbers to meet (`performance.md`);
   - the open decisions, each as problem, example, options, recommendation.

### Implementation

Label `Implementation`. The stage ends with the push to main; whoever pushed then sets `Review`.

4. **Build** it as plugins in `apps/p3/plugins/<name>/`, following `chord-practices.md`.
5. **Test and measure** as `testing.md` and `performance.md` say, before you report.
6. **Review, always by four models:** Opus, Fable, Sol and Astra, each a fresh agent. Prime each one: it first reads
   `README.md` and the guides it lists, in full, then the plan in the item issue, then the code. Give each a focus:
   fit with Chord and p3 (Sol), adversarial: races, failures, cost (Astra), simplicity (Fable), and a second full
   read (Opus). Sol and Astra refuse to review security attacks; give those to Opus or Fable, framed as a review of
   your own protocol. Fix what matters, then a second round by the same four. Every reproduction a reviewer writes
   becomes a test.
7. **Push to main** (git rules below).

### Review

Label `Review`: the people's review. A finding that needs code sets the label back to `Implementation` (steps 4 to 7
again, then `Review` again). After the team's sign-off and Colin's and Jakob's tests, the issue is closed as Done; the
`Review` label stays as the record.

8. **Sign-off.**
   - Whoever pushed posts a short video (UI) or a 5-minute explainer (non-UI work) on the Linear issue and in
     #packages on Discord. The explainer shows the real code and the files touched; it assumes no access to the
     source.
   - Whoever implemented it must be able to answer questions about both its functionality and its code.
   - Armin and Mario review the code. What they find goes back to step 4.
   - People with the devices test the UI by hand: Safari on iOS, Firefox on Android, Chrome on Android. They note on
     the issue what they used and found.
   - The whole team audits and signs off.
   - Colin and Jakob test it; what they find goes back to step 4. Then it goes into the nightly (built from main by
     GitHub Actions; the Distribution area's item).

## Git

You work in the shared checkout, on main, with other sessions committing beside you:

- `git pull --no-rebase --no-edit` before you push; never force.
- Stage explicit paths only, and commit with `--` so other sessions' staged files stay out:
  `git commit -m "feat(p3): ..." -- <path> <path>`.
- Never `git add -A`, `git add .`, `git stash`, `git reset --hard`, `git checkout .`, `git clean -fd`,
  `git commit --no-verify`.
- A conflict in a file you did not change: stop and ask.
- Messages: `feat(p3): ...`, `fix(p3): ...`, `docs(p3): ...`; plain, no emojis. Never name competing products in the
  repository, its docs or commit messages.

## Checklist

- [ ] The stage label kept current: `Design`, then `Implementation`, then `Review`.
- [ ] Plan in the item issue, a sub-issue per part: p2's features sorted, extension points, files, contracts, tests,
      numbers, decisions.
- [ ] Every decision asked one at a time and recorded in the issue.
- [ ] Only your plugins changed; every needed change elsewhere written up and taken to its owner.
- [ ] `cd apps/p3 && npm run check` clean; `npm test` passes, serially and with four runs at once.
- [ ] The tests and numbers of `testing.md` and `performance.md`, reported in the issue.
- [ ] Two review rounds by Opus, Fable, Sol and Astra, each primed with the guides; reproductions are tests.
- [ ] Pushed by explicit paths; video or explainer posted; questions on functionality and code answered; code
      reviewed by Armin and Mario; devices checked; team sign-off.

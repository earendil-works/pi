# Doing a package

A package is one part of p3 with one owner (a person) and one Linear issue. The owner's agent builds it. This guide is
the path from the issue to the nightly.

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

1. **The issue.** The package's Linear issue (with the package's label) names the owner. Everything below is written
   into it or linked from it.
2. **Look at p2 first, on a phone.** What exists in this area (p2's plugins in `apps/p2/plugins/`, the functionality
   map `apps/p2/docs/p3-functions/`, the old brief in `slices/` for this area), and what sucks about it. Then: what
   should the polished final version be, and where can third-party plugins extend or replace it (a registry, a
   contract others read, a slot in a view)? **p2 is inspiration only: no p2 code, structure or file layout is
   carried over.**
3. **The plan, in the issue,** before building:
   - p2's features in the area, each: built now, carried to another package, or proposed to drop (the owner decides
     drops);
   - the extension points;
   - how it works: what runs on the server, in a session's worker, in the page, one request traced through;
   - the files to create or change;
   - the contracts and objects, as real Chord and p3 APIs (with their file) or marked PROPOSED;
   - the tests, case by case (`testing.md`), and the numbers to meet (`performance.md`);
   - the open decisions, each as problem, example, options, recommendation.
4. **Build** it as plugins in `apps/p3/plugins/<name>/`, following `chord-practices.md`.
5. **Test and measure** as `testing.md` and `performance.md` say, before you report.
6. **Review.** Agents on other models than yours read the code against the plan: one for fit with Chord and p3, one
   adversarial (races, failures, cost), one for simplicity. Fix what matters, two rounds. Every reproduction a
   reviewer writes becomes a test.
7. **Push to main** (git rules below).
8. **Sign-off.**
   - Whoever pushed posts a short video (UI) or a 5-minute explainer (non-UI work) on the Linear issue and in
     #packages on Discord. The explainer shows the real code and the files touched; it assumes no access to the
     source.
   - People with the devices test the UI by hand: Safari on iOS, Firefox on Android, Chrome on Android. They note on
     the issue what they used and found.
   - The whole team audits and signs off.
   - Colin and Jakob test it; what they find goes back to step 4. Then it goes into the nightly.
9. **Fix the guides.** A guide that was wrong or silent is fixed in the commit that shows it. A mistake you made and
   its fix go into `chord-practices.md`, "Mistakes we made".

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

- [ ] Plan in the Linear issue: p2's features sorted, extension points, files, contracts, tests, numbers, decisions.
- [ ] Every decision asked one at a time and recorded in the issue.
- [ ] Only your plugins changed; every needed change elsewhere written up and taken to its owner.
- [ ] `cd apps/p3 && npm run check` clean; `npm test` passes, serially and with four runs at once.
- [ ] The tests and numbers of `testing.md` and `performance.md`, reported in the issue.
- [ ] Two review rounds on other models; reproductions are tests.
- [ ] Pushed by explicit paths; video or explainer posted; devices checked; team sign-off.

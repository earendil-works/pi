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

The stage of a package is a label in the group "Pi stage", one at a time, set on the item issue. Every package starts
in Design. Whoever moves the package changes the label in the same moment and says why in a comment on the issue.

```text
Design → Implementation → Review ⇄ Polish → done
```

| Label | Means | Who sets it, when |
| --- | --- | --- |
| `Design` | the plan is being written and its decisions taken (steps 1 to 3) | every package starts here |
| `Implementation` | it is being built, tested, reviewed by the three models and pushed (steps 4 to 8) | the owner, once the plan is complete and its open decisions are taken |
| `Review` | what is on main is being reviewed: by the reviewers again (a hackiness review included) and by the people (step 9) | whoever pushed, after the push to main; and again after every Polish |
| `Polish` | the findings of the last Review are being fixed | whoever takes the findings, the moment a Review comes back with any, with the combined list in the comment |

Review and Polish alternate until the reviewers find nothing left. Polish is part of the package, not optional and
not "later": a package is done only when a Review comes back clean. Then, with the sign-off complete, the issue is
closed as Done; the `Review` label stays as the record.

## Base files and other packages' plugins

They belong to Mario, or to another package's owner:

- Chord and Durable: `packages/chord/`, `packages/durable/`;
- p3's base code: `apps/p3/src/` (the API `apps/p3/src/api/` included);
- p3's test harness: `apps/p3/test/support.ts`, `apps/p3/test/topology.ts`, `apps/p3/test/until.ts`;
- another package's plugin: agree with its owner; its owner changes it.

When your package needs a change there, write it up:

1. the problem: what your package cannot do without it;
2. a concrete example: the call, the case or the trace that shows it;
3. the change: the smallest one, in which file, and what else it affects.

- **Chord and Durable:** never changed in a package's worktree. The write-up becomes a Linear issue for Mario (a
  missing primitive: a follow, a changing set, a lease), and the work that depends on it waits. Never build the
  primitive by hand inside your plugin.
- **p3's base files** (`apps/p3/src/`, the API, the test harness): the smallest change your package needs may be made
  in your worktree. Every base file you changed is listed for Mario, with the three points above, in your report and
  on the item issue, before the push; the reviewers read them first.

## Who decides

- Inside the package (a table's columns, a contract's shape, dropping a p2 feature): the package owner.
- Across packages: the owners of both.
- Base code, the API, names (`names.md`), Chord, Durable, anything in `decisions.md`: Mario.
- **The agent never decides.** It asks its user, one decision at a time: the problem, a concrete example, the
  options, a recommendation. Work that depends on the answer waits. The answer goes into the Linear issue at once.

## The steps

Four stages, each with its label in the group "Pi stage" on the item issue. At every step: a guide that was wrong or
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
3. **The plan, as a comment on the item issue,** before building (a sub-issue per part where the package is large):
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

4. **Build** it as plugins in `apps/p3/plugins/<name>/`, in a git worktree of your own (Git, below), following
   `chord-practices.md` and `kind-pattern.md`. **Stored data survives updates:** a change of a table's or a document's
   shape is a new version with a migration, tested; the migrations are collapsed once before the first release
   ([ERNDL-1192](https://linear.app/earendil/issue/ERNDL-1192)). **Base files:** a change your package makes in
   `apps/p3/src/` or the test harness is listed for Mario, each with its problem, example and smallest change, in your
   report and on the issue; a change it needs in Chord or Durable becomes an issue for Mario ("Base files and other
   packages' plugins").
5. **Test and measure** as `testing.md` and `performance.md` say, before you report.
6. **Review, always by three models:** Opus, Astra and Fable, each a fresh agent. Prime each one: it first reads
   `README.md` and the guides it lists, in full, then the plan on the item issue, then the code. Give each a focus:
   fit with Chord, p3 and the kind pattern, and a full read (Opus); adversarial: races, failures, cost (Astra);
   simplicity (Fable). A security review goes to Opus or Fable, scoped as a defensive review of your own protocol. Wait for all three, combine their findings into one list (musts and shoulds), fix what matters,
   then a second round by the same three. Every reproduction a reviewer writes becomes a test, named after the rule
   it pins.
7. **Gates:** the repository root's `npm run check` and `cd apps/p3 && npm run check` clean; `npm test` in `apps/p3`
   passes, serially and with four runs at once; for UI work the browser tests (`testing.md`, "UI tests"); the numbers
   of `performance.md`, reported in the issue. If the rebase before the push moved your commits onto new ones of
   main, run the gates again on that HEAD.
8. **Push to main** (git rules below).

### Review and Polish

Label `Review`: what is on main is reviewed. The reviewers (Opus, Astra and Fable, fresh agents, primed as in step
6) read the package as it stands on main, and look for what a new maintainer would trip over as well as for bugs:
stopgaps and workarounds, hand-made versions of something Chord or a shared helper has, copies, flags and special
cases, casts and checks without a reason, files mixing concepts, tests that do not pin what they claim, anything off
`kind-pattern.md`. The people review it too (step 9). The findings are combined into one list on the issue.

Label `Polish`: the findings are fixed, as steps 4 to 8 again (build in your worktree, test, gates, push). **Fix,
don't file:** a cleanup found in a Review is done in this Polish, not turned into an issue for later. Only what needs
a change in Chord, Durable or another package becomes an issue, for its owner, and the list says so. After the push
the label goes back to `Review`, and the same reviewers look again.

The two alternate until a Review comes back clean: the reviewers find nothing left, and the people's sign-off (step
9) is complete. Only then is the issue closed as Done.

9. **Sign-off.**
   - Whoever pushed posts a short video (UI) or a 5-minute explainer (non-UI work) on the Linear issue and in
     #packages on Discord. The explainer shows the real code and the files touched; it assumes no access to the
     source.
   - Whoever implemented it must be able to answer questions about both its functionality and its code.
   - Armin and Mario review the code. What they find is a finding of this Review: it is fixed in the next Polish.
   - People with the devices test the UI by hand: Safari on iOS, Firefox on Android, Chrome on Android. They note on
     the issue what they used and found.
   - The whole team audits and signs off.
   - Colin and Jakob test it; what they find is fixed in the next Polish. Then it goes into the nightly (built from main by
     GitHub Actions; the Distribution area's item).

## Git

You build in a git worktree of your own, made from `origin/main` (`git worktree add --detach ../p3-<package>
origin/main`), never in the shared checkout; other sessions push to main beside you:

- Rebase onto `origin/main` before the gates and again before you push (`git fetch origin && git rebase origin/main`);
  push with `git push origin HEAD:main`; never force.

- Stage explicit paths only, and commit with `--`, so nothing you did not mean to commit goes in:
  `git commit -m "feat(p3): ..." -- <path> <path>`.
- Never `git add -A`, `git add .`, `git stash`, `git reset --hard`, `git checkout .`, `git clean -fd`,
  `git commit --no-verify`.
- A conflict in a file you did not change: stop and ask.
- Messages: `feat(p3): ...`, `fix(p3): ...`, `docs(p3): ...`; plain, no emojis. Never name competing products in the
  repository, its docs or commit messages.

### Commits on the Linear issue

Linear's GitHub integration links every pushed commit that names an issue key to that issue: the issue shows the
commit, and the commit is the record of what was built for it.

- Every commit names the issue it is for, at the end of its first line: `feat(p3): the runner refuses starts once it
  closed (ERNDL-1061)`. Name the most specific issue: the sub-issue of the part you changed, not the package's parent.
  A commit for several parts names each: `(ERNDL-1060, ERNDL-1061)`.
- Never use Linear's closing words with a key (`fixes`, `closes`, `resolves` and their forms): the integration would
  move the issue to Done on the push, but an issue is Done only after the people's review (the Review stage above).
  Status and stage labels are moved by hand.
- Only pushed commits are linked. A commit made before the integration, or for which the key was forgotten, is linked
  by hand: an attachment on the issue with the commit's GitHub URL, titled with its hash and first line.

## Checklist

- [ ] The stage label kept current: `Design`, `Implementation`, then `Review` and `Polish` in turn until a Review comes
      back clean.
- [ ] Plan as a comment on the item issue: p2's features sorted, extension points, files, contracts, tests,
      numbers, decisions.
- [ ] Every decision asked one at a time and recorded in the issue.
- [ ] Only your plugins changed, apart from the base-file changes listed for Mario; every other needed change written
      up and taken to its owner.
- [ ] `cd apps/p3 && npm run check` clean; `npm test` passes, serially and with four runs at once.
- [ ] The tests and numbers of `testing.md` and `performance.md`, reported in the issue.
- [ ] Two review rounds by Opus, Astra and Fable, each primed with the guides, their findings combined; reproductions
      are tests.
- [ ] Stored data migrated, not dropped.
- [ ] Pushed by explicit paths, every commit naming its issue's key (no closing words); video or explainer posted;
      questions on functionality and code answered; code reviewed by Armin and Mario; devices checked; team sign-off.

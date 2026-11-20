# Guides for package builders

Pi Roam (p3) is split into packages. Each package has an owner, and each owner builds with their own agent. These
guides are for that work. They are written for the agent first and for people second.

A package is one plugin or a few plugins of `apps/p3/plugins/` (the parts in `../overview.md`, "Plugins"), or a part
of one. Base code (`apps/p3/src/`) is not a package: it changes only through its owner (`process.md`, "Who decides").

## Read in this order

| # | Guide | What it is for | When |
| --- | --- | --- | --- |
| 1 | `process.md` | doing a package: from looking at p2 to the nightly; the brief, decisions, reviews, sign-off | before you take a package |
| 2 | `building.md` | how p3 fits together, the shape of a plugin, the rules, the API, where things are | before you write the brief, and while you build |
| 3 | `testing.md` | the three test tiers, what every package tests, the commands, UI tests, Android | before you write the brief's tests, and while you build |
| 4 | `performance.md` | the memory and time budgets, how to measure, hot-path rules, traps seen in p2 | before you write the brief's numbers, and before you report |

Then the docs the guides point to, each read in full once:

- `../chord-practices.md`: the shape of a p3 plugin, the rules decided, the mistakes made and their fixes.
- `../names.md`: one name per thing. Use these names in code, contracts, panes and docs.
- `../decisions.md`: Mario's decisions, newest last. A newer entry wins over an older one.
- `packages/chord/docs/design.md`: Chord, the framework p3 is built on. At least §§1-3, 6-11, 16-17, 21-23, 29-30.
- `packages/chord/docs/plugin-authoring.md`: how to write a Chord plugin (layout, imports, queries, admission,
  reloads, messages, `testPlugin`).

## Rules for these guides

- **Every API named here is real, with its file, or marked PROPOSED.** p3 is young: the web page, the terminal
  client, the harness, Apply and telemetry are not built yet. Never present a proposed API as built.
- **Self-contained.** The numbers are copied in, with where they come from. Some briefs cite private research files
  on slayer (`/home/badlogic/chord-notes/...`); the guides never depend on them.
- **Never name competing products** in these files, in code or in commit messages (root `AGENTS.md`).
- **Fix a guide when it is wrong,** in the same commit as the change that showed it. Docs are committed without
  review (`../workflow.md`, step 2).

## Open points

Points the guides depend on that Mario has not decided yet are marked **Open** where they apply. Until one is
decided, follow the interim rule the guide gives next to it.

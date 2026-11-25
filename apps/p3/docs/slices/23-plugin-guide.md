# Slice 23: The plugin guide

**Goal.** A guide for agents (and people) writing p3 plugins, as `packages/coding-agent/docs/extensions.md` is for
extension-writing agents, and the proof that Chord apps are easy to reason about.

**Builds:** one guide (where it lives is decided with the slice: p3's docs and a skill the agent loads) with the few
patterns a plugin needs, each as a complete, runnable example: a store with its table and named queries, a view with
its admission, a list (`self.list`), a contribution to a registry, a page and a terminal part, a reload-safe native.
The rules (one owner per datum, factories only declare, admission decides who gets what) and the footguns, each with
the mistake and its fix. Kept current with every later slice.

**The test (part of the slice):** a fresh agent given only the guide writes a private journal (one per person), a
sidebar grouping and a shared board. Lines, concepts used and mistakes are counted; a mistake the guide did not
prevent changes the guide (or the API). The result is recorded here.

**Depends on:** slice 14 of Chord (named queries, lists: built) and its admission part; slices 4 to 6 (admission,
people and apps, locks), so the guide shows the API as it settles.

**Read first:** `decisions.md` ("A plugin guide for agents", "The agent writes plugins"); `packages/chord/docs/plugin-authoring.md`;
`packages/coding-agent/docs/extensions.md` (the model for the form); p2's skill
`apps/p2/plugins/agent-plugins/skills/writing-p2-plugins/` and its example; the footguns in
`packages/chord/docs/design.md` (the p2 port's footguns 1, 7, 10).

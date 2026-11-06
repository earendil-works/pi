---
title: p3 step 0a: reloads without flashes
cover: Step 0a / No Flashes
kicker: A spec · p3 step 0a (Chord) · 2026-11-06
subtitle: Four fixes in Chord so that applying a plugin change shows nothing but the change, and "restart needed" means a restart is needed
stats:
  - 4 | fixes, all in Chord
  - 1 | decision (holds that survive a remount)
  - 1 RTT | of zero or empty screen today after every Apply
  - 0 | p3 code: p3 builds on this in step 0b
note: |
  The spec of step 0a, from the two reviews of the step-0 spec (`/tmp/p3-step0-review-adv.md`,
  `/tmp/p3-step0-review-design.md`) and the Chord code on branch `p3`. Fixes 2 to 4 are bugs against what design §21
  already promises; fix 1 changes how Chord's React and terminal bindings hold references and is the owner's decision.
  The loop these fixes polish is explained in the artifact "p3: the reload loop".
colophon: p3 step 0a · spec, first edition · 2026-11-06 · sources: src/react/hooks.ts, src/tui/scope.ts, src/web/scripts.ts, src/node/surfaces/bundle.ts, src/node/plugins/watcher.ts, design §21, §23
---

# Before we begin {.preface}

Mario's counter says 3. An agent changes the `hello` plugin's page code and he taps Apply. For one round trip to the
server the counter says 0, then 3 again. If he taps in that moment, nothing happens. If the agent had changed the
shell, the whole page would have gone blank for that round trip. If the change was to a stylesheet, the page would
have flashed unstyled. And after an `npm run build` somewhere in the checkout, the bar says "restart needed" although
nothing p3 runs has changed, and keeps saying it until a restart.

None of this is what design §21 promises ("components remount; scroll, other plugins and page state stay"; "restart
needed" for base code only). Step 0a fixes it in Chord, before p3 builds on it: four fixes, one of them a decision.

## Four things to know

:::findings
1. **Holds survive a remount (decision).** A page keeps one shared reference per object; a component that mounts
   takes the one that is already there, with its values, in its first render. The last component letting go releases
   it a second later. No zero, no blank, no lost tap; a save in flight when its component unmounts finishes.
2. **Stylesheets swap after the new one loaded.** The old sheet stays until the new one fired `load`.
3. **The page's base bundle resolves packages as the server does.** It is built with the server process's resolution
   conditions, like the worker base: in this checkout Chord's source, never a stale `dist/`.
4. **"Restart needed" compares content.** The mark is set only when a base file's bytes differ from what the base was
   built from, and clears when they are the same again.
:::

# Holds That Survive a Remount {#holds lede="Why the counter shows 0 after an Apply, and the one change that fixes it on pages and in terminals."}

## The problem

`useHold` makes its reference in an effect, after the first render, and the reference has no values until the
server's `bound` arrives:

```ts
// packages/chord/src/react/hooks.ts today
export function useHold<C extends Contract>(Type: C, params: ParamsOf<C>): Held<C> | undefined {
	const [held, setHeld] = useState<...>(undefined);
	useEffect(() => {
		const ref = host.hold(Type, params, BACKGROUND_CONTEXT);   // a new request: no values until `bound`
		setHeld({ key, ref });
		return () => ref.release();                                 // the old component's: released at unmount
	}, [host, Type, key]);
	return held?.ref;                                               // undefined in the first render
}
```

An Apply of `hello` replaces its component with a new function, so React unmounts the old `HelloPart` and mounts the
new one. The new one renders `undefined`, then a reference without values, then, one round trip later, the count. The
old component's reference had the count all along and is released in the same commit. `useRegistry` has the same
shape (`host.registry(R)` is a promise, read in an effect), which is why a shell reload blanks the page. A terminal
component's `scope.hold` makes a new request the same way.

:::sequence | Today: an Apply of hello's page code. The new component starts from nothing.
actor react "React" "the page"
actor old "old HelloPart" "ref A: count 3" muted
actor neu "new HelloPart" "" accent
actor server "server" "Hello"
react -> neu: render: useHold: undefined -> shows 0
react -> old: unmount: ref A released
server --> old: (release A)
react -> neu: effect: host.hold -> ref B (no values)
neu -> server: hold B
server --> neu: bound B: count 3
react -> neu: render: shows 3
:::

## The fix

Each host keeps a table of **shared holds**: one reference per (type, contract version, params by value), counted by
the components using it. A component reads the table during render and takes the reference it finds; its effect adds
its count; its cleanup removes it. When the count reaches zero, the reference is released **after a linger of one
second**, unless a component takes it again before. React components and terminal scopes use the same table (it lives
in the portable `src/surfaces/`, beside page state).

```ts
// packages/chord/src/surfaces/shared-holds.ts (new): one per host, as page state is
export function sharedHold<C extends Contract>(host: Host<Principal>, Type: C, params: ParamsOf<C>): SharedHold<C>;
type SharedHold<C> = {
	/** The reference if one is held now (by a component or a lingering release): readable during a render. */
	peek(): Held<C> | undefined;
	/** Holds (making the reference when none is held) and counts the caller; the returned function lets go. */
	acquire(): () => void;
};

// packages/chord/src/react/hooks.ts
export function useHold<C extends Contract>(Type: C, params: ParamsOf<C>): Held<C> | undefined {
	const shared = sharedHold(useHost(), Type, params);           // the table's entry for this key, made on demand
	const held = useSyncExternalStore(shared.subscribe, shared.peek, shared.peek);
	useEffect(() => shared.acquire(), [shared]);                  // count while mounted; let go at unmount
	return held;
}

// packages/chord/src/tui/scope.ts
hold<C extends Contract>(Type: C, params: ParamsOf<C>): Held<C> {
	const shared = sharedHold(this.#host, Type, params);
	this.#releases.push(shared.acquire());
	return shared.peek()!;
}
```

`useRegistry` gets the same treatment, simpler: once a host has resolved a registry's value, it keeps the
`RegistryValue` (a live view that follows the registry across reloads of its provider) in a per-host table, so every
later mount reads it in its first render. Only the very first use on a page waits for it.

:::sequence animate | With the fix: the new component takes the reference the old one held, values included.
actor react "React" "the page"
actor table "shared holds" "Hello {}: ref A, count 1" accent
actor old "old HelloPart" "" muted
actor neu "new HelloPart" ""
react -> neu: render: peek -> ref A: shows 3
react -> old: cleanup: let go (count 0, linger starts)
react -> neu: effect: acquire (count 1, linger cancelled)
note table: no new request, no round trip
:::

## Why one second, and what else it fixes

- **The remount itself needs no linger**: React renders the new component before it runs the old one's cleanup, so the
  reference is still counted when the new one peeks. The linger covers the orders where cleanup comes first: a
  component that unmounts and mounts again a moment later (a list re-keyed, a route switched back, a plugin's script
  arriving a frame after its contribution left), and a terminal redraw.
- **A save in flight survives its component.** Releasing a reference rejects the calls made through it (design §7).
  Today a component that sends a message and unmounts (a remount by a reload, a navigation) aborts its own send. With
  the linger, a call has a second to finish after the last component let go; this is the "lost save on remount" the
  reload reviewers found earlier (chord state, open item 3), solved by the same table.
- **Fewer requests**: two components showing the same object share one reference, one hold over the link.

The cost: a reference stays held one second after it is last used (its object lingers on the server that long, as
`linger` does for provider objects), and one map entry per held key.

**Alternatives.** (B) Keep per-component holds and add a one-second release delay to each: the new component still
starts from nothing (its own new request), so the flash stays; only the lost save is fixed. (C) The page keeps the last
values per type and params in page state and shows them until the new reference binds: a second copy of state beside
the reference, stale by design, and the tap in the gap still has no reference to call.

# The Other Three {#bugs lede="Bugs against what design §21 already says: no decision, a test each."}

## Stylesheets swap after the new one loaded

`syncStylesheets` (`src/web/scripts.ts`) removes the plugin's old `<link>` and appends the new one in the same
moment, so between the removal and the new sheet's download the plugin's components are unstyled. Fix: append the new
link first; remove the old one when the new one fires `load` (or `error`, reported). Two sheets of one plugin apply for
that moment; the new one comes later in the document, so it wins where they differ.

## The page's base bundle resolves as the server does

`buildBase` (`src/node/surfaces/bundle.ts`) bundles with esbuild's default conditions. In this monorepo
`@earendil-works/chord` then resolves to its built `dist/`, while the server (started with `--conditions=source`)
runs Chord's source. Two consequences: the page may run other Chord code than the server, and every `npm run build`
touches `dist/` files the base was built from, setting the restart mark. The worker base already solves this
(`conditionsOf(execArgv)` in `src/node/workers/base.ts`). Fix: the surfaces' base bundles use the server process's own
conditions (`process.execArgv`), the same helper, moved where both use it.

## "Restart needed" compares content

The watcher (`src/node/plugins/watcher.ts`) sets `base` on any file event under base code and never clears it. A
formatter that rewrites a file unchanged, an editor's swap file, `git checkout` of a branch and back: all say "restart
needed" until a restart. Fix: when the kit hands the watcher its base files, it records each file's content hash (the
base bundles' inputs from esbuild's metafile, the app's `base` files and directories); an event re-hashes the file
and `base` is true while any file differs from its recorded hash (or a recorded file is gone, or a new file appears in
a base directory that a bundle would now import: a new file in `src/` counts as changed). Back to the recorded bytes,
the mark clears.

# Tests and Done {#done lede="What the build delivers."}

- `src/surfaces/shared-holds.ts` with tests: peek during a remount returns the held reference; the count; the linger
  (released after one second, kept when acquired within it); a call in flight finishing after its component let go;
  params by value; a GC test of the table (an entry goes with its release).
- `useHold`, `useRegistry` and `TuiScope.hold` on the table; the browser test (`test/node/react/hooks.test.ts`) gets a
  frame recorder: a component counting its renders' values shows no `undefined` and no initial value after a remount
  through a plugin reload; the same for the terminal scope.
- `syncStylesheets` swaps after `load`, tested in the browser with a slow stylesheet.
- `buildBase` uses the server's conditions; a test that a base built with `--conditions=source` lists source files as
  inputs, not `dist/`.
- The watcher's `base` by content: tests for a rewrite with equal bytes (no mark), a change and its revert (mark, then
  clear), a new file in a base directory (mark).
- `npm run check`; Chord's suites that touch these (react, tui, web, surfaces, plugins, reload, the app kit); the
  reload suite (`test/node/reload/`) gets a step that applies a page plugin and asserts no frame without the value;
  design §21 ("What a user sees during a reload"), §23 and the READMEs updated; a decision entry for fix 1.

Then step 0b builds p3's base, `hello` and the reload suite on top.

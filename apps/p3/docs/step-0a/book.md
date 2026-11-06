---
title: p3 step 0a: reloads without flashes
cover: Step 0a / No Flashes
kicker: A spec · p3 step 0a (Chord) · 2026-11-06
subtitle: Four fixes in Chord so that applying a plugin change shows nothing but the change, and "restart needed" means a restart is needed
stats:
  - 4 | fixes, all in Chord
  - 1 | decision (components share references)
  - 1 RTT | of zero or empty screen today after every Apply
  - 0 | p3 code: p3 builds on this in step 0b
note: |
  The spec of step 0a, from the two reviews of the step-0 spec (`/tmp/p3-step0-review-adv.md`,
  `/tmp/p3-step0-review-design.md`) and the Chord code on branch `p3`. Fixes 2 to 4 are bugs against what design §21
  already promises; fix 1 changes how Chord's React and terminal bindings hold references and is the owner's decision.
  The loop these fixes polish is explained in the artifact "p3: the reload loop".
colophon: p3 step 0a · spec, first edition, revised after two reviews · 2026-11-06 · sources: src/react/hooks.ts, src/tui/scope.ts, src/web/scripts.ts, src/node/surfaces/bundle.ts, src/node/plugins/watcher.ts, design §21, §23
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
1. **Components share references (decision).** A page or terminal keeps one reference per object a component holds;
   a component that mounts takes the one already there, values included, in its first render. No timer: a reference
   is released once no component uses it and no call made through it is still running, checked after the update that
   let go of it. All in the client bindings (`chord/react`, `chord/tui`); the kernel only gains a read-only "calls
   running" on references.
2. **Stylesheets load before the plugin reloads.** A page fetches a plugin's new stylesheet and waits for its `load`
   before it reloads the plugin's script, and removes the old sheet after.
3. **The page's base bundle resolves packages as the server does.** Built with the server's resolution conditions
   (an explicit option, the server's own by default), like the worker base: in this checkout Chord's source, never a
   stale `dist/`.
4. **"Restart needed" compares content.** The bundles record the bytes they read; the mark is true while a source
   file differs from what was read, and clears when it is the same again.
:::

# Components Share References {#holds lede="Why the counter shows 0 after an Apply, and how handing the reference over inside the page removes it."}

## The problem

`useHold` makes its reference in an effect, after the first render, and a new reference has no values until the
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
old component's reference had the count all along and is released in the same commit. A tap in between has no
reference to call. A terminal component's `scope.hold` makes a new request the same way. `useRegistry` and
`scope.registry` read the registry through a promise in an effect, so a shell reload renders an empty page for one
commit.

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

Each host gets a table of **shared references**, kept beside its page state (`src/surfaces/`, portable: React and the
terminal scope use it). Today every component's `hold` is its own reference, its own request over the link, its own
copy of the values (`RemoteObject`: "two references are two holds"); the objects themselves are already shared on the
provider. With the table, components on one host share the reference too.

- **Key**: the contract's name, version and fingerprint, and the params by value (canonical JSON). After an Apply the
  plugin's script evaluates its contract again, so the token is a new object: keyed by the object, the new component
  would miss the entry. Keyed by name and version only, a contract edited without a version bump would get a reference
  of the old shape. The fingerprint is the contract's own (`fingerprintOf`), computed once per token.
- **Reading is pure**: during a render a component only peeks (`peek(key)`: the reference held now, or `undefined`);
  it never makes an entry. React may render and throw the render away (StrictMode, an interrupted transition); a
  render that made entries would leave references nobody releases.
- **Holding is in the effect**: `acquire(key)` makes the reference when none is held (with a host-lifetime context
  and the default options, never the first caller's), counts the component, and returns its let-go.
- **Release without a timer**: when the count reaches zero, the table waits for the end of the update (a task after
  the commit), then releases the reference if the count is still zero and no call made through it is running; if a
  call runs, it releases when the last one settles (unless a component took the reference meanwhile). React renders
  the new component before it runs the old one's cleanup and runs the new one's effects right after, so a remount's
  hand-over always finds the count back at one.
- **Ended references leave**: a reference that ends (revoked, its host closed, released by anyone through `release()`)
  is removed from the table at once; the next acquire makes a new one. A component never calls `release()` on a shared
  reference itself (the README says so; the table's let-go is the release).

```ts
// packages/chord/src/surfaces/shared-holds.ts (new): one table per host, as page state is
/** The shared reference to `Type` with `params` on `host`: read during a render, held from an effect. */
export function sharedHold<C extends Contract>(host: AnyHost, Type: C, params: ParamsOf<C>): SharedHold<C>;
export type SharedHold<C extends Contract> = {
	/** The reference held now (by a component, or waiting for its release): readable during a render. */
	peek(): Held<C> | undefined;
	/** Notifies when `peek` changes (a reference made, ended or released): for `useSyncExternalStore`. */
	subscribe(changed: () => void): () => void;
	/** Holds (making the reference when none is held) and counts the caller; the returned function lets go. */
	acquire(): () => void;
};

// packages/chord/src/react/hooks.ts
export function useHold<C extends Contract>(Type: C, params: ParamsOf<C>): Held<C> | undefined {
	const shared = sharedHold(useHost(), Type, params);           // a stable handle per key (no entry made here)
	const held = useSyncExternalStore(shared.subscribe, shared.peek, shared.peek);
	useEffect(() => shared.acquire(), [shared]);                  // count while mounted; let go at unmount
	return held;
}
```

`TuiScope.hold` acquires in place of `host.hold` and keeps its watch of the reference's state for redraws, as today.
`useRegistry` and `TuiScope.registry` read the registry's value synchronously once the host has it (the host keeps one
value per registry and version already; a synchronous accessor returns it, `undefined` before the first resolution),
so only a page's very first use waits.

:::sequence animate | With the fix: the new component takes the reference the old one has, values included.
actor react "React" "the page"
actor table "shared references" "Hello {}: ref A, 1 user" accent
actor old "old HelloPart" "" muted
actor neu "new HelloPart" ""
react -> neu: render: peek -> ref A: shows 3
react -> old: cleanup: let go (0 users: release after the update)
react -> neu: effect: acquire (1 user)
note table: nothing sent: no release, no new hold
:::

## What changes in the rules

- **Design §7 and slice 11 P7/P9**: "released when the component unmounts" becomes "released when no component on the
  host uses it and no call made through it is running". References stay the only indirection; the table hands out the
  host's own references. Nothing waits on a clock: design §19's "no consumer-side linger" (decision D8) stays, refined
  in one point: a running call counts as a user of its reference.
- **A save in flight survives its component.** Releasing a reference rejects its calls (design §7). Today a component
  that sends and unmounts (a remount by a reload, a navigation) aborts its own send; with the table its reference stays
  until the send settled, however long it takes. This is the "lost save on remount" the reload reviewers found earlier.
- **Fewer requests**: two components showing the same object share one reference and one hold over the link.
- **Presence**: a page's reference ends at the end of the update that dropped its last component, or when its last
  call settles, as before up to the call.
- **The kernel gains one read-only member** on references (internal, not exported to apps): whether calls made through
  it are running, with a notification when the last settles.

What still shows a first value after a remount, by design: a component whose params changed (another object), a
contract whose version or fingerprint changed in the reload (another reference: it must bind the new shape), and a
component's own `useState` and `useOptimistic` (they start over; page state survives).

**Alternatives.** (B) A one-second release delay per reference: reverses D8 (a consumer-side linger), cuts calls
longer than a second, and needs the table anyway to hand the reference to the new component. (C) Last values per type
and params kept in page state: a second copy of state, stale by design, and the tap in the gap has no reference.

# The Other Three {#bugs lede="Bugs against what design §21 already says: no decision, a test each."}

## Stylesheets load before the plugin reloads

The page applies a new set in `surfaces/client.ts` (`#apply`): it fetches the changed scripts, reloads its host, and
only then `syncStylesheets` (`web/scripts.ts`) removes the old `<link>` and appends the new one. Between the reload and
the new sheet's download, the plugin's new components are unstyled; a renamed or added CSS-module class stays unstyled
until then, and removing the old sheet first unstyles the rest.

Fix: `#apply` loads the set's new stylesheets first (a `<link>` per new sheet, inserted at the position of the plugin's
old one so the cascade order stays, awaiting `load`), then reloads the host, then removes the sheets no longer in the
set. A sheet that fails to load is reported and the plugin's old sheet stays. A plugin whose new script failed and kept
its old code keeps its old sheet too. Sets arriving back to back apply in order (the queue `#apply` already has).

## The page's base bundle resolves as the server does

`buildBase` (`node/surfaces/bundle.ts`) bundles with esbuild's default conditions. In this monorepo
`@earendil-works/chord` then resolves to its built `dist/`, while the server (started with `--conditions=source`) runs
Chord's source: the page may run other Chord code than the server, and every `npm run build` changes files the base was
built from. The worker base solves it already (`conditionsOf(execArgv)` in `node/workers/base.ts`).

Fix: the web and terminal surfaces take `conditions` (default: the server process's own, from `process.execArgv` and
`NODE_OPTIONS`), and `buildBase` passes them to esbuild; for browser builds it adds `module`, which esbuild's defaults
include and custom conditions drop. The helper reading the conditions moves next to `metafileInputs` in `bundle.ts`,
where the worker base imports it too. The terminal bundle is built on the server, so its conditions are the server's.

## "Restart needed" compares content

The watcher (`node/plugins/watcher.ts`) sets `base` on any file event under base code and never clears it: a formatter
that rewrites a file unchanged, an editor's swap file, a branch switched and back all say "restart needed" until a
restart.

Fix:
- **The builds record what they read**: the base bundles (web, terminal, worker) hash each input's bytes in an esbuild
  `onLoad` hook as they read it (not later, so an edit between the build and the watcher's start is not missed); the
  app's `base` files are hashed when the kit starts.
- **The mark is recomputed on each event**: a changed path is hashed again; `base` is true while any recorded file
  differs or is gone. Back to the recorded bytes, the mark clears.
- **New files** in a base directory count only with a source extension (`.ts`, `.tsx`, `.js`, `.mjs`, `.json`,
  `.css`): editor swap files and temporary files do not; a new source file that comes and goes clears again.
- **A directory removed and recreated** under base code is watched again (today its watch is lost, which would turn
  into a silent "no restart needed" once the mark can clear).

# Tests and Done {#done lede="What the build delivers."}

- `src/surfaces/shared-holds.ts`, tests: a peek during a remount returns the held reference; keys by name, version,
  fingerprint and params (a re-evaluated token with the same contract finds it; a changed fingerprint does not); a
  render that is thrown away makes no entry; release after the update with zero users; a call running keeps the
  reference until it settles, then it is released; an acquire while the release waits cancels it; an ended reference
  leaves the table; a GC test of the table.
- `useHold`, `useRegistry`, `TuiScope.hold` and `TuiScope.registry` on it; the existing assertion in
  `test/node/react/hooks.test.ts` that a remount makes a new reference changes; the browser test records every
  rendered value: no `undefined` and no initial value after a remount through a real plugin reload (`host.reload` with a
  new script of the plugin), for a hold and for a registry; the same for the terminal scope.
- Stylesheets: a slow stylesheet in the browser; the new class styled in the first frame after the reload; a failing
  sheet keeps the old one.
- Base bundles: a base built with `conditions: ["source"]` lists source files as inputs; the default reads the
  server's flags and `NODE_OPTIONS`.
- The watcher: a rewrite with equal bytes (no mark), a change and its revert (mark, then clear), a swap file (no mark),
  a new source file (mark) removed again (clear), a directory removed and recreated (watched again).
- `npm run check`; Chord's suites that touch these (react, tui, web, surfaces, plugins, reload, the app kit); the
  reload suite (`test/node/reload/`) gets a step that applies a page plugin and asserts no frame without the value; an
  example in `test/examples/` showing two components sharing a reference across a reload; design §7, §19, §21 ("What a
  user sees during a reload"), §23, the READMEs, and a decision entry for fix 1 (superseding P7 and P9 in part,
  refining §7's release and D8).

Then step 0b builds p3's base, `hello` and the reload suite on top.

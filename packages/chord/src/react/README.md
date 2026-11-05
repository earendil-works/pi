# react

React bindings (slice 11 §3, decision "Slice 11, P7"): `@earendil-works/chord/react`; optional (React is an optional
peer), non-React apps never load it. No components, no styling.

- `HostProvider({ host })`, `useHost()`.
- `useHold(Type, params)`: a reference held while the component is mounted, released on unmount, held again when its
  params change (compared by value); `undefined` on the first render.
- `useWatch(watchable)`: its current value (`undefined` while it has none), re-rendering on change
  (`useSyncExternalStore` over `watchStore`).
- `useRegistry(R)`: the registry's composed value; `useRefState(ref)`: the reference's state.
- `useMessages(t)`: `{ t, locale }`, a plugin's messages bound to the host's language (followed by `startPage`),
  re-rendering when the locale or a translation changes; before a language is followed, the first catalog.
- `usePageState(key, initial)`: `useState`'s pair, the value kept by the page (its host's life) under `key`
  (`surfaces/page-state.ts`, shared with `TuiScope.pageState`), so a component remounted by a plugin reload keeps it.
- Optimistic UI needs no hook of Chord's: React's `useOptimistic` and `startTransition` over a call. A call settles in
  the page after every change its answering host (and a host relaying its answer) committed before answering, so the
  optimistic value is replaced by the real one, never by the old (design §3, decision "A call's answer follows its
  state"; changes committed after the answer or on a host that does not relay it are not covered). The guide's
  "Optimistic UI" (`docs/guide-plugins-hosts/book.md`) shows it.
- A component unmounted by a reload has not left (design §21): its releases are plain releases. A component of a
  reloaded plugin is a new function and remounts, its `useState` starting over: what must survive is page state.

Tests: `test/node/react/` (`stores.test.ts` in Node, `hooks.test.ts` in a real browser); the page state alone in
`test/surfaces/page-state.test.ts`.

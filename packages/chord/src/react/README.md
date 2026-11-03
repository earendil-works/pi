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
- A component unmounted by a reload has not left (design §21): its releases are plain releases. A component of a
  reloaded plugin is a new function and remounts, its `useState` starting over: what must survive is page state.

Tests: `test/node/react/` (`stores.test.ts` in Node, `hooks.test.ts` in a real browser); the page state alone in
`test/surfaces/page-state.test.ts`.

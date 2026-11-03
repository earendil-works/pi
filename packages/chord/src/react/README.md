# react

React bindings (slice 11 §3, decision "Slice 11, P7"): `@earendil-works/chord/react`; optional (React is an optional
peer), non-React apps never load it. No components, no styling.

- `HostProvider({ host })`, `useHost()`.
- `useHold(Type, params)`: a reference held while the component is mounted, released on unmount, held again when its
  params change (compared by value); `undefined` on the first render.
- `useWatch(watchable)`: its current value (`undefined` while it has none), re-rendering on change
  (`useSyncExternalStore` over `watchStore`).
- `useRegistry(R)`: the registry's composed value; `useRefState(ref)`: the reference's state.
- A component unmounted by a reload has not left (design §21): its releases are plain releases.

Tests: `test/node/react/` (`stores.test.ts` in Node, `hooks.test.ts` in a real browser).

# tui (sandbox side)

The terminal client's code inside the sandbox (slice 11 §4, decisions "Slice 11, P8" and "P9"):
`@earendil-works/chord/tui`. The launcher is `@earendil-works/chord/tui/launcher` (`src/node/tui`), the server side
`@earendil-works/chord/surfaces` (`tuiSurface`).

```ts
// the app's terminal entry (its base bundle)
startTerminalRuntime<P>({
	modules: { "@acme/app/v3": api, "@acme/app/v3/tui": apiTui },
	core: [{ name: "@acme/tui", facet: tuiCore }],
	render: ({ host, terminal, theme, copy, open, attach, exit }) => {
		const scope = new TuiScope(host, () => redraw());          // hold, watch, registry; dispose
		terminal.onInput((data) => …); terminal.write(frame);
		theme.fg("accent", "Notes");                             // colours by role
		const t = scope.messages(messages);                      // a plugin's texts in the host's language
	},
});
```

- `bridge.ts`: the messages between the sandbox and the launcher (input, resizes, relayed link sockets, requests with
  replies: a plugin script, the server's base, `copy`, `open`; `outdated`, `exit`, `failed`). The bootstrap leaves the
  bridge on `globalThis.chordBridge`; the runtime takes it off before any plugin runs.
- `channel.ts`: the sandbox's side: requests, `RelayLink` (a Chord link whose bytes the launcher relays), input and
  resizes. `terminal.ts`: the bridged terminal (size, write, input, resize). `theme.ts`: the theme lookup (`fg`, `bg`,
  `onChange`). `runtime.ts`: the client (`startClient` with `TuiScripts`; scripts run with `vm`; no wakes), the kit's
  themes and translations, the language followed from the user's pick and the launcher's `locales` (the bridge's
  start).
- `scope.ts`: `TuiScope(host, changed)`: `hold`, `watch` (a reader, `undefined` while no value), `registry`, `on(member,
  listener)` (an event member subscribed until `dispose`; events call the listener only, never `changed`),
  `pageState(key, initial)` (the host's value at `key`, shared with React's `usePageState`: a scope opened again after a
  plugin reload finds it), `messages(t)` (a plugin's messages in the host's language at each call; a change of the
  locale or a translation calls `changed`), `optimistic(read, reduce?)` (React's `useOptimistic`: the reader, `add(action,
  call)` showing `reduce(current, action)` over every action in flight (no reducer: the last action) until every call
  added settled, and `pending`), `dispose` (no `changed` after it). References wait and rebind by
  themselves; no terminal library dependency.

Tests: `test/tui/` and, with the launcher and sandbox, `test/node/tui/`.

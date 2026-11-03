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
	},
});
```

- `bridge.ts`: the messages between the sandbox and the launcher (input, resizes, relayed link sockets, requests with
  replies: a plugin script, the server's base, `copy`, `open`; `outdated`, `exit`, `failed`). The bootstrap leaves the
  bridge on `globalThis.chordBridge`; the runtime takes it off before any plugin runs.
- `channel.ts`: the sandbox's side: requests, `RelayLink` (a Chord link whose bytes the launcher relays), input and
  resizes. `terminal.ts`: the bridged terminal (size, write, input, resize). `theme.ts`: the theme lookup (`fg`, `bg`,
  `onChange`). `runtime.ts`: the client (`startClient` with `TuiScripts`; scripts run with `vm`; no wakes).
- `scope.ts`: `TuiScope(host, changed)`: `hold`, `watch` (a reader, `undefined` while no value), `registry`, `dispose`
  (no `changed` after it). References wait and rebind by themselves; no terminal library dependency.

Tests: `test/tui/` and, with the launcher and sandbox, `test/node/tui/`.

# web (browser side)

`startPage` (slice 11 §2) for the app's web entry, the base bundle the server builds: `@earendil-works/chord/web`. The
server side is `@earendil-works/chord/surfaces` (`webSurface`).

```ts
startPage<P>({
	connect: () => new WebSocket(`${location.origin.replace(/^http/, "ws")}/chord`),
	modules: { "@acme/app/v3": api, "@acme/app/v3/web": apiWeb, react: React, "react/jsx-runtime": jsx },
	core: [{ name: "@acme/web", facet: webCore }],
	canRetry: async () => true,                    // false: stop reconnecting (a guest's ended share)
	onConnection: (state) => setBanner(state),     // connecting | connected | waiting
	render: (host) => createRoot(root).render(<HostProvider host={host}><App /></HostProvider>),
	telemetry: true,                               // record: spans sent to the server's PageTelemetry
});
```

- The page's inline bootstrap (`PageAssets.bootstrap`, the response's nonce) defines `chordFacet` before the combined
  file runs; its scripts queue, and `startPage` takes them (`scripts.ts`). Later scripts load with `<script src>`, one
  each, and resolve the fetch that asked for them; no `eval` (the page's CSP: `'self'` and the nonce).
- The kit's `Themes` provider is among the core facets; the active theme (the registry, the user's `ThemeChoice`,
  `prefers-color-scheme`) is written as CSS custom properties and `color-scheme` on `:root` (`themes.ts`), no reload.
- The kit's `Translations` provider is among them too; the active language (the registry, the user's `LocaleChoice`,
  `navigator.languages`, followed on `languagechange`) is the host's language for `useMessages`, and `lang` and `dir`
  on the root element (`language.ts`, `followLanguage`); reports reach `onError` as `{ kind: "messages", report }`.
- A new set's plugin stylesheets replace the old ones (`syncStylesheets`); an outdated page reloads.
- With `telemetry: true` the page's host records in memory (`TelemetryRecorder`, span ids `browser:<incarnation>:<n>`)
  and sends finished spans to the server's `PageTelemetry` every 3 s and when the page is hidden; a click is a trace of
  its own with `host.root(fn, ctx, { trace: { name } })`. The kit's server serves the object when it has a store.
- Wakes (`environment.ts`): visible again, `online`, `pageshow` from the back/forward cache, Chromium's network change.

Tests in a real browser: `test/node/web/` (Chromium: `CHROMIUM_BIN`, else `chromium-docker`; skipped without).

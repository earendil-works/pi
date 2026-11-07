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
- Plugin stylesheets follow the code each plugin runs (`PageStyles`, `styles.ts`, the client's `styles`; the bootstrap
  names each plugin's `<link>` and records how its load ended: a stylesheet that failed at the page's first load, an
  HTTP error included, is loaded again like one that failed later). An update fetches a plugin's new stylesheet inactive
  (`media="not all"`: loaded, not applied) right after its old one (a plugin new to the page at its place in the set's
  order: the cascade between plugins stays) and waits for it (`load` or `error`, at most 10 s) before the reload. Then
  it applies the new stylesheet of each plugin whose new code was adopted and retires the old one once the page has
  drawn a frame after the reload; a plugin whose new script failed (it kept its old code) never shows its new
  stylesheet, which is dropped unapplied. A stylesheet that does not load, or not within 10 s, is reported
  (`stylesheet_failed`) and the new code applies anyway; one still loading after 10 s applies when it loads, and one
  that failed is fetched again by the next update (the same URL). The client's stop ends the wait and removes the
  stylesheets it prepared; their requests finishing later change nothing.
- **Limitation: UI an object contributes.** The old stylesheet is retired a frame after the reload, which is right for
  UI a plugin's facet contributes (its new components replace the old ones in that reload). An object that contributes
  UI keeps its old contribution until its successor is live (design §21: draining routines, a slow native, a
  dependency): during that restart its old UI can show unstyled (its classes' rules are gone). The browser test
  `styles.test.ts` keeps this visible. Contribute UI from facets to avoid it.
- An outdated page reloads.
- With `telemetry: true` the page's host records in memory (`TelemetryRecorder`, span ids `browser:<incarnation>:<n>`)
  and sends finished spans to the server's `PageTelemetry` every 3 s and when the page is hidden; a click is a trace of
  its own with `host.root(fn, ctx, { trace: { name } })`. The kit's server serves the object when it has a store.
- Wakes (`environment.ts`): visible again, `online`, `pageshow` from the back/forward cache, Chromium's network change.

Tests in a real browser: `test/node/web/` (Chromium: `CHROMIUM_BIN`, else `chromium-docker`; skipped without).

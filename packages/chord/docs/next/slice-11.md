# Slice 11: web and TUI surfaces (spec)

Status: **approved** (owner, 2026-10-30/11-01: P1-P9 in the decisions "Slice 11's points" and "Slice 11, P3" to "P9",
then "go ahead, just do all the things"). Built after slices 12 and 13: the surfaces are generic plumbing that the app
kit wires in (`startApp` serves the web surface; a TUI client entry). The app keeps everything visible: HTML shell,
CSS, components, themes, navigation, layout, keys.

Read in full before writing code: this spec; `decisions.md` (slice 11's entries, the plugin model, the app kit);
`design.md` §3 (clients), §21, §23 (all, "Web and TUI" included); `slice-10.md`, `slice-12.md`, `slice-13.md`; p2's
`src/hosts/web.ts`, `src/hosts/web/main.tsx`, `src/web/reconnect.ts`, `src/runtime/web.tsx`, `src/hosts/bundles.ts`,
`src/hosts/tui.ts`, `src/hosts/tui-client.ts`, `src/hosts/tui-sandbox.ts`, `src/hosts/tui-bootstrap.mjs`,
`src/hosts/tui-worker-runtime.ts`, `src/runtime/tui.ts` (`TuiScope`).

## 1. `chord/next/web` (server side)

```ts
// inside startApp (slice 13), or by hand:
const web = webSurface(server, {
	kind: "web", plugins,
	entry: "./src/web/main.tsx",                       // the app's web start code: the base bundle's entry
	page: (request, assets) => shell(request.nonce, assets),   // the app's HTML; assets: base script, plugins file, styles
}, ctx);
// its facet (routes to Http, the WebScripts object) goes into the server's core facets
```

- **Base bundle** per client kind: built on the server by esbuild from `entry`, with the kind's host packages inlined
  once (the app's API modules for the kind, Chord, React), content-hashed (`/_chord/web/base.<hash>.js`), cached
  forever (`Cache-Control: immutable`, overriding the baseline's `no-store` for these routes only); rebuilt when base
  code changes (the server restarts anyway: built at start).
- **Plugin scripts:** each web facet served as a script that registers itself (`chordFacet("<plugin>", "<digest>",
  function (require, module, exports) { … })`, P2), at `/_chord/web/plugin/<plugin>.<digest>.js`, immutable; the
  current set as one combined file `/_chord/web/plugins.<set-hash>.js` (P3); stylesheets and assets of the build
  likewise, under `publicPath`.
- **`WebScripts`** (a `remote` object the surface serves, params `{}`, any principal that may load the app): its state
  is the current set `{ plugins: [{ name, digest, url, css? }], base }`; a rollout that ships the web kind updates it
  (the plugins component's `scripts("web")` changes; the surface follows them) without waiting for pages (P5).
- Routes and the page are `Http` contributions of the surface's facet; the page route is `page: true` (navigation from
  another site allowed) and public or not as the app says.

## 2. `chord/next/web` (browser side)

```ts
// src/web/main.tsx (the app's entry, in the base bundle)
startPage<P>({
	connect: () => new WebSocket(`${location.origin.replace(/^http/, "ws")}/chord`),
	modules: { "@acme/app/v3": api, "@acme/app/v3/web": apiWeb, react: React, "react/jsx-runtime": jsx },
	core: [{ name: "@acme/web", facet: webCore }],
	canRetry: async () => true,
	onConnection: (state) => setBanner(state),
	render: (host) => createRoot(document.getElementById("root")!).render(<HostProvider host={host}><App /></HostProvider>),
});
```

- A client host (no address); the connection loop (P6, p2's `keepConnected`: reconnect 250 ms to 5 s, wake on
  visibility, `online` and network change, replace a silent socket, stop on an outdated protocol (reload the page) or
  when `canRetry` says no); `onConnection` reports `connecting | connected | waiting`.
- Loads the combined plugins file, evaluates each registered facet with `modules` (the `require` they get answers only
  host packages and `@earendil-works/chord/next/plugins`'s browser half if any), loads them with `core` in one
  `host.load`, then holds `WebScripts`: on a new set it fetches the changed scripts (`<script src>`, one each), and
  calls `host.reload` with the complete set (P4: in place; a failed plugin keeps its old facet, reported to the app);
  a changed `base` hash reloads the page.
- CSP: scripts are `'self'` plus the nonce for the page's inline bootstrap; no `eval`.

## 3. `chord/next/react`

`HostProvider`, `useHost()`, `useHold(Type, params)` (a reference held for the component's life, released on unmount,
re-held when params change), `useWatch(watchable)` (the current value, re-rendering on change; `useSyncExternalStore`),
`useRegistry(R)`, `useRefState(ref)`. A component unmounted by a reload has not left (design §21): releases are plain
releases, presence is the app's. No components, no styling.

## 4. `chord/next/tui`

- **Launcher** (trusted, a Node process): `startTerminal({ url, token | tokenFile, pairing?, ... })` connects (a token
  from the owner token file, slice 13, or device pairing), downloads the base bundle and the TUI kind's plugin scripts
  over HTTP, and starts the **sandbox**: a worker thread with dropped permissions (Node's permission model: no file
  system, no child processes, no network except the bridge; p2's `tui-sandbox.ts`), always (P8), whose runtime gets a
  bridge terminal (input events in, frames out), the Chord link (messages relayed by the launcher) and the evaluated
  scripts. The launcher keeps credentials, the real terminal and local preferences, and exposes a small set of actions
  to the sandbox (clipboard, open URL), each confirmed by the launcher's own UI when it touches the machine.
- **Runtime** (inside the sandbox, in the base bundle): a client host like the page's, the same connection loop over
  the bridged link, in-place reloads through a `TuiScripts` object as the web.
- **`TuiScope`** (P9): `new TuiScope(host, changed)` with `hold`, `watch`, `registry`, `dispose`; no pi-tui dependency.

## 5. In the app kit

`startApp` gains `web: { entry, page }` and `tui: { entry }` (optional); with them it creates the surfaces and adds
their facets. Without, an app has no web or TUI surface (an API-only app).

## 6. Tests, examples

- One test file per source file. Web server side: the base bundle (hash, immutable, rebuilt per start), plugin
  scripts and the combined file (registration wrapper, no eval, digests), `WebScripts` updated by a rollout, the page
  route and CSP. Browser side under jsdom or a real browser (the repo's browser smoke setup, if it fits): the loop
  (backoff, wake events, outdated protocol, `canRetry`), loading the combined file, an in-place reload keeping a
  component's state, a base change reloading. React hooks (hold released on unmount, watch re-render, registry).
  TUI: the sandbox cannot read a file or spawn a process (a test plugin that tries), the bridge, an in-place reload,
  `TuiScope` disposal; pairing a TUI client against a kit app.
- Examples: `56-web` (a kit app with a page, two web plugins, an edit applied in place), `57-tui` (a kit app with a
  TUI client, sandboxed).

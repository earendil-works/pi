# surfaces (server side)

The web and terminal surfaces' server side (slice 11 §1, §4; decisions "Slice 11, P3" and "P5"):
`@earendil-works/chord/surfaces`. The app kit (`startServer({ web, tui })`) creates them; by hand:

```ts
const web = await webSurface(server, { plugins, entry: "./src/web/main.ts", page: (request, assets) => shell(request.nonce, assets), paths: ["/"], public: false }, ctx);
const tui = await tuiSurface(server, { plugins, entry: "./src/tui/main.ts" }, ctx);
// web.facet, tui.facet among the server's core facets; web.step("web"), tui.step("tui") after the server's in a rollout
```

- **Base bundles** (`bundle.ts`): built at start by esbuild from the entry (its imports inlined once: the app's API for
  the kind, Chord, React), named by the hash of all its outputs. A page's: an IIFE `base.<hash>.js`, its CSS
  `base.<hash>.css`, assets under `assets/`. A terminal's: one CommonJS script the sandbox evaluates from memory with its own
  `require` (the allowed builtins only). A broken base fails the start. Packages resolve with `conditions` (the
  surface's option), by default the server process's (`processConditions(process.execArgv, NODE_OPTIONS)`: the
  `--conditions`/`-C` flags of both, `NODE_OPTIONS` split as Node splits it, quoted values included); a page's build
  adds `module`, which esbuild's defaults have and custom conditions drop. `inputs` is every file the build read with
  the hash of its bytes as its loader handed them to esbuild (`BaseInputs`): the kit's `base` mark compares with them.
- **Published scripts** (`published.ts`, `current.ts`): the kind's current set (`plugins.scripts(kind)` at start,
  `plugins.current(kind)` at each rollout step) as registered scripts `<prefix>plugin/<name, / as ~>.<digest>.js`, their
  CSS beside them as `<name>.<digest>.<hash of the CSS>.css` (a change of only the CSS keeps the script's digest; each
  script with its inline source map), plugin assets under `<prefix>assets/` (the kit's
  `publicPath`), and the combined file `<prefix>plugins.<hash>.js` (without source maps: a browser reads one per file);
  a plugin whose new build failed keeps its last script, CSS and assets (reported, stays dirty); the files of the last
  four sets stay served. Terminal plugins have no assets (a Node build refuses them). The set goes to a local object (`chord.web.current`, a writable) the scripts object
  derives from; a rollout step publishes without waiting for clients.
- **Files** (`served.ts`): `Cache-Control: private, max-age=31536000, immutable` (the baseline's `no-store` overridden
  for these routes only).
- **A page's load:** the page, two scripts (the combined plugins file, the base bundle) and one stylesheet per plugin
  that has CSS (beside the base bundle's own); the bootstrap (written before the stylesheets) names each plugin's
  stylesheet, so the page knows which `<link>` goes with which plugin's code, and records how each one's load ended (a
  failed load, an HTTP error too, is loaded again by the next update).
- **Web routes** (`web.ts`): `GET /_chord/web/:file`, `plugin/:file`, `assets/:file` (signed in unless `public`), `GET
  /_chord/web/base` (public, `no-store`: an outdated page asks it), the page at `paths` (`page: true`, signed in unless
  `public`). CSP additions: `style-src 'self'`, `img-src 'self' data:`, `font-src 'self'`. Scripts only from `/_chord/web/` (the HTTP component's `scripts`: `script-src` is that path of the request's origin
  and the nonce, so no other same-origin response runs as a script). `PageAssets` (`bootstrap`,
  `script`, `plugins`, `styles`) and `pageScripts(assets, nonce)` for the app's template.
- **Terminal routes** (`tui.ts`): `GET /_chord/tui/start` (`TuiStart`: base hash, script, combined; signed in), `GET
  /_chord/tui/base` (public), the files (signed in).

Examples: `56-web` (a page, two web plugins, an edit applied in place), `57-tui` (a sandboxed terminal client),
`58-themes` (a theme plugin restyling a page and a terminal live), `59-chat` (a chat: one worker per channel, uploads
through the kit's `Files`, a page and a terminal live in one room, pick-a-name login).

Tests: `test/node/surfaces/`.

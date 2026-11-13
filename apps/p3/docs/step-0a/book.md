---
title: p3 step 0a: three reload bugs
cover: Step 0a / Reload Bugs
kicker: A spec · p3 step 0a (Chord) · 2026-11-06
subtitle: Three fixes in Chord so that applying a page plugin keeps it styled (UI contributed by a restarting object aside) and "restart needed" means base code really changed
stats:
  - 3 | bug fixes, all in Chord
  - 0 | decisions: each fix makes the code do what design §21 says
  - 1 RTT | of loading state for a reloaded UI part: accepted (owner)
  - 0 | p3 code: p3 builds on this in step 0b
note: |
  Third version. The first two also proposed sharing references between UI components to avoid a reloaded part's
  loading state; four reviews found it held only for one path and added footguns, and the owner rejected it (decision
  "A reloaded UI part shows its loading state", 2026-11-06). What is left are the three bugs the reviews confirmed,
  with the corrections from the GPT-6 Astra and GPT-6.1 Sol reviews (`/tmp/p3-step0a-astra.md`,
  `/tmp/p3-step0a-sol.md`), each kept as simple as correctness allows.
colophon: p3 step 0a · spec, third edition (bugs only) · 2026-11-06 · sources: src/surfaces/client.ts, src/web/scripts.ts, src/node/surfaces/bundle.ts, src/node/workers/base.ts, src/node/plugins/watcher.ts, design §21, §23
---

# Before we begin {.preface}

An agent edits the `hello` plugin's page code and stylesheet; Mario taps Apply. Hello's part shows its loading state
for one round trip and then the new version: that is accepted (decision "A reloaded UI part shows its loading state").
What is not accepted: for a moment the part is unstyled, because the page removes the old stylesheet before the new one
has loaded. And after someone runs `npm run build` in the checkout, or a formatter rewrites a file without changing it,
the bar says "restart needed" although nothing p3 runs has changed, and says it until a restart.

## Three things to know

:::findings
1. **New stylesheets load before the plugin reloads.** The old ones go after the reload, except those of a plugin
   whose new code failed: it keeps its old script and its old stylesheet together.
2. **Base bundles resolve packages as the server does.** The page's and the terminal's base bundles are built with the
   server's resolution conditions: an app installed from npm (no flags) gets Chord's `dist/` on the server and in the
   page alike; a server started with `--conditions=source` (this monorepo) gets the source in both. Today the page
   always takes `dist/`, whatever the server runs.
3. **"Restart needed" compares content.** Each base build records a SHA-256 hash of the bytes it read per file; the mark is true exactly while a
   file differs from what a running base was built from, checked once when watching starts and again on every event.
:::

# Stylesheets Load First {#css lede="The order of a page's update, and which stylesheet belongs to which code."}

**Today** (`src/surfaces/client.ts`, `#apply`; `src/web/scripts.ts`, `syncStylesheets`): the page fetches the
changed scripts, reloads its host, then replaces the plugins' `<link>`s: the old one removed, the new one appended. Until
the new sheet has downloaded, the plugin's components (old or new) are unstyled. Two more faults: the new sheet is
appended at the end, so the cascade order between plugins changes with every reload; and when a plugin's new script
fails and its old code stays, the client records the new script's digest as loaded, so a later identical set (a
reconnect's snapshot) is taken as applied and the plugin's old code is paired with the new stylesheet.

**Fix**, in `#apply`:

1. For each plugin whose stylesheet differs from the one it has, insert the new `<link>` right after the plugin's
   current one (a plugin new to the page: at its place in the set's order) **inactive** (`media="not all"`: fetched,
   not applied), and wait for its `load` or `error`, at most 10 s, ended early by the client's stop (which removes the
   unadopted links).
2. Reload the host with the new scripts, as today.
3. For each plugin, keep the stylesheet that belongs to the code it now runs: the new one is switched on when its new
   script was adopted; when its script failed and it kept its old code (the reload report's `failed`), the prepared
   sheet is removed without ever applying and the old one stays. Once the page has drawn a frame of the new code, the
   old sheets of adopted plugins and the links of plugins no longer in the set are removed.
4. Record per plugin the digest of the script it actually runs, so a later set with the failed plugin's new script is
   tried again, not skipped as applied.

A stylesheet that fails or stalls is reported (`stylesheet_failed`, `error` or `timeout`) and fetched again by the next
update at the same URL; the plugin's new code is applied anyway (its part may lack its new classes until then); one
that loads after its timeout is applied then. Stylesheet URLs carry a hash of the CSS, so a CSS-only edit is a new
file.

**Limitation (accepted, owner 2026-11-06: "A"):** UI contributed by an object that restarts stays on its old
version until the successor is live (design §21: such an object keeps its contribution until then). Its old sheet is
retired after the drawn frame anyway, so during that restart the old part can show unstyled (a second in the test).
UI contributed directly by a plugin's facet, the rule for p3's UI, is not affected. A kernel signal "this plugin's
restarts finished" would close it (option B, rejected for now).

# Base Bundles Resolve as the Server Does {#conditions lede="Where the page's Chord comes from."}

**Today** (`src/node/surfaces/bundle.ts`, `buildBase`): esbuild bundles the page's and the terminal's base with its
default conditions, so in this monorepo `@earendil-works/chord` resolves to its built `dist/`, while the server,
started with `--conditions=source`, runs Chord's source. The page may then run other Chord code than the server, and
every `npm run build` changes files the base was built from. The worker base already resolves as its process will
(`conditionsOf(execArgv)` in `src/node/workers/base.ts`).

**Fix:** `buildBase` takes `conditions`. The web and terminal surfaces pass the kit's option `conditions` (new on
`AppWeb` and the `tui` option), by default the server process's own: the `--conditions`/`-C` flags of
`process.execArgv` and of `NODE_OPTIONS` (parsed as Node parses it, quoted values included). For browser builds
`module` is added, which esbuild's defaults include and custom conditions drop; the platform stays `browser`. The
helper moves into `bundle.ts`, which the worker base imports; workers keep their own `execArgv` as today.

# "Restart Needed" Compares Content {#base lede="A mark that is true exactly while a running base differs from the files."}

**Today** (`src/node/plugins/watcher.ts`): any file event under base code sets `base`, and nothing clears it. A
formatter rewriting a file unchanged, an editor's swap file, a branch switched and back, an `npm run build`: "restart
needed" until a restart. And an edit made between a base build and the watcher's start is never seen.

**Fix:**

- **Each base artifact records what it read.** The page's, the terminal's and each worker kind's base bundle hash the
  exact bytes their loader hands to esbuild (in the one `onLoad` that returns the contents, the workers' existing
  module-location loader included, never a second reader). The server's own code is recorded by a best-effort scan at
  start: esbuild bundles the start script (`process.argv[1]`) with the server's conditions, writing and running
  nothing, only to record the files of its static import graph (the start script, the API, Chord's server modules);
  an import it cannot resolve is left out, any other failure is reported (`server_scan`) and the server starts. It
  sees literal imports, lazy ones Node may never run included (their edit conservatively asks for a restart), not
  computed `import(x)` or loader-provided modules; installed packages are left out. The app's `base` files are hashed
  at start as well.
- **The mark is computed, not latched.** `base` is true while, for any running artifact, a recorded file's current
  bytes differ or the file is gone, or a base directory has a source file (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`,
  `.mjs`, `.cjs`, `.json`, `.css`) that was not there at start. A file two artifacts read with different bytes stays
  marked as long as either differs. Back to bytes with the recorded hash, the mark clears.
- **Checked when watching starts and on every event.** After the watches are installed, every recorded file and base
  directory is compared once (an edit between the build and the watch is found there). Each event re-reads its path;
  reads of one path are serialized, the latest wins. A base directory removed and recreated is watched again.

Plugin `dirty` marks stay as they are (latched until applied); comparing their content too is carried over.

# Tests and Done {#done lede="What the build delivers."}

- **Stylesheets** (browser): a slow new sheet with a renamed class: the class is styled in the first frame after the
  reload and the old sheet was never missing; cascade order kept across a reload; a plugin whose new script fails keeps
  its old sheet and loses the new one, and a reconnect with the same set tries its script again; a failing sheet is
  reported and the new code applies; a stalled sheet ends the wait at 10 s and at the client's stop.
- **Conditions:** a base built with `conditions: ["source"]` lists source files as inputs, not `dist/`; the default
  reads `process.execArgv` and a quoted `NODE_OPTIONS`; a browser build still takes a package's `module` and `browser`
  entries; the worker base's module locations (`import.meta.url`) still work.
- **The mark:** a rewrite with equal bytes (no mark); a change and its revert (mark, then clear); reads completing in
  reverse order (the latest wins); a swap file (no mark); a new source file (mark), removed (clear); an edit between the
  build and the watch with no later event (found at the start); a directory removed and recreated (watched, compared);
  a file read with different bytes by two artifacts.
- `npm run check`; Chord's suites that touch these (surfaces, web, tui, plugins, workers, reload, the app kit);
  design §21, §23 and the READMEs (kit, surfaces, plugins) updated; carry-over in `slices.md`: content-compared plugin
  marks.

Then step 0b builds p3's base, `hello` and the reload suite on top.

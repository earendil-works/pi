# plus-cli

The pi-plus CLI surface, on top of the shared override core in [`../plus`](../plus).
Direct updates to any other folder under `packages/` are forbidden — upstream packages
stay pristine so they can be synced/updated without merge conflicts.

The published npm artifact is **`pi-plus`** (https://www.npmjs.com/package/pi-plus);
it installs a single global command, **`pipi`** — deliberately not `pi` (pi-plus must
not own pi's command). Library hosts embedding pi in-process use the separate
**`pi-plus-sdk`** package built from [`../plus-api`](../plus-api).

## What this layer adds on top of the shared core

The context-detection/compaction/reasoning overrides and the nine non-TUI extensions
(subagent, tasks, memory, plan, ask-user, hooks, context-guard, /cd, /init) live in
[`../plus`](../plus) and are shared with the SDK. This package adds the CLI-only pieces:

1. **Hub profiles** (`src/coding-agent/main.ts` wrapper, backed by `@earendil-works/pi-hub` = [`../hub`](../hub)) — named pi profiles (provider/models/thinking/token/base URL) stored in `~/.pi/profiles.json`, materialized into isolated agent dirs under `~/.pi/pi-hub/profiles/<name>/`. Adds `pipi profile …`, `pipi use` / `pipi unuse`, and the `pipi --as <name>` flag. The wrapper resolves the profile, sets `PI_CODING_AGENT_DIR` in-process (read lazily by `getAgentDir()`), and delegates to the original `main`.
2. **Shell completion** (`src/completion/`) — `pipi completion <bash|zsh>` prints a completion script covering the whole CLI: hub subcommands (with dynamic profile/model names from `~/.pi/profiles.json`) plus pi's native commands and flags.
3. **Usage print** (`src/coding-agent/cli/args.ts` wrapper) — `pipi --help` gains a "Profile commands (pi-plus)" section.
4. **Welcome banner** (`src/coding-agent/ui/banner.ts`) — pipi's TUI startup header is a CC-style banner with a block-character π+ mark: condensed logo by default, boxed variant with Extensions/Skills feeds, compact/plain degradation on narrow terminals, `resumed <id> · <title>` on resume/fork.
5. **Vim modal editing** (`src/coding-agent/ui/vim/`, core subset ported from [pi-vimmode](https://github.com/pekochan069/pi-vimmode), MIT, (c) 2026 pekochan069) — insert/normal/visual/visual-line modes, motions with counts, `d c y` operators, undo/redo, prompt search. Enable with `"vim": true` in settings or toggle with `/vim`.
6. **Settings selector rows** (`src/coding-agent/ui/settings-selector.ts` wrapper) — `/settings` gains "Auto-compact threshold", "Context floor", and "Context window cap" rows (persisted via the shared core's `context/threshold-setting.ts`).
7. **Tab title + busy spinner** (`src/extensions/tab-title/`) — the terminal window/tab title brands as `pi+ - [sessionName -] cwdBasename` with a braille spinner while the agent or compaction is working. TUI mode only.
8. **Plain tool blocks** (`src/extensions/plain-tools/`) — strips background fills from tool result blocks so tool status reads as text (words, never colored blocks).

The CLI identifies as **`pipi`** (pi-plus) in CLI text via the shared config wrapper's
`APP_NAME` shadow; the terminal tab title brands as **`pi+`** via `APP_TITLE`.

## Running from sources

```bash
./pipi --no-env   # pi (pi-plus) from TypeScript sources with the override layer active
```

`loader/hooks.mjs` is a Node module-customization hook that maps `@earendil-works/*`
to `packages/*/src` and redirects the overridden upstream modules to the wrappers
(shared core redirects in `../plus/loader/redirects.mjs`, CLI redirects in
`loader/redirects.mjs`). Importers inside any `packages/plus*` dir are never
redirected, so wrappers can import the true original via relative path without a loop.

## Compiled artifact (npm)

`build.mjs` bundles `pipi` into `dist/npm/` — a self-contained staging tree that
`npm link` / `npm publish` operate on (this package itself stays private). The bundle
applies the redirect tables at bundle time via the shared plugin in
`../plus/build/redirect-plugin.mjs` and funnels every `packages/*/src` import with a
compiled `dist/` counterpart to that dist file (singleton preservation). `--no-env`
is preserved via a banner scrub.

```bash
npm run build:offline            # at the repo root, first
npm run build                    # in packages/plus-cli
npm publish --access public --ignore-scripts   # in packages/plus-cli/dist/npm
```

The staged package is CLI-only: a `pipi` bin and **no `.` export**, so
`import "pi-plus"` fails by design — library hosts use `pi-plus-sdk`.

Known limitations of the compiled artifact:

- `pipi server` / `pipi client` experimental subcommands (`PI_EXPERIMENTAL=1`) spawn sibling JS
  files that are not emitted next to the bundle; use source-mode `./pipi` for those.
- `docs/` and `examples/` are not shipped, so `/docs`-style paths into them are absent.

## Tests

```bash
npx vitest run   # from packages/plus-cli; unit tests under test/ (faux streamFn, no real APIs)
```

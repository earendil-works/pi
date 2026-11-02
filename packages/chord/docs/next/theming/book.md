---
title: Looks and Themes: how an app shares its styles and components with plugins
cover: Looks / and Themes
kicker: A proposal · Chord v2 · 2026-11-02
subtitle: One app, a notes plugin and a stranger's theme plugin, on a browser page and in a terminal
stats:
  - 1 | registry for themes, shared by web and terminal
  - 0 | copies of the app's components inside plugins
  - 0 | page reloads to switch a theme
note: |
  A proposal by the redesign session, asked for by the owner on 2026-11-02 ("can you write a small explainer about
  what you envision"). It builds on decided rules: the app's versioned API split by host kind, plugins importing only
  that API, registries for what plugins add (decisions of 2026-11-01 in `decisions.md`). Nothing here is built; slice
  11 (web and TUI) and slice 13 (the app kit) are where it would land.
colophon: Looks and Themes · proposal · 2026-11-02
---

# Before we begin {.preface}

Acme's notes app has a look: a sidebar, cards with rounded corners, an orange accent, a dark mode. Its own plugins
draw panels inside that look, and so should a stranger's plugin. Then someone wants a Solarized theme, and writes it as
a plugin. And the same app also runs in a terminal, where there are no CSS files and no React, only text and colours.

Three questions follow. How does a plugin get the app's components and styles without carrying its own copy? How does
it style its own parts so they fit, without stepping on other plugins? And how does a plugin contribute a theme that
the app, every other plugin and both surfaces pick up?

## Five things to know

:::findings
1. **Shared components come from the app's API.** The web module of the app's API (`@acme/app/v3/web`) exports them;
   it is in the base bundle once, and every plugin uses that instance.
2. **Looks are design tokens.** Colours, radii and fonts are CSS custom properties on the page (`--accent`, `--bg`);
   the app's components and every plugin's CSS use them.
3. **A plugin's own CSS is scoped.** CSS modules (`notes.module.css`) keep its class names its own; the build already
   collects and ships each facet's stylesheet.
4. **A theme is data in one registry.** `Themes` lives in the app's shared API module; an entry names colours for
   roles (accent, background, text, ...). The web turns the active one into CSS variables, the terminal into colours.
5. **A plugin contributes a theme like anything else.** It contributes an entry to `Themes`; the picker shows it,
   choosing it restyles the page and the terminal at once, editing the plugin restyles them on its rollout.
:::

## Words used throughout

The **app's API** is the versioned set of modules plugins may import (`@acme/app/v3`, shared by every host kind, and
`@acme/app/v3/web`, `/v3/tui` for one kind). A **host package** is a module the running process provides once to all
plugins. A **design token** is a named value of the look (the accent colour), written as a **CSS custom property**
(`--accent`) on the web. A **role** is what a colour is for (accent, background, error), as opposed to the colour
itself. A **theme** is one set of values for every role. A **registry** is an extension point plugins contribute to.

# Shared Components {#components lede="Why plugins import the app's components instead of bundling their own."}

A plugin's script is built without the app's API: imports of it are left as names and answered by the page at load
time (decision "Plugins import only the app's versioned API"). So when the app exports components from its web module,
every plugin gets the very same functions, from the base bundle the page loaded once:

```ts
// src/api/v3/web.ts (the app)
export { Sheet, Button, List, Toolbar } from "../../web/components.tsx";
export { Panels } from "./panels.web.ts";

// plugins/notes/web.tsx
import { defineFacet } from "@acme/app/v3";
import { Panels, Sheet, Button } from "@acme/app/v3/web";

export default defineFacet((host, self) => {
	self.contribute(Panels, { title: "Notes", Component: () => <Sheet><Button>New note</Button></Sheet> });
});
```

Two things follow. A plugin never ships a copy of the app's components, so a page with twenty plugins loads them once.
And when the app improves a component, every plugin shows the improvement after the app's next restart, without being
rebuilt. Components that change shape incompatibly get a new API version, as any API does.

# Looks as Tokens {#tokens lede="One set of variables that the app's components and every plugin's CSS read."}

The app's stylesheet, part of the base bundle, defines the look as CSS custom properties on the page's root:

```css
:root {
	--accent: #e8590c;
	--bg: #111317;
	--fg: #e8e8e8;
	--muted: #8a8f98;
	--radius: 10px;
	--font: "Inter", system-ui, sans-serif;
}
```

The app's components use only these variables, never fixed colours. A plugin does the same in its own CSS:

```css
/* plugins/notes/notes.module.css */
.card { background: color-mix(in srgb, var(--bg) 92%, var(--fg)); border-radius: var(--radius); }
.title { color: var(--accent); font-family: var(--font); }
```

```tsx
import styles from "./notes.module.css";
<div className={styles.card}><h2 className={styles.title}>Shopping</h2></div>
```

Because everything reads the variables, changing the variables changes everything: the app's components and every
plugin's parts, at once, without reloading anything. That is what makes themes cheap.

## Keeping plugins apart

Two plugins both writing `.card { ... }` would overwrite each other's styles. CSS modules solve that: esbuild gives each
class in a `*.module.css` file a name unique to that file, and the import returns the mapping. The build already
collects each web facet's CSS into one stylesheet, served next to its script and swapped when the plugin reloads, so
nothing new is needed except the convention. Plain CSS files still work; their class names should then start with the
plugin's name.

# The Terminal {#tui lede="The same idea without CSS: components and colour roles from the app."}

A terminal has no stylesheets, but the same split works. The app's terminal module exports its components, built on
whichever terminal UI library the app chose, and a theme lookup by role:

```ts
// plugins/notes/tui.ts
import { defineFacet } from "@acme/app/v3";
import { Panels, Box, theme } from "@acme/app/v3/tui";

const render = (notes) => Box({ title: theme.fg("accent", "Notes"), lines: notes.map((n) => theme.fg("fg", n.text)) });
```

A plugin never writes raw escape codes; it asks for a role (`accent`, `muted`, `error`), and the app's lookup turns
the active theme's colour into what the terminal supports: true colour, or the nearest of 256 colours.

# Themes as a Registry {#themes lede="One extension point, data only, read by both surfaces."}

A theme names a colour for each role. Roles, not surfaces: an accent is an accent on a page and in a terminal. So the
registry lives in the app's **shared** API module, and its entries are plain data, safe to import from any host kind:

```ts
// src/api/v3/index.ts (the app)
export type Theme = {
	id: string;
	name: string;
	mode: "dark" | "light";
	colors: { accent: string; bg: string; fg: string; muted: string; error: string; warning: string; success: string };
	web?: Readonly<Record<string, string>>;   // extra CSS variables: radius, fonts, shadows
	tui?: Readonly<Record<string, string>>;   // terminal-only overrides: a 256-colour fallback for a role
};
export const Themes = defineRegistry<Theme, readonly Theme[]>("acme.themes", { version: 1 });
```

The app contributes its default themes from its own plugins, like any other contribution. Its theme picker lists the
registry's current entries; the choice is a user preference.

:::flow wide animate | A theme from a plugin reaches the page and the terminal through one registry.
row "Plugins" muted
box sol "solarized plugin" "contributes a Theme"
box app "app's theme plugin" "contributes the defaults"
row "Shared API" accent
box reg "Themes registry" "data: roles to colours" accent
row "Surfaces" blue
box web "web page" "active theme → CSS variables on :root" blue
box tui "terminal" "active theme → colours by role" blue
arrow sol -> reg "contribute"
arrow app -> reg "contribute"
arrow reg -> web "watch"
arrow reg -> tui "watch"
:::

**On the web**, the page watches `Themes` and the user's choice; when either changes it writes the active theme's
colours (and its `web` extras) as CSS variables on `:root`. Nothing reloads; the browser repaints.

**In the terminal**, the app's theme lookup reads the same entry; the next redraw uses the new colours.

# A Theme Plugin {#plugin lede="What a stranger writes to add a theme, and what happens when they edit it."}

A theme plugin is the smallest kind of plugin there is: data, contributed. As single-file plugins (decision
"Single-file plugins"), one per surface it wants to be visible on, sharing the data:

```ts
// plugins/solarized.web.ts
import { defineFacet, Themes } from "@acme/app/v3";
import { solarized } from "./solarized-data.ts";   // or inline: single-file plugins import only the API
export default defineFacet((_host, self) => self.contribute(Themes, solarized));
```

Since a single-file plugin may import only the app's API, a theme with two surfaces is either two files with the data
inlined, or a small directory plugin (`plugins/solarized/` with `theme.ts`, `web.ts`, `tui.ts`).

When its author changes a colour, the watcher marks the plugin dirty; the next rollout reloads it on the server and in
every open page and terminal; the registry recomposes; pages that use Solarized repaint. No page reloads, nothing on
screen is lost.

## When the app changes its roles

The app adds a role (`link`) in a later release. Old themes do not name it. The registry's version guards this: the app
bumps `Themes` to version 2 and maps version 1 entries by filling the new role from the default theme. An old theme
keeps working, slightly less complete; nobody's page breaks.

# What a Plugin Cannot Do {#limits lede="Where the app's look ends and a plugin's begins."}

A plugin cannot change the app's base stylesheet or its components: those are base code, changed by the app's
release. It can contribute a theme (the app's looks, re-valued), style its own parts with scoped CSS that reads the
tokens, and place UI through registries like `Panels`. That line keeps a page coherent with twenty plugins from
twenty authors, and keeps one bad plugin from breaking everyone's layout.

# Open Questions {.epilogue lede="What this proposal leaves to decide."}

1. **The roles.** A fixed set the kit defines (accent, background, text, muted, error, warning, success) or each app's
   own. Recommendation: the kit defines a base set and an app may add roles; themes fill the base set at least.
2. **Where `Themes` lives.** In the app kit (every kit app gets it and the CSS-variable writer) or in each app.
   Recommendation: the kit ships it, with the picker's preference and the writer; apps add roles and their defaults.
3. **Light and dark.** A theme carries one mode; following the operating system's preference picks the user's chosen
   dark or light theme. Recommendation: yes, two choices per user (one dark, one light).
4. **Fonts and assets in themes.** Allowed through `web` extras with URLs to the plugin's assets (the build serves
   them), or colours only. Recommendation: allowed, under the page's CSP (`font-src`, `img-src` self).

# Reference {.appendix}

| Piece | Where | What |
| --- | --- | --- |
| shared components (web) | `@acme/app/v3/web` | React components, one instance in the base bundle |
| shared components (terminal) | `@acme/app/v3/tui` | the app's terminal components and `theme` lookup |
| design tokens | the app's base stylesheet | CSS custom properties on `:root` |
| plugin styles | `*.module.css` in the plugin | scoped class names, shipped with the facet's script |
| `Themes` | `@acme/app/v3` (shared) | registry of theme data, read by both surfaces |
| theme plugin | `plugins/<name>.web.ts`, `.tui.ts` or a directory | contributes a `Theme` |

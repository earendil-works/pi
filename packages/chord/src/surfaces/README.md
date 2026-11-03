# surfaces

The client surfaces' portable part (slice 11; design §23 "Web and TUI"; decisions "Slice 11's points", "Slice 11, P3"
to "P9", "Looks and themes"). What a page and a terminal's sandbox run alike, and what the server serves them: exported
from `@earendil-works/chord`.

- **Scripts objects** (`scripts.ts`): `WebScripts` and `TuiScripts`, remote objects on the server (`hostKind("server")()`,
  the kit's server address), params `{}`, served to any principal; their state `set` is the kind's `ScriptSet`: `base`
  (the base bundle's hash), `combined` (the URL of one file with every plugin script), `plugins` (`{ name, digest, url,
  css? }` in name order).
- **Registered scripts** (`registered.ts`): a facet's build served as `chordFacet("<plugin>", "<digest>", function
  (require, module, exports) { … })` (`registeredSource`); `evaluateRegistered(script, modules)` runs the function with
  a `require` answering the client's modules only (an ES module namespace wrapped once for CommonJS: `interop`, shared
  with the Node plugins' evaluation) and checks the default export is a facet.
- **Loaded facets** (`loaded.ts`): a host's loaded plugins and loads and reloads with complete sets, shared by the Node
  plugin runtime and clients: unchanged plugins (same digest) pass as the same facets, removed ones leave, a plugin whose
  script fails keeps its loaded facet (left out at the first load) and is named to the host's closure rule; reloads run
  one after another; an `aborted` reload after its commit adopts the commit.
- **The connection loop** (`connection.ts`, p2's `keepConnected`): reconnects after 250 ms doubling to 5 s (reset by a
  connection open 10 s; the longest while offline), at once on a wake; gives up a socket not open in 20 s; replaces an
  open socket silent past the server's pings (25 s) on a wake, once its next ping is overdue; asks `canRetry` after
  every close; reports `connecting`, `connected`, `waiting`. The environment (clock, timers, online, wakes) is given.
- **A client** (`client.ts`): `startClient` makes a client host (no address), loads the initial scripts with the app's
  core facets, keeps its parent link with the loop (the link's close shared by the loop and the host), and follows the
  scripts object: a new set fetches the changed scripts (`fetchScript`) and reloads the host in place (failures reported,
  kept old); the first frame or a reconnect's snapshot showing what the client runs reloads nothing; a set with another
  `base` calls `outdated`. Before each reconnect it asks the server's base (`serverBase`): another one also calls
  `outdated` (a new link protocol comes with a new base bundle, Chord being in it), and the loop stops.
- **Themes** (`themes.ts`, `theme-choice.ts`, `active-theme.ts`): `Theme` (`{ id, name, mode, colors, web?, tui? }`; the
  base roles `accent`, `bg`, `fg`, `muted`, `error`, `warning`, `success`, apps add roles), the `Themes` registry
  (version 1; a later role is a version bump mapping old entries from the fallback theme), `themesFacet` serving it on a
  host, `FALLBACK_THEMES`, `activeTheme(themes, pick, mode)`, `themeVariables` (`--<role>`, `--<web extra>`),
  `terminalColor` (a role's `tui` override, else its colour, else the fallback's; true colour or the nearest of 256);
  `ThemeChoice` (remote on the server, per principal: `pick` `{ dark, light }` and `choose`) with `themeChoiceFacet`
  keeping every pick in one persisted document by principal key; `followActiveTheme(host, mode, changed, ctx)`.

Tests: `test/surfaces/`.

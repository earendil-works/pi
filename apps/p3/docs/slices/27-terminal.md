# Slice 27: the terminal client scaffold

**Goal.** Plain `p3` on a terminal opens p3's terminal client, connected to the Pi's server, signed in as the owner
on the same machine, showing something real from the server: the active sessions, live. Its code comes from the
server and runs sandboxed, as p2's does: a trusted launcher in the `p3` command, the downloaded code in a child process
that can reach nothing but the launcher. A plugin's terminal code reloads in place while the client runs. It is a
scaffold: small, enough to connect, sign in, show the list and reload. The real terminal UI is slice 16.

**State:** brief, 2026-11-17. Nothing built. Decisions open (below, one section each); work on what depends on each
stops until the owner takes it.

**Order:** after slice 26 (the release build, the `p3` command, its background supervisor; built and committed in
5f89cc0a7), before slice 25 (sign-in with Radius), which builds on it (decision "The basics before iterating",
2026-11-15). The owner's direction for this brief (2026-11-17): p2's terminal isolation was good; keep it.

## What is there today

- **Plain `p3`** (`src/commands.ts`, `start`; BUILT): starts the Pi's server in the background unless it runs, then
  asks the running server for a fresh owner link over a connection on which the server proved who it is
  (`src/ask.ts`, `src/kit/identity.ts`), and prints `p3 on <dir>, port <n>. Open <link>`. Slice 26's brief says the
  terminal client replaces this here.
- **p3's kit** (`src/kit/`) was copied from Chord's kit without the web and terminal surfaces, themes, translations
  and the locale choice (slice 1 carried them to slice 16). `KINDS` (`src/app.ts`) has `server` and `worker`; the API
  has `/v1`, `/v1/server`, `/v1/worker`.
- **Sign-ins** (`src/kit/sign-ins.ts`; BUILT): the authenticator takes `Authorization: Bearer <token>` first, then the
  sign-in cookie. The owner token file (`<dataDir>/owner-token`, mode 0600, `src/kit/owner.ts`) is a device sign-in of
  the owner; every `p3` command uses it, and sends it only after the proof.
- **Reloads** exist only in tests (`test/topology.ts`: `host.reload` with a new facet object). Apply as an object
  (`AppChanges`) is slice 2.
- **Chord** has the whole terminal stack, built in its slice 11 and used by its example `57-tui`:
  `chord/tui/launcher` (`src/node/tui/`), `chord/tui` (`src/tui/`), `chord/surfaces`' `tuiSurface`
  (`src/node/surfaces/tui.ts`). p2 does not use it: p2 has its own launcher and a worker-thread sandbox
  (`apps/p2/src/hosts/tui*.ts`).

## p2's terminal, and Chord's, compared

The owner's "keep p2's isolation" names p2's model: a trusted launcher downloads the terminal code from the server and
runs it sandboxed, holding the credentials, the real terminal and every action on the machine. Chord carried that
model over in slice 11 and changed one thing: **the sandbox is a child process, not a worker thread** (Chord decision
"The terminal's sandbox is a child process", 2026-11-02). The hardened worker thread was escaped twice in one review
round, because downloaded code shares one JavaScript realm with Node's internals (Opus E1: replacing
`Set.prototype.has` opened `require("tty")`; E2: patching `EventEmitter.prototype.emit` caught Node's real `process`).
p2 still runs the worker thread. This slice takes Chord's child process; p2's sandbox is not carried.

| | p2 (`apps/p2/src/hosts/`) | Chord (`packages/chord/src/node/tui/`, `src/tui/`) |
| --- | --- | --- |
| sandbox | a `Worker` with `--permission`, permissions dropped and verified before the bundle runs; V8 limits; RSS watchdog at 512 MiB | a child process of the launcher's Node: pipes only, empty environment, private directory with only the bootstrap, `--permission` granting only that file, `--no-experimental-sqlite`, a 96 MiB heap; inside, a bootstrap that keeps its own references, a `require` of 21 in-memory builtins, a frozen substitute `process` |
| code delivery | one bundle (pi-tui, Chord, runtime, every plugin's `tui.ts`), SHA-256-checked, polled every 1 s, swapped whole with a 1 MiB snapshot | a base bundle (CommonJS, at most 8 MiB) plus the plugins' registered scripts; changed plugins applied in place (`host.reload` in the sandbox) through `TuiScripts`; a new sandbox only for a new base bundle |
| what survives a plugin reload | the snapshot the old worker hands over | page state (`scope.pageState`), untouched by reloads |
| link | the launcher relays opaque chord frames over its own WebSocket with the cookie | the same: the sandbox opens "sockets" the launcher opens to `/chord` with the token, at most four |
| output | `tui-filter.ts`: safe sequences, 64 KiB frames; modes tracked and undone | `filter.ts`: the same rules; a fixed reset of every mode at the end, also when the process exits |
| actions | grants: K (the visitor's own privileged key), C (a launcher-drawn consent screen), N (title, progress); copy, paste image, attach, upload, open URL, download, external editor, suspend, save prefs, dev reload, sign out | `copy`, `open`, `attach`, each confirmed on the launcher's own prompt (bottom lines, black on white), one at a time |
| sign-in | saved owner cookie; on loopback the data directory's owner key; owner link or share link at a prompt; Radius | a token, a token file, or pairing (`/_chord/pair`, Chord's kit) |
| Node | 26.5.1 or later | 26.5.1 or later (`requireSandboxNode`) |
| way out | Ctrl-C handled by pi-tui | three Ctrl-C within a second always end the client (exit 130) |

## p2's terminal features, and what p3 does with each

From `apps/p2/docs/p3-functions/models-prompt-shells.md` ("TUI shell", domain 21), `apps/p2/docs/p2-notes.md` ("TUI",
"TUI through Radius"), `apps/p2/docs/p2-tui-port.md` (sections 3, 4, 10) and `apps/p2/src/hosts/tui*.ts`. p2's
web-shell plugin has no terminal parts.

| p2 feature | p3 |
| --- | --- |
| `npm run tui [url]` starts the client | **27:** plain `p3` on a terminal, for the Pi `--pi`/`--dir` names (decision 2 for a non-terminal) |
| on loopback, sign in as the owner with the data directory's owner key, save nothing | **27:** the owner token file as bearer, sent only to a server that proved itself (decision 3) |
| a saved owner cookie per origin (`~/.pi/p2-tui/config.json`, 0600) | slice 25 (a device sign-in per server; where it lives: decision 8) |
| owner link pasted at a prompt or `--owner-link` | propose to drop for the terminal: a new device pairs (decision "Signing in a new device", 2026-11-16) |
| share link `--join`, a display name, the guest cookie, "access ended" with a notice and a way back | slice 5 (links, persons) with slice 25 (the terminal flow) |
| through Radius (`--radius`: device code, the relay's client channels) | slice 21 (remote access), on the transport of decision 3 |
| remote URLs need HTTPS | slice 25 |
| a bounded bundle (8 MiB) from fixed same-origin paths, no redirects | **27:** Chord's launcher (8 MiB per body; `terminalFile` allows only `/_chord/tui/` files of the server's origin) |
| the bundle's SHA-256 checked against its name | propose to drop: the names are content hashes, but the server that names them also serves them; the sandbox is the defence, not the check |
| the sandbox: permissions dropped, empty environment, V8 limits | **27:** Chord's child process (above) |
| an RSS watchdog (512 MiB) | carried to slice 16, a Chord change: Chord bounds the heap (96 MiB), not memory outside it (a known gap) |
| the output filter (64 KiB frames, safe sequences) | **27:** Chord's |
| terminal modes tracked and undone on exit, crash and swap | **27:** Chord's fixed reset at the end and at the process's exit |
| a crash's sanitized stack printed by the launcher (8 KiB) | slice 16, a Chord change (Chord prints one fixed line); the scaffold shows the last client error on its status line |
| reconnect with backoff; references rebind | **27:** Chord's connection loop (`src/surfaces/connection.ts`) |
| a new bundle polled every 1 s (10 s through Radius) | replaced by `TuiScripts` (Chord decision "Slice 11, P5"): no poll |
| the whole bundle swapped, a 1 MiB snapshot carried over | replaced: plugins apply in place and keep page state; a base change starts a new sandbox and loses what is on screen (design §21's table). Propose to drop the snapshot |
| copy (consent with the full text), copy by key, copy on select (mouse gesture) | copy with consent: Chord's `copy` (**27** has it, the scaffold does not use it); by key and on select: slice 16 (privileged keys, a Chord change) |
| open URL (https, or fixed-origin paths) | Chord's `open` (http and https, the host shown first); the fixed-origin paths: slice 16 |
| attach a local file, upload, paste an image | Chord's `attach` (reads a confirmed file for the sandbox); the upload goes over the link: slice 12; paste image: slice 16 |
| download into `~/Downloads/p2` | slice 12 (files) with slice 16 |
| external editor (Ctrl+G), suspend (Ctrl+Z) | slice 16, Chord changes (the launcher lends the terminal) |
| window title, progress, program status | slice 16, a Chord change (the filter drops OSC) |
| visitor preferences: pi's keybindings, settings and themes read from `~/.pi/agent`, p2's `prefs.json`, watched; server defaults (`tui.json`) | slice 16 |
| the terminal's colours queried (OSC 10/11/4, mode 2031); `--theme`, `--no-themes` | slice 16 (Chord takes `mode` and `colors` today; `COLORTERM` picks the depth) |
| mouse policy (on, all, off) | slice 16 |
| commands: pi ids, contexts, rebinding, F1, `/hotkeys`, `/settings`, `/keybindings`, `/quit`, `/reload`, toggles | slice 16; **27** has `q` and Ctrl-C to quit |
| the fullscreen layout copied from coding-agent (transcript, dock, editor, footer), tool cards, renderer registries | slice 16 (the transcript: slice 3) |
| reading position and drafts per (session, conversation) | slice 16, on page state (built in Chord) |
| dev reload and restart from the terminal | slice 2 (`AppChanges` over the link, no launcher action) |
| sign out (this device, all owner devices) | slice 25 |
| shell terminals in the client (a filtered byte channel) | slice 19 |
| Node 26.5.1 or later | decision 1 |

## Precedents

- **p2** (`apps/p2/src/hosts/tui.ts`, `tui-client.ts`, `tui-config.ts`, `tui-sandbox.ts`, `tui-transport.ts`,
  `tui-radius.ts`): one launcher process that signs in, then loops: start the client, wait for its end, sign in again
  when access ended. Its requests go through a **transport** (`TuiTransport`: the cookie transport or the Radius one),
  which is how one launcher reaches a server directly and through Radius.
- **Chord** (`packages/chord/src/node/tui/launcher.ts`, `sandbox.ts`, `pipe.ts`, `filter.ts`, `actions.ts`,
  `credentials.ts`; `src/tui/runtime.ts`, `scope.ts`, `terminal.ts`, `theme.ts`, `channel.ts`, `bridge.ts`;
  `src/node/surfaces/tui.ts`; Chord's kit `src/node/app/app.ts`, `surfacesOf`, which gives `startServer({ tui })` its
  surface): the server builds the terminal kind's base bundle from the app's terminal entry right after the listen,
  publishes the `tui` kind's plugin scripts, and serves `GET /_chord/tui/start` (signed in), `GET /_chord/tui/base`
  (public) and the files. Example `57-tui` with `56-web/tui/main.ts` is the whole pattern in 40 lines.
- **coding-agent** (`packages/coding-agent/src/main.ts`, `resolveAppMode`): interactive only when stdin and stdout
  are both terminals, else print mode. Its interactive mode is slice 16's model for the screens, not this slice's.
- **pi-tui** (`packages/tui`): pi's terminal UI library. p2 bundles it into the sandbox, with its native clipboard and
  platform helpers replaced at bundle time (`apps/p2/src/hosts/bundles.ts`, `tui-no-native-local-access`); it imports
  `fs`, `os`, `child_process` and `perf_hooks`, none of which the sandbox's `require` gives (decision 7).

**Measured** (2026-11-17, slayer, Node 26.11.1, Chord's board example `56-web` with an in-process launcher on pipes,
three runs, the server warm): the launcher's start to the first frame 62 to 83 ms; the sandbox's USS 17.3 to 17.7 MiB
(RSS 59 MiB, most of it Node's binary shared with the launcher); the base bundle 489 KB minified, the combined plugins
file 732 bytes.

## How it works (PROPOSED)

### Plain `p3`

```text
p3 [--pi <name> | --dir <path>]
  stdin and stdout are terminals, Node can sandbox (decision 1)?
    no:  as today: start unless running, print the port and a fresh owner link (decision 2)
    yes: start unless running (slice 26's start, unchanged up to the server's record)
         the launcher, in this process: startTerminal with a transport that proves the server on every
         connection (decision 3), the terminal's mode and colours, the system's locales
         the screen until `q`, Ctrl-C, or three Ctrl-C within a second
         exit code: the client's (0, or 130 for the three Ctrl-C); the server keeps running in the background
```

The `p3` process is the launcher: trusted, it reads the owner token file and holds the real terminal. Nothing the
server sends runs in it. Quitting the client leaves the background server running, as slice 26 decided for plain `p3`.

### The server

- `startServer` (`src/kit/start-server.ts`) creates Chord's terminal surface: `tuiSurface(host, { kind: "terminal",
  plugins, entry: TERMINAL.entry })` (`src/install.ts` names the entry in both layouts), puts its facet among the core
  facets (`p3.terminal`), and builds its base right after the listen, beside the workers' base (decision 5: eager or
  on the first request). A base that fails to build is reported `base_build` and makes the surface's routes answer
  503; the server runs on.
- `KINDS` gains `terminal: { platform: "node" }` (decision 6), so the plugins component builds each plugin's
  `terminal.ts` with `@earendil-works/p3/v1` and `/v1/terminal` as host packages; the surface publishes them as
  registered scripts and one combined file.
- The server serves no `ThemeChoice` and no `LocaleChoice` yet (cut with the kit, slice 16): the client's theme is the
  fallback of its mode and its language the first catalog offered for the system's locales (English). Chord's
  followers wait on the unserved holds without failing anything.

### The terminal entry: `terminal.ts`

The sandbox's base bundle, base code at p3's root beside `bin.ts`, `server.ts`, `worker.ts` and `supervisor.ts`
(decision "Base entries are named after what they are"). It calls Chord's `startTerminalRuntime` with p3's terminal
modules, a core facet that serves the registry of terminal views, and a frame that draws:

```text
 p3 · <pi id> · connected                                       one header line (the connection state, live)
 <the view's lines>                                             the first registered view, the rest of the height
 q quit · ↑↓ select · n new · last error, if any                one status line
```

The frame owns the keys `q` and Ctrl-C (exit 0), passes the rest to the view, redraws on `changed` (one scope per
view), on resizes and on theme changes. Every text is a message (`defineMessages`, decision "Locks": user-visible
text is `MessageData` rendered per viewer).

### The sessions view: `plugins/sessions/terminal.ts`

The sessions plugin's terminal facet contributes one view: the coding app's active sessions.

- It holds `SessionsList` with `{ app: CODING, set: "active", view }`, `view` a random id kept in page state, so a
  reload of the view's plugin rebinds the same list object (its bookmarks are kept by the server's object, decision
  "Reload" of `chord-practices.md`).
- A row: the title (or the message "New session"), the state, the last touch. `↑`/`↓` move the selection (kept in
  page state); moving past the last loaded row while `moreAfter` calls `more` once until rows arrive.
- `n` calls `Sessions.create({})`; the new row enters the list's first page by itself (`chord-practices.md`, "Lists").
- Renames, archives and new sessions made elsewhere (the web page later, a test's owner client now) show live.

### Reload in place

- **A terminal plugin's change:** the server rebuilds the plugin and publishes the new set (the surface's rollout step,
  after the server's); the sandbox's `TuiScripts` hold gets one frame, fetches the changed script through the
  launcher, and applies it with `host.reload`. The view remounts, its page state (list id, selection) survives, the
  server's list object is untouched, the other plugins and the frame stay. In this slice an Apply is a kit call for
  tests (decision 10); the owner's control is slice 2.
- **A server restart** (`p3 restart`, a crash under the supervisor): the link drops, the connection loop reconnects
  (250 ms doubling to 5 s), the transport proves the new server first (decision 3). The base bundle is built again at
  the start; it has the same content hash when its code did not change, so the sandbox stays and the plugins' current
  set arrives with the `TuiScripts` snapshot. A new hash makes the sandbox say `outdated`, and the launcher starts a
  new one with the new base (what was on screen is lost: design §21's table, "base code").

### What runs where

```text
the p3 command (launcher, trusted)          the sandbox (child process, untrusted code)       the server
  owner token file ─ bearer ──────────────────────────────────────────────────────────────→ /_chord/tui/start, files
  terminal (raw mode) ── input, resizes ──→ bridge ──→ the frame, the views
  output filter ←──────────── frames ────── bridge
  WebSocket /chord (bearer) ←── socket bytes ── RelayLink (Chord link) ────────────────────→ SessionsList, Sessions
  copy/open/attach prompt ←──── requests ──── bridge
```

## Files (PROPOSED)

```text
apps/p3/
  terminal.ts                      the terminal entry (the sandbox's base bundle): startTerminalRuntime, the core facet
                                   serving TerminalViews, the frame
  src/terminal.ts                  plain p3's terminal: whether it runs (a terminal, Node), the transport, startTerminal
  src/api/v1/terminal.ts           @earendil-works/p3/v1/terminal: what terminal facets import
  src/commands.ts                  start: the server's record returned to its caller, the link printed by the caller
  bin.ts                           plain p3: the terminal or the link; the help text
  src/install.ts                   + TERMINAL: the terminal entry, source or dist/terminal.js
  src/app.ts                       + KINDS.terminal
  src/kit/start-server.ts          + the terminal surface: its facet, its build after the listen
  src/kit/app.ts                   + the surface's base hash; + applyChanges if decision 10 says so
  scripts/build-release.ts         + dist/terminal.js, its lean check
  package.json                     + exports ./v1/terminal (source, types, import)
  tsconfig.build.json              + src/api/v1/terminal.ts
  plugins/sessions/terminal.ts     the sessions view
  plugins/sessions/messages.ts     the plugin's texts (the view's; later the web's)
  test/terminal.test.ts            topology and end-to-end cases (below)
  plugins/sessions/terminal.test.ts  the view alone
  test/release/release.test.ts     + the release cases
  bench/slice-27.ts                the numbers
packages/chord/src/node/tui/launcher.ts   + transport (decision 3; a Chord change)
```

## Contracts and objects

**Real, used as they are:**

- `startTerminal(options)` (`packages/chord/src/node/tui/launcher.ts`): `url`, `credentials` (`token`, `file`,
  `pairing`), `input`, `output`, `colors`, `mode`, `locales`, `opener`; returns `{ exited, stop }`; rejects below Node
  26.5.1 (`requireSandboxNode`, `sandbox.ts`).
- `startTerminalRuntime(options)` (`packages/chord/src/tui/runtime.ts`): `modules`, `core`, `canRetry`,
  `onConnection`, `render`, `onError`; the runtime gives `host`, `terminal` (`BridgeTerminal`: `columns`, `rows`,
  `write`, `onInput`, `onResize`), `theme` (`TerminalTheme`: `fg`, `bg`, `onChange`), `copy`, `open`, `attach`, `exit`.
- `TuiScope` (`packages/chord/src/tui/scope.ts`): `hold`, `watch`, `registry`, `variant`, `on`, `pageState`,
  `messages`, `optimistic`, `dispose`.
- `tuiSurface(server, { kind, plugins, entry, conditions?, tsconfig? })` (`packages/chord/src/node/surfaces/tui.ts`):
  `facet`, `step(name)`, `build()`, `built`; `TuiStart`; `TUI_PREFIX` `/_chord/tui/`.
- `TuiScripts` (`packages/chord/src/surfaces/scripts.ts`), `defineRegistry` (`src/registries/registry.ts`),
  `defineMessages` (`src/surfaces/messages.ts`), all through `@earendil-works/p3/v1`'s re-export of Chord's root.
- `SessionsList`, `Sessions`, `SessionRow`, `CODING` (`plugins/sessions/contract.ts`), owner variant only.
- `ask`, `proven` (`src/ask.ts`), `holder` (`src/kit/running.ts`), `IDENTITY_PATH` (`src/kit/identity.ts`).

**PROPOSED:**

```ts
// src/api/v1/terminal.ts: @earendil-works/p3/v1/terminal
export { TuiScope, type BridgeTerminal, type TerminalTheme } from "@earendil-works/chord/tui";

/** A view of the terminal client: what one plugin shows in the frame's body. */
export type TerminalView = {
	readonly id: string;
	readonly title: MessageData;
	/** Mounts the view; `changed` redraws the frame. */
	mount(context: TerminalViewContext): MountedTerminalView;
};
export type TerminalViewContext = {
	readonly host: Host<P3Principal>;
	readonly theme: TerminalTheme;
	readonly changed: () => void;
};
export type MountedTerminalView = {
	/** The view's lines for `columns` × `rows` (each at most `columns` wide). */
	render(columns: number, rows: number): readonly string[];
	/** A key or paste; whether the view took it. */
	input(data: string): boolean;
	dispose(): void;
};

/** The terminal views, in plugin-name order; served by the terminal entry's core facet. */
export const TerminalViews = defineRegistry<TerminalView, readonly TerminalView[]>("p3.terminal.views", { version: 1 });
```

The registry is the scaffold's one seat for plugins: a third-party plugin adds a view the same way the sessions plugin
does. The name follows the decision on `terminal` (decision 6); `ViewKinds` on the web and slice 16's layouts may
replace it (names still to choose, `names.md`).

```ts
// packages/chord/src/node/tui/launcher.ts: a Chord change (decision 3)
export type TerminalTransport = {
	/** GET `path` of the server with the launcher's credentials; at most `limit` bytes. */
	get(path: string, limit: number, signal: AbortSignal): Promise<{ readonly status: number; readonly body: string }>;
	/** A WebSocket to `path` (`/chord`) with the launcher's credentials. */
	socket(path: string): WebSocket;
};
// TerminalOptions gains `transport?: TerminalTransport`; without it, today's: fetch and `ws` to `url` with a bearer.
```

p3's transport (`src/terminal.ts`) reads the server's record before each new connection (`holder`), opens one TCP
connection, has the server prove itself on it (`GET /_p3/identity`), then sends the request, or the WebSocket upgrade,
with the bearer on that same connection; a server that does not prove itself gets nothing, and the attempt fails (the
connection loop tries again). `ask.ts`'s `Connection` with a cap per request instead of its fixed 64 KiB (the base
bundle is about 0.5 MB).

## Tests, case by case (PROPOSED)

The terminal's end-to-end cases need Node 26.5.1 or later (decision 1). Under an older Node they are skipped with the
reason printed, and run under the Node `P3_TERMINAL_NODE` names (slayer: `~/.local/bin/node26`), as Chord's terminal
tests do (`CHORD_TUI_NODE`).

**Plugin tier** (`plugins/sessions/terminal.test.ts`; `testPlugin` with `kind: "terminal"`, `SessionsList` and
`Sessions` served by stubs):

1. The facet contributes one view to `TerminalViews`; mounted, it renders a stub's rows (title, "New session" for an
   empty one, state, last touch) within the given width.
2. `↓` past the last row while `moreAfter` calls `more` once, not again until rows arrive; without `moreAfter` never.
3. `n` calls `create({})` once.
4. The view's list id and selection come from page state: a second mount on the same host binds the same list
   params and keeps the selection.

**Topology tier** (`test/terminal.test.ts`; `test/topology.ts`'s server, a client host linked in memory that loads
`terminal.ts`'s core facet and the sessions plugin's terminal facet, no sandbox):

5. The view shows the active sessions of an owner who made three; one renamed on the server shows the new title,
   one archived leaves the list.
6. 120 sessions: the view shows the first page; moving down loads the rest with `more`, no duplicate, no gap.
7. Reload of the sessions plugin's terminal facet while the list is open: the view remounts, the same list object
   (no new hold on the server), the selection kept, no error.
8. Reload of the sessions plugin's server facet under the open view: the rows come back, the view shows no error
   (`chord-practices.md`, "Reload").
9. A person's principal gets no `SessionsList` (forbidden), and the view says so instead of failing the frame.

**End to end** (`test/terminal.test.ts`; `startP3` in process, the real launcher with pipes of the test's own for
input and output, the real sandbox):

10. The first screen: the header names the Pi, the sessions made before show; created while it runs (by an owner
    client over WebSocket) shows live.
11. `n` on the terminal creates a session: the owner client's list has it.
12. `q` ends the client with 0; the output ends with Chord's reset of the terminal's modes; the server runs on.
13. A terminal plugin edited on disk and applied (decision 10): the screen shows the new code, the selection kept, the
    same sandbox (its pid), no new base.
14. A server restart with the same code: the client reconnects and shows the list again, the same sandbox; a restart
    with a changed `terminal.ts`: a new sandbox with the new base.
15. **The token after a stop** (the reproduction of slice 26's round 4 for the launcher): the server stops, a program
    of the test's own takes its port and answers the identity route with the old run id and a wrong proof; the
    launcher's reconnects never send it the token (the program records every header it gets), and once the real
    server is back the client reconnects to it.
16. A server that answers the proof and then swaps the port (as slice 26's case): the token never reaches the program.
17. The sandbox's own checks stay Chord's (`packages/chord/test/node/tui/`); one p3 case: a terminal plugin that tries
    `require("node:fs")`, `fetch` and `process.env` gets refusals and empty values, and the launcher keeps running.

**Command cases** (launched, `test/launched.ts`; a pseudo-terminal from `script -qfec` on Linux, or tmux as
`.pi/skills/interactive-testing.md` does):

18. Plain `p3` on a terminal: the screen shows the sessions; `q` exits 0; `p3 status` says running.
19. Plain `p3` with stdout piped (every existing case of slice 26): the link is printed as today.
20. Plain `p3` on a terminal under a Node the sandbox refuses: what decision 1 says (with `test/old-node.ts`'s
    preload).
21. Three Ctrl-C within a second end the client with 130, the terminal reset.

**Release tests** (`test/release/release.test.ts`, run by `release:p3:local`):

22. The install has `dist/terminal.js` and no TypeScript is loaded for the terminal; the server builds the terminal's
    base from it at start.
23. Cases 10, 12 and 18 from the install.
24. The lean check of `dist/terminal.js`: none of the server's code, no esbuild, no `ws`, no Node HTTP (as
    `checkLean` for the worker).

**Mutation check** (`chord-practices.md`, in a copy under `/tmp` with its own package links): the terminal check of
plain `p3` (both ways), the Node check, the proof before the bearer on each connection (in the transport's `get` and
its `socket`), the record read again before a reconnect, the `terminal` kind's host packages, the view's page-state
keys (list id, selection), `more` called once, the frame's `q`, the surface's facet among the core facets, its build
after the listen, its rollout step after the server's, `dist/terminal.js` in the release and its lean check.

## Numbers to meet (PROPOSED; `bench/slice-27.ts`, on slayer and the phone, source and release)

| | Target | Precedent |
| --- | --- | --- |
| plain `p3` to the sessions list drawn, the server running, warm | release ≤ 250 ms, source ≤ 400 ms | `p3` for a fresh link: 90 / 161 ms (slice 26); Chord's launcher to the first frame: 62–83 ms |
| plain `p3` to the list, the server not running, cold and warm | release ≤ 600 ms warm; cold reported | background start to the link: 252 / 398 ms (slice 26) |
| the terminal base built at a start (the server's work after the listen) | reported; it adds to every start (decision "No build cache") | the workers' base: 88–125 ms |
| the sandbox's USS, idle with the list open | ≤ 25 MiB | Chord's board: 17.3–17.7 MiB |
| the launcher process's USS (the `p3` command while the client runs) | reported; decision 11 | the supervisor: 10.9 MiB; the server: 34 MiB |
| bytes on the wire to open the list (50 rows: the hold, its first frame) | ≤ 16 KiB, both ways | |
| bytes for one rename in an open list of 50 | ≤ 1 KiB | |
| the base bundle and the combined plugins file | reported (downloaded at every launcher start) | Chord's board: 489 KB, 732 B |

Medians of 20 or more runs, the cold run apart; launch numbers on a pseudo-terminal.

## Decisions (open; the owner takes each)

### 1. The Node the sandbox needs

**Problem.** p3 runs on Node 24.4.0 or later (`src/minimum-node.ts`). Chord's launcher refuses Node below 26.5.1,
because Node 24's permission model does not restrict the network: checked on slayer (2026-11-17), a script run with
`--permission` and nothing granted connects to `127.0.0.1:22` under Node 24.4.1 and is refused (`ERR_ACCESS_DENIED`,
"Use --allow-net") under Node 26.11.1. A sandbox on Node 24 could send what it shows anywhere, or reach any service on
the machine. So a user on Node 24 types `p3` and gets no terminal.

**Options.**
- **A.** The terminal needs Node 26.5.1: below it, plain `p3` prints the link as today and one line, `the terminal
  client needs Node 26.5.1 or later (this is Node 24.4.1)`. Everything else runs on Node 24.
- **B.** Raise p3's minimum to Node 26.5.1. By Node's usual schedule 26 became LTS in October 2026 (to be checked).
  The memory budget and every test already run on Node 26.11.1 (slice 26).
- **C.** Run the sandbox on Node 24 without the network restriction. Breaks the isolation the owner asked to keep.

**Recommendation:** A now, B as its own decision once Node 26's LTS status is confirmed: A costs nothing, B removes
the special case and the test switch.

### 2. Plain `p3` when it is not on a terminal

**Problem.** `p3 > log.txt`, `p3 | cat`, a script or a test runs plain `p3` without a terminal. A terminal client
there would draw escape sequences into a file. And with the terminal in place of the link, the owner needs another
way to open the browser.

**Options.**
- **A.** As coding-agent's `resolveAppMode`: the terminal only when stdin and stdout are both terminals; otherwise
  print the port and a fresh owner link, as today. Every slice 26 case stays as it is.
- **B.** A, and a command `p3 link` that always prints a fresh owner link (also on a terminal).
- **C.** Always the terminal, refusing without one.

**Recommendation:** B. A keeps scripts and tests working; `p3 link` is the browser's way in once plain `p3` opens the
terminal (the terminal's own "open in browser" needs a link the sandbox cannot get and is slice 16's).

### 3. How the terminal signs in on this machine, and where the token goes

**Problem.** The launcher needs the owner's credentials: the owner token file, as every command uses it. Chord's
launcher sends that bearer on every connection it opens: the start, the base bundle, the plugin files, and every
WebSocket of the connection loop, also each reconnect after the server went away. Example: the owner quits nothing,
runs `p3 stop` in another shell, and the launcher retries `127.0.0.1:8789` every 5 s; another user's program takes
the port and receives `Authorization: Bearer <owner token>`: the owner's access, for as long as the token file lives.
Slice 26's round 4 closed exactly this for the commands (`src/ask.ts`: the proof and the request on one connection).

**Options.**
- **A.** A Chord change: `startTerminal` takes a transport (`TerminalTransport` above, p2's `TuiTransport` in Chord's
  terms); p3's proves the server on each connection before it sends the bearer on it. The same seam carries slice
  21's Radius transport and slice 25's remote servers.
- **B.** A short-lived sign-in per launcher run: asked over a proven connection (`POST /_p3/terminal/sign-in`, label
  `terminal`), used as Chord's `token`, revoked at the client's end. A squatter still gets a working owner token while
  the run lasts.
- **C.** Chord's launcher as it is, with the owner token file. Accepts the exposure above.

**Recommendation:** A. It is the only option where nothing but the proven server ever sees a token, it matches what
the commands guarantee, and the seam is needed anyway for Radius. Chord change: the option, its test, README and
CHANGELOG lines; without a transport the launcher works as today.

**Later, from another machine (slice 25, recorded here, nothing built in 27).** The decided flow: the new device shows
a code, a signed-in device approves it (`p3 pair <code>`, the local page, the terminal client), the waiting device
gets its own sign-in (decision "Signing in a new device", 2026-11-16). Chord's `pairing` credentials post to Chord's
kit routes (`/_chord/pair`) and print an approval URL; p3's kit has no pairing. Recommendation for slice 25: p3's own
pairing routes and flow in the launcher, before `startTerminal`, and the resulting device token used through the same
transport.

### 4. What the terminal shows in this slice

**Problem.** "Something real" can be read narrowly (a read-only list) or widely (the session's transcript). The wider,
the more of slice 16 leaks in.

**Options.**
- **A.** The active sessions, live, with `more`, selection, and `n` to create one (above).
- **B.** A, plus rename and archive from the terminal.
- **C.** A read-only list.

**Recommendation:** A: it exercises a live list, `more`, a call, page state and the reload; rename and archive add
text input, which belongs with pi-tui's editor (slice 16).

### 5. Where the terminal base bundle and the plugins' terminal facets come from in the release

**Problem.** The release ships base code bundled and plugins as source (slice 26). The terminal's base bundle is built
by Chord's surface from an entry with esbuild; the release has no TypeScript of `terminal.ts` to build from. Decision
"No build cache" says nothing built is kept between starts, and Chord's decision "Slice 11, P3" rejected a prebuilt
base shipped with the app ("could disagree with the plugins' build").

**Options.**
- **A.** As the worker: the release bundles `terminal.ts` into `dist/terminal.js` (Chord and the API inlined, its own
  lean check), and at every start Chord's surface bundles that file again into the sandbox's CommonJS base (minified).
  The plugins' terminal facets are built at start from source, like their server facets.
- **B.** The release ships the final base bundle and the surface serves it as is (a Chord change: a ready base). Saves
  the start's build; Chord rejected it in P3.
- **C.** Ship `terminal.ts` and what it imports as TypeScript and build at start from source.

**And when:** eager (right after the listen, as Chord's kit and the workers' base: plain `p3` asks for it at once) or
on the first launcher's start (Chord's surface builds then if nothing did; a `p3 server` nobody connects to never
pays).

**Recommendation:** A, eager. It is the worker's pattern, keeps "No build cache" and P3, and plain `p3` needs the base
immediately. The build's cost is in the numbers; with many terminal plugins it joins the build-cache question.

### 6. The API's terminal module and the facet kind's name

**Problem.** Terminal facets need a kind (the file a plugin has: `terminal.ts`) and an API module to import. Chord's
kit and p2 call it `tui` (`tui.ts`, `/v3/tui`); p3's names are plain words (`names.md`). Slice 19 has a `terminals`
plugin (shell PTYs) whose pane would be "a terminal" too: `plugins/terminals/terminal.ts` would be the terminals
plugin's terminal facet.

**Options.**
- **A.** Kind `terminal`, module `@earendil-works/p3/v1/terminal`, file `terminal.ts`; slice 19's plugin keeps
  `terminals` and its things are "shells" or "PTYs" in prose.
- **B.** Kind `tui`, module `/v1/tui`, file `tui.ts`, as Chord and p2.
- **C.** Kind `terminal`, and slice 19's plugin renamed (`shells`).

**Recommendation:** A, and `names.md` gains "terminal: the terminal client and its facet kind; not a shell (PTY)". The
API module exists from this slice, as the decision "The basics before iterating" puts the terminal client first.

### 7. pi-tui in the sandbox now, or Chord's scope only

**Problem.** Slice 16's terminal UI is pi's (p2 copied coding-agent's components onto pi-tui). pi-tui imports `fs`,
`os`, `child_process` and `perf_hooks`; the sandbox's `require` refuses them, so pi-tui needs stubs at bundle time (as
p2's `tui-no-native-local-access` plugin) or changes of its own.

**Options.**
- **A.** Chord's `TuiScope` and a few hand-drawn lines now (as Chord's board example); pi-tui with slice 16, with what
  it needs then (a build hook in Chord's surface, or pi-tui changes).
- **B.** pi-tui now: the frame and the list as pi-tui components, the stubs built now.

**Recommendation:** A: the scaffold stays small, and slice 16 decides how pi-tui runs in the sandbox with the
components it brings. The `TerminalViews` registry is shaped so a pi-tui component can stand behind `render` and
`input`.

### 8. What the launcher keeps on disk

**Problem.** p2's launcher keeps `~/.pi/p2-tui/config.json` (cookies per origin) and `prefs.json`. In this slice the
launcher needs nothing of its own: the owner token file is the Pi's (`<dataDir>/owner-token`), and Chord's sandbox
writes its bootstrap into a private temporary directory (0700) that it removes once read. Slice 25's paired servers
and slice 16's preferences need a place.

**Options.**
- **A.** Nothing on disk in slice 27; slice 25 and 16 decide.
- **B.** Decide the place now: `~/.pi/p3-terminal/` (0700; a token per server origin, 0600; later `prefs.json`), as
  p2's `~/.pi/p2-tui/`, outside every Pi's data directory (`~/.pi/p3` is the default Pi's).
- **C.** Inside `~/.pi/p3/terminal/`: one tree for p3, but mixed into the default Pi's data directory.

**Recommendation:** A, with B as the direction for slice 25: the client's data is the device's, not a Pi's, and a
second Pi's terminal must not read the default Pi's directory.

### 9. Windows

**Problem.** Windows is a target (decision "Windows is a target", 2026-11-16); nothing has run there (slice 26). Chord's
launcher has Windows branches (no `SIGUSR1`, `windowsHide`, `rundll32` for URLs, Windows path checks in `attach`), and
Node's permission model works on Windows, but: an empty environment may lack variables Node needs there
(`SystemRoot`), raw mode and VT output depend on the console, the pseudo-terminal for tests does not exist, and the
sandbox may still terminate the user's processes (`process.kill` is `TerminateProcess` there; the same known gap as
signals on POSIX).

**Options.**
- **A.** Build and test on Linux; the Windows-specific lines are reviewed, not run, and carried with slice 26's
  Windows list (a Windows machine runs the suite later).
- **B.** Get a Windows machine (or CI runner) now and run the terminal cases there before reporting.

**Recommendation:** A, adding to the carried list: the sandbox's environment on Windows (which variables Node needs,
copied as `LD_LIBRARY_PATH` is), the console's raw mode and VT, and the tests' terminal there.

### 10. Applying a terminal plugin before slice 2

**Problem.** "Reload its own plugin code in place" needs a rollout: build the changed plugins, reload the server, then
publish the terminal's new set. p3's kit has no Apply (slice 2); its reload tests call `host.reload` by hand. A
terminal plugin's reload needs the plugins component's build and the surface's rollout step, which the kit owns.

**Options.**
- **A.** `RunningApp.applyChanges(context)` in the kit now, as Chord's kit has it (build, then the server, the running
  workers and the terminal surface in that order), used only by tests; slice 2 serves it as `AppChanges`.
- **B.** The tests reach into the kit's parts (the plugins component, the surface's step) and drive the rollout
  themselves.
- **C.** Prove the terminal's reload only in the topology tier (`host.reload` on the in-memory client) and leave the
  real rollout to slice 2.

**Recommendation:** A: small, the same code slice 2 will serve, and the end-to-end case then tests the real path.

### 11. The launcher's own process

**Problem.** The `p3` command process becomes the launcher and stays alive while the client runs. It loads
`dist/main.js`, which holds the server: the kit, Chord's HTTP, workers and plugin components, esbuild's JS API. Slice
26 gave the worker and the supervisor bundles of their own for that reason (5 MiB per worker).

**Options.**
- **A.** Measure first (the launcher's USS while the client runs); act only if it is large.
- **B.** A bundle of its own for the launcher now (`dist/launcher.js`: the command's client side, Chord's launcher,
  `ws`), chosen by `dist/p3.js`, as slice 26's lean bundles.

**Recommendation:** A, with B as the fix if the launcher's USS is more than about 10 MiB above the supervisor's.

### 12. The p2 features proposed for dropping

From the feature table: the owner link pasted into the terminal (pairing replaces it), the bundle's SHA-256 check
against its name, the 1 s bundle poll (replaced by `TuiScripts`), and the whole-bundle swap with its 1 MiB snapshot
(replaced by in-place plugin reloads and page state; a base change loses the screen). **Recommendation:** drop all
four.

## Read first, in full

1. `apps/p3/docs/chord-practices.md`, `names.md`, `decisions.md`, `workflow.md`.
2. This brief; `slices/26-release.md` ("As built", the commands, review round 4: the token on one connection);
   `slices/25-radius-sign-in.md` ("Decided since"); `slices/16-ui.md`.
3. `packages/chord/docs/design.md` in full; §21 ("UI on client hosts", "What a user sees during a reload") and §23
   ("The app kit", "Web and TUI", "Messages and languages") matter most.
4. `packages/chord/docs/decisions.md`: "Slice 11's points", "Slice 11, P3" to "P9", "The terminal's sandbox is a child
   process", "Looks and themes", "Messages and languages in the app kit".
5. Chord's terminal: `src/node/tui/` (README and every file), `src/tui/` (README and every file),
   `src/node/surfaces/` (README, `tui.ts`, `surface-build.ts`, `bundle.ts`, `published.ts`, `current.ts`),
   `src/surfaces/connection.ts`, `client.ts`, `scripts.ts`; the kit's `src/node/app/app.ts` (`surfacesOf`, the bases
   after the listen, `applyChanges`); examples `56-web/tui/main.ts`, `57-tui/`; `test/node/tui/`.
6. p3: `bin.ts`, `server.ts`, `src/commands.ts`, `src/ask.ts`, `src/install.ts`, `src/app.ts`, `src/kit/*`
   (`start-server.ts`, `owner.ts`, `sign-ins.ts`, `identity.ts`, `running.ts`, `app.ts`, `layout.ts`),
   `scripts/build-release.ts`, `plugins/sessions/*`, `test/commands.ts`, `test/launched.ts`, `test/topology.ts`.
7. p2: `docs/p2-notes.md` ("TUI", "TUI through Radius"), `docs/p2-tui-port.md` §2 to §4 and §10,
   `docs/p3-functions/models-prompt-shells.md` ("TUI shell"), `src/hosts/tui.ts`, `tui-client.ts`, `tui-config.ts`,
   `tui-transport.ts`, `tui-sandbox.ts`.
8. `packages/coding-agent/src/main.ts` (`resolveAppMode`); `.pi/skills/interactive-testing.md`.

## Carried (not in this slice)

- **Slice 16:** pi-tui in the sandbox and the screens copied from coding-agent; themes, `ThemeChoice`, translations and
  `LocaleChoice` on the server; the terminal's colours queried; visitor preferences, keybindings, commands; mouse;
  copy by key and on select, paste image, external editor, suspend, window title and progress (Chord changes);
  fixed-origin "open in browser" paths; the launcher printing a crash's sanitized message; an RSS bound for the sandbox
  (a Chord change); drafts and reading positions on page state.
- **Slice 2:** `AppChanges` for the owner (the terminal applies through it); the restart mark.
- **Slice 25:** pairing in the terminal; device tokens per server and where they live (decision 8); remote servers
  and HTTPS; sign out.
- **Slice 5:** persons in the terminal (share links, the person's variant of the views).
- **Slice 21:** the terminal through Radius, on the launcher's transport (decision 3).
- **Slice 12, 19:** uploads and downloads; shell terminals in the client.
- **Windows** (with slice 26's list): the sandbox's environment there, raw mode and VT, the tests' pseudo-terminal.
- **Node 26 as p3's minimum** (decision 1, B).

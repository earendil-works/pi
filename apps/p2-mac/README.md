# p2-mac (spike)

A native macOS app for p2. It has two parts:

- **A menu bar item** that finds or runs the local p2 server.
- **Windows** that show p2's web UI in a WKWebView, signed in as the local owner without a token to paste.

It is AppKit with WKWebView, macOS 14 or later, and has no dependencies. The plan is the session artifact `pi-desktop-plan`.

## Build and run

```sh
cd apps/p2-mac
./scripts/build-app.sh            # build/Pi.app (debug, ad-hoc signed); CONFIG=release for an optimized build
open build/Pi.app
```

On first launch, choose a checkout in the menu bar item (**Choose p2 Checkout…**). It can be a pi-mono root or its `apps/p2`, with dependencies installed. The app then runs `node --import ./src/source.ts src/hosts/server.ts` there.

If a p2 already answers on the port, the app adopts it instead: it opens that server and can restart it when it runs in dev mode.

**Server** in the menu bar item lists the p2 servers running on this Mac, found by their loopback listeners, `/health` and the process's `P2_DATA_DIR` and working directory. Choosing one (your dev checkout's on 8788, say) makes the app use it: it never starts or stops that server, and it restarts it through `dev.sock` when it runs in dev mode. **Run Pi from …** switches back to the app's own server.

### Settings

Each setting is a user default (`defaults write com.earendil.pi <key> <value>`), and an environment variable overrides it for test runs:

| Default | Variable | Default value |
|---|---|---|
| `checkout` | `P2MAC_CHECKOUT` | none |
| `node` | `P2MAC_NODE` | `node` on the login shell's PATH |
| `port` | `P2MAC_PORT` | 8788 |
| `dataDir` | `P2MAC_DATA_DIR` | `~/.pi/p2` |
| `mode` | `P2MAC_MODE` | `start` (`dev`: the dev supervisor) |
| `fake` | `P2MAC_FAKE` | off (`1`: the faux provider) |
| `source`, `attachedPort`, `attachedDataDir` | `P2MAC_ATTACH` (a port; `P2MAC_DATA_DIR` is then its data directory) | the app's own server |

`P2MAC_DIAG_DIR` makes every finished page load write `page-N.json` (what the page sees) and `page-N.png` (a snapshot) into that directory.

The server's output goes to `~/Library/Logs/Pi/server-<port>.log`, which the menu bar item opens with **Show Server Log**.

### A trial run beside a live p2

This run leaves your real data and port alone:

```sh
mkdir -m 700 /tmp/p2mac-data
P2MAC_CHECKOUT=~/Development/pi-mono/apps/p2 P2MAC_PORT=8798 P2MAC_DATA_DIR=/tmp/p2mac-data P2MAC_FAKE=1 \
  build/Pi.app/Contents/MacOS/Pi
```

Ctrl-C quits it like the Quit command, which also stops its server. A checkout used only for running p2 needs `npm install --ignore-scripts` and `npm run hydrate:model-data` at its root.

## How it works

- **Sign-in** (`LocalSignIn.swift`): the app reads `<data>/owner-key` and answers p2's local owner challenge (`/owner/local/challenge`, then `/owner/local/claim`), as the TUI does. It puts the `p2_owner_<port>` cookie into the brain's own `WKWebsiteDataStore(forIdentifier:)`, then loads `http://127.0.0.1:<port>`. The result is a full local owner, with nothing to paste.
- **Server** (`ServerController.swift`):
  - It probes `/health` every 1.5 s.
  - It runs the server as a child process with the login shell's environment (`LoginEnvironment.swift`), so Homebrew and nvm tools are on PATH.
  - It stops the server with SIGTERM, and SIGKILL after 15 s.
  - It restarts its own server directly, and a server run elsewhere through `<data>/dev.sock` (`DevControl.swift`), when that server runs in dev mode.
  - Quitting the app stops its own server and leaves a server run elsewhere running.
- **Chrome** (`WindowChrome.swift`): the webview fills the window under a transparent title bar, so p2's own bars are the title bar and its background runs to the top edge.
  - An empty unified toolbar gives the window the system's toolbar-window buttons, centred 26 points from the top: the middle of p2's 52-pixel bars. The build script records the real SDK in the binary (`vtool`). SwiftPM records the deployment target instead, and AppKit then draws the older, smaller window buttons.
  - The page gets `data-shell="macos"` and `--shell-inset-start` (the window buttons' width). The script marks the bars at the window's top-left corner `data-shell-corner`, found by geometry because the layout decides which bars are there: the sidebar header, the top bar, a full-window viewer, a views pane. p2's CSS starts a marked bar's content after the buttons (`apps/p2/src/web/style.css`, end; on main). In full screen nothing is marked.
  - The marks are set in an animation-frame callback, so a bar is indented before it is painted. WebKit pauses those callbacks in a hidden window, where a timer does the marking instead. Dragging covers p2's bar height (52 points), not the whole title bar, which is taller.
  - WebKit has no `app-region`, so a script in its own content world samples the title bar strip for interactive elements and reports their rectangles. A mouse-down anywhere else in the strip drags the window, and a double click zooms or minimizes it, as the system setting says.
  - Native tabs are off, because their tab bar would cover the page's bars.
- **Window** (`BrainWindowController.swift`):
  - **Links:** Cmd-click, middle-click and `target=_blank` on the brain's origin open a new window. Every other origin opens in the default browser.
  - **Native handling:** downloads go to ~/Downloads; `<input type=file>` gets a file panel; `alert`, `confirm` and `prompt` are sheets; the microphone is allowed for the brain origin only; the page reloads when the web process crashes.
  - **Placeholder:** while there is no page, a native view shows the server's state with Start Pi or Try Again.
- **Menus** (`MainMenu.swift`): Edit (without it, copy and paste do nothing), Reload, zoom, full screen, windows.
- **Icons** (`PiGlyph.swift`, `scripts/make-icon.swift`): the Pi logo's shape as a template image in the menu bar, and in black on a white plate as the app icon.

## What the spike showed

These were checked by scripted runs:

- An HttpOnly cookie injected into the webview's store admits the local owner. p2's Host, Origin and Fetch Metadata checks accept WKWebView's requests. The web UI boots, and its WebSocket connects: the session list and a new "Ask Pi" session load.
- A child server started with the login shell's environment comes up. Quitting the app stops it.
- A dev-mode server run elsewhere is adopted. A restart through `dev.sock` returns in about 0.7 s, and quitting the app leaves that server running.
- WebKit in the app exposes `Notification` (permission `default`), service workers, `navigator.clipboard` and `getUserMedia`. Whether a notification permission request can succeed in an app's WKWebView is still open (M3), and the bridge is the fallback.

- Clicks in the title bar strip reach the webview, and only the window buttons are above it (a hit test at three points). The page reports its controls there, and p2's sidebar header starts after the window buttons (85 px).
- The server list finds the live p2 on 8788 with its data directory and checkout, and a trial server with its temporary ones.

These still need a person at the keyboard: dragging the window by the bars, Cmd-click windows, file drop on the composer, the file picker, downloads, the microphone, and keyboard handling in p2's terminal.

## Not in the spike

- The LaunchAgent (`SMAppService`).
- Radius brains.
- Notifications over the bridge.
- `pi://` deep links.
- Sparkle, signing and notarization.
- The bundled Node and p2.
- The server proof in the local sign-in.

# p2

> [!WARNING]
> # EXPERIMENTAL
> **p2 is a prototype. It will be gone soon.** It is not supported, its data formats and APIs change without notice,
> and it will be replaced. Do not build on it or run it for anything you depend on.

A self-hosted Pi Durable UI built from independent [Chord](../../packages/chord) plugins. Owners have full agent and
shell control on that server and its workers; this is not server-side filesystem isolation. Downloaded TUI facets run in a
locked-down worker on the visitor's machine.

## Run

Requires Node 22.19+ and the monorepo's installed dependencies and model data. From the repository root:

```sh
npm install --ignore-scripts
npm run hydrate:model-data
cd apps/p2
npm start
```

Open http://127.0.0.1:8788. `PORT` changes the port; `P2_DATA_DIR` changes the default data directory `~/.pi/p2`.
`P2_FAKE=1 npm start` uses a fake provider for demos, but tools still act on real files.
See [development notes](docs/p2-notes.md) for dev mode, architecture and testing.
Code mode scripts can orchestrate one-shot agents (`tools.agent`); [docs/workflows.md](docs/workflows.md) has workflow
patterns with example scripts (fan-out with adversarial verification, drafts plus a judge, fix until a check passes,
search until nothing new).

## Using the owner UI from another device

The server listens only on loopback. Use an HTTPS tunnel or reverse proxy preserving the public Host header, and
list its hostname in `P2_ALLOWED_HOSTS` (comma-separated for several hosts).

1. On the host, with `PORT` matching its running server:

   ```sh
   npm run owner-link -- https://your-domain
   ```

   The base defaults to `P2_PUBLIC_URL`, or `http://127.0.0.1:$PORT` (8788 when unset). The command uses the server's
   direct device-only loopback path; it does not need a browser or read the signing key.
2. Open the printed `https://your-domain/owner#<token>` link on your other device. The page removes the fragment,
   POSTs its token on the same origin, then redirects to `/`. The fragment never reaches HTTP/proxy logs.

Links work once and expire after ten minutes. Treat their output as a private credential: do not publish it or
put the token in a query/path. You can also use **Devices → Copy token** on the localhost owner UI, or the private
`<P2_DATA_DIR>/owner-token.txt` startup token, and paste it at `/owner`.

Owners get distinct signed, HttpOnly, SameSite=Lax cookies, Secure on a remote HTTPS origin. Cookies last 30 days
(server-side expiry too), are port-scoped, and survive restarts through the private `owner-key`. Signed-in devices
are remote owners (`access: "device"`), so provider login and SSH-key upload work but owner-token minting does not.
Only the trusted localhost device owner can mint invitations. Guest sharing is independent and session-limited.
Radius remains a separate authenticated owner transport; a proxy marker is never authentication.

**Devices → Sign out on this device** revokes this cookie, including its live connections; other devices stay
signed in. **Sign out all devices** rotates the signing key, revokes all associated cookies/connections and
outstanding links. Individual revocations persist in private `owner-revoked.json`. Already-admitted agent work
continues. The host's inherent localhost/device access cannot be revoked by signing out remote devices.

The first deployment of signed cookies rotates the former raw-key cookie secret once (`owner-cookie-version`):
old raw-key cookies intentionally stop working. Generate fresh owner links after deploying. Outstanding invitations
do not survive server restarts; a fresh headless token replaces `owner-token.txt`. Compatible plugin reloads retain them.

## Providers and SSH keys

**Providers** is available to every owner (local, associated device or Radius), never guests. Provider-owned
pi-ai flows support API keys and OAuth; credentials stay in the server's private `auth.json`. Remote connections prefer
device-code methods where offered. For a browser-callback flow, complete sign-in in the provider tab and paste its
code or final redirect URL into Providers. If OpenAI ChatGPT lands on an unreachable localhost page, copy its entire
address from the address bar and paste it; the page need not load. Anthropic displays a code to paste. The provider's
registered callback URL is unchanged.

**Envs → Upload private key** also works for every owner, locally or remotely, never guests. Keys must be passphrase-less
and at most 16 KiB; they are stored privately under `<data>/ssh/keys/`, never returned to a browser. Key generation
and fetching an existing public key are available to every owner too, never guests. See [remote environments](docs/remote-envs.md).

API keys, pasted login codes and uploaded SSH keys pass through your tunnel or relay. Use a trusted transport.
Keep the data directory, owner-key/tokens/revocations, provider credentials and SSH keys private; never commit them.

## Deploy behind a proxy (no HTTP basic auth)

Keep p2 loopback-only. Preserve the public Host header and forward WebSocket upgrades. Configure
`P2_ALLOWED_HOSTS=your-domain` and `P2_PUBLIC_URL=https://your-domain`. Overwrite `X-P2-Proxy-Secret` on **every**
request with a constant marker, for example `1`. The historical header name remains, but its value has no authority
and `P2_PROXY_SECRET` is no longer used. Any marked/forwarded localhost request is rejected rather than receiving
device privileges, even when a Unix-socket bridge makes its network peer `127.0.0.1`. Allowed public hosts are
remote regardless of the marker; without an owner/guest cookie visitors get only a minimal sign-in page and no
application assets, sessions, WebSockets or file/upload access. Share links still work without owner sign-in.

Example Caddyfile behind an existing HTTPS front end (the Unix-to-loopback bridge is unchanged):

```caddyfile
:80 {
    reverse_proxy unix//p2/p2.sock {
        header_up X-P2-Proxy-Secret 1
        flush_interval -1
    }
}
```

Remove `basic_auth` and the old secret injection. Do not rewrite the public Host to localhost. Ensure the public
front end actually uses HTTPS; p2 treats allowed public hosts as HTTPS origins. Restart p2 to apply runtime/auth
changes, then reload the proxy and mint a fresh owner link. Do not run competing servers against the same data dir.

## TUI sign-in

The TUI launcher requires **Node >=26.5.1**; the server still supports Node 22.19+. On slayer use Node 26.11.1:
`PATH="$HOME/node-v26.11.1-linux-x64/bin:$PATH" LD_LIBRARY_PATH="$HOME/node26-lib" npm run tui`
(or invoke `~/.local/bin/node26 --import ./src/source.ts src/hosts/tui.ts`).

```sh
npm run tui                          # device owner on http://127.0.0.1:$PORT (8788 when unset)
npm run tui -- https://your-domain    # prompts for an owner link if no valid cookie is saved
npm run tui -- https://your-domain --owner-link 'https://your-domain/owner#<token>'
npm run tui -- --radius               # through Radius: your only online server, or --radius <server-id>
```

With `--radius` the TUI reaches a server signed in with `npm run radius:login`, from anywhere and without a tunnel or
owner link. The first run signs the TUI in to Radius by device code (saved in `~/.pi/p2-tui/radius.json`); Radius
admits only the server's owner. For now each request is its own Radius connection, so a new server bundle shows up
within 10 seconds rather than one (see [p2 notes](docs/p2-notes.md#tui-through-radius)).

Direct loopback auto-signs in as the device owner without a link prompt; a proxy marker cannot use that path.
For remote URLs (HTTPS required), get an owner link on the host, then pass `--owner-link` or paste it at the prompt.
The TUI stores only its cookie per origin in `~/.pi/p2-tui/config.json` (0600, directory 0700;
`P2_TUI_CONFIG_DIR` overrides it). It never stores the consumed invitation. `P2_TUI_OWNER_LINK` is an optional
alternative to an argument. Links must match the selected origin and put the token in the fragment only.
Expired/revoked credentials prompt again on the next launch. Basic-auth flags, environment and saved passwords
are no longer used. If an active remote TUI is revoked, restart it and sign in with a fresh link.

### TUI isolation

The server esbuilds one self-contained ESM containing pi-tui, the Chord client, the runtime and its selected
`plugins/*/tui.ts` facets, only when their TUI dependencies are already selected (they never expand backend selection).
The launcher fetches the authenticated `/__p2_tui` manifest and hash-addressed bundle;
it never discovers or imports TUI facets from the visitor's checkout. Successful plugin reloads rebuild the bundle.
A changed hash starts a fresh worker; only after readiness does the launcher swap, restore UI state and terminate
the old worker. `/reload` requests a fresh worker too. Network drops reconnect to the same server.

The unrestricted launcher alone owns terminal input/resize, WebSocket, sign-in and local cookie storage. A plain
Worker runs with `execArgv: ["--permission"]`, `env: {}` and V8 resource limits. Its trusted bootstrap drops
`fs.read`, `fs.write`, `worker`, `net`, `child`, `addon`, `wasi` and `inspector` **before** importing the bundle
from an in-memory data URL. Worker stdout/stderr are captured and discarded. Heap snapshots/object queries,
worker environment-data/BroadcastChannel access, parentPort exposure and process-signaling/report controls are also
disabled. The entire worker fs/fs-promises function facade is closed: inherited numeric descriptors must not read
stdin or bypass stdout/stderr capture. Permission drops still protect JSON/require/file module loading.
Keybindings, theme and display settings are the visitor's own: the launcher reads pi's `~/.pi/agent/keybindings.json`,
`settings.json` and `themes/*.json` plus `~/.pi/p2-tui/prefs.json`, validates a whitelisted subset and posts it to the
worker as data (no paths, env or commands); the server's `TuiPreferences` (`<P2_DATA_DIR>/tui.json`) only supplies
defaults below them and never privileged bindings. The worker never reads files. Clipboard writes, opening URLs, downloads,
the external editor and Ctrl+Z are launcher actions under a grant (the visitor's own key, or a confirmation in a
launcher-drawn screen showing the exact data); server code cannot pick a visitor path, read the clipboard or open a
browser by itself.

All worker output passes a tight 64 KiB/frame terminal filter: printable text, CR/LF/tab, SGR, cursor/erase,
cursor visibility, synchronized output, bracketed paste, pi-tui's alternate screen and scroll region. OSC
(including clipboard/title/hyperlinks), DCS, APC/PM/SOS, kitty graphics, C1 controls, unknown modes and incomplete
escapes are stripped. Chord frames are relayed unchanged over the launcher's fixed-origin connection.

**Accepted risk: denial of service.** Malicious server code may crash or exhaust its TUI process. V8 limits bound
heap, not every native/ArrayBuffer allocation; a launcher watchdog samples process RSS and ArrayBuffers every
100 ms and terminates the worker above 512 MiB RSS or 128 MiB main-thread ArrayBuffers. RSS covers all threads;
ArrayBuffer accounting is thread-local. Sampling is not a hard OS quota: rapid allocations/native work can beat
it, and memory exhaustion can affect the host. Node/runtime vulnerabilities remain out of scope; keep Node patched.
There is no OS sandbox. The intended authority boundary denies machine reads/writes, network, child processes,
inherited environment and terminal escapes; a connected server retains full authority over its own workers.

### Owner testing on slayer

From `/home/badlogic/pi-private/apps/p2` (no server restart needed):

```sh
~/.local/bin/node26 --import ./src/source.ts src/hosts/tui.ts
# Loopback http://127.0.0.1:8788: automatic device owner, no prompt.

npm run owner-link -- https://p2.mariozechner.at
~/.local/bin/node26 --import ./src/source.ts src/hosts/tui.ts https://p2.mariozechner.at
# Paste the private printed link at the prompt. Ctrl+D exits.
```

Do not publish the owner link or paste it into logs. A valid saved remote cookie skips the prompt on later launches.

## Configuration

Edit `<P2_DATA_DIR>/settings.json` as a file; there is no Settings editor UI. Valid changes hot-reload without a
restart, and in-flight requests keep their configuration. Set the default model and thinking level with
**Make default for new sessions** in the model picker. `ownerName` (1 to 40 characters, no control characters, `<`
or `>`; default "Owner") is the name your messages carry from then on; messages already written keep theirs.

### Projects

A project is one codebase in several places, one per environment. `<P2_DATA_DIR>/projects.json` lists them:

```json
{ "pi": [{ "env": "mac", "path": "~/projects/pi/pi" }, { "path": "~/projects/pi/pi" }] }
```

Object order is display order; array order is preference. A place without `env` is this device; `path` is absolute or
starts with `~` (that machine's home); a project has at most one place per environment. p2 watches the file: valid edits
apply at once, an invalid one keeps the last valid projects and shows why. Projects are owner-only and, for now, TUI-only:

- A session belongs to a project only when it was started from the project's row (below), or copied (`/clone`,
  `/fork`) from a session that does. Its folder does not matter: "+ New session" never puts a session in a project,
  and `/cd` and `/move` keep its project. p2 stores this itself (not in projects.json).
- With an empty search the session selector is grouped: each project's row, then its sessions below it (newest first,
  subagent conversations nested in the threaded sort), then **Other** with **+ New session** and the sessions of no
  project. A session whose project was removed from projects.json shows under Other, dimmed, with the old name in
  parentheses; it groups again once the project is back. The grouped list always shows every session (Tab does nothing
  there). A search is flat: typed in the grouped list it searches every session, and Tab narrows it to the current
  folder; the archived sessions and a list without projects are flat with Tab's scope (current folder or all) as before.
- A project's row checks each place in the background when the selector opens (`pi   mac ✓   david-pi …`; this
  device shows as the server's hostname): `…` checking, `✓` reachable, `?` the machine answered but has no such
  folder, `✗` the machine is unreachable or no such environment is configured. Under the selected project a line says
  why for each place that is not usable (`mac: no folder ~/projects/x · gpu: no such environment`). Enter starts a
  session in the project at the first reachable place; left/right pick another place first.
- `/move <env>` moves the viewed session to its project's place on another environment (`local` or the hostname for
  this device), after the same confirmation as `/cd`. `/move` alone opens a picker of all the project's places, the
  session's own one marked `•` current and the others checked when it opens (same marks and reasons as the project
  rows); the cursor starts on the first other reachable place. Enter moves to a `✓` place (the others cannot be chosen;
  the current one just closes the picker), Escape cancels. When the session is below its project's place on its current
  machine, it keeps the subfolder (`.../pi/apps/p2` to `.../pi/apps/p2`) if the target has it, else it goes to the
  target place itself with a notice; that is read from the paths alone, so `/move` works while the session's machine is
  unreachable.

### Voice mode

Voice mode talks to the agent hands-free: the microphone button in the composer (owner only) streams your speech to a
speech service, each finished utterance becomes a message, and the agent's answers are read aloud sentence by sentence.
Talking over an answer stops it; "stop" also stops the agent. While it is on, the conversation's prompt asks for short
spoken answers. The button appears only when `<P2_DATA_DIR>/voice.json` names a speech service:

```json
{ "url": "https://voice.mariozechner.at", "token": "<the service's VOICE_TOKEN>" }
```

p2 watches the file: writing, replacing or removing it shows or hides the button in open pages at once, and the
service's engines and voices are fetched again on each change (the token stays on the server).

The speech service is `voice-server/` (Python, CPU only). Speech to text: Silero VAD and Parakeet TDT 0.6B v3, with
750 ms of audio before the detected speech start kept (`VOICE_VAD_PREROLL_MS`) so quiet first words survive.
Speech: selectable engines, listed with their voices by `GET /voices`: Supertonic 3 (default; voices F1-F5, M1-M5),
Kokoro and Kyutai Pocket TTS. Voice ids are `<engine>-<voice>`, for example `supertonic-F1` or `pocket-alba`. The
`/speak/stream` WebSocket sends 16-bit PCM chunks as they are generated: Pocket TTS streams ~80 ms chunks (first audio
after ~50-80 ms on slayer), Supertonic and Kokoro send a chunk per sentence (~0.2 s). `POST /speak` returns a WAV.
`server.py`'s docstring specifies the protocol. On slayer the service runs from `~/voice.mariozechner.at` (`docker
compose up -d`, token in `.env`); rebuild with `docker build -t p2-voice apps/p2/voice-server`. Browsers never reach
it directly: p2 proxies `/voice/listen` (WebSocket) and `/voice/speak` for the signed-in owner.

## Tests

```sh
npm run check
npm test
```

Tests use fake providers, temporary data/workspaces and port 0. Browser tests use `CHROMIUM_BIN`; daemon/SSH tests
skip when their prerequisites are unavailable. On Android (Termux) browser tests are skipped unless `P2_BROWSER_TESTS=1`:
Chromium's processes plus a test's p2 server and workers exceed Android's limit of 32 child processes, and its phantom
process killer then kills processes, the running p2 included. `P2_BROWSER_TESTS=0` skips them elsewhere too. No real provider logins or paid requests are needed.

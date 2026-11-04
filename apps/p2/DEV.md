# p2 development

See [p2 notes](docs/p2-notes.md) for architecture, reloads and testing; [README](README.md#tui-isolation) defines
the TUI threat model. Production/data directories must not be used for tests. Commit nothing without approval.

## Server and TUI

The server supports Node 22.19+. The launcher requires Node >=26.5.1; slayer has Node 26.11.1 at
`~/.local/bin/node26`. This wrapper supplies the libraries required by that binary. From `apps/p2`:

```sh
~/.local/bin/node26 --import ./src/source.ts src/hosts/tui.ts
~/.local/bin/node26 --import ./src/source.ts src/hosts/tui.ts https://your-domain
npm run check
~/.local/bin/node26 --import ./src/source.ts --test --test-concurrency=1 test/p2/tui*.test.ts
```

To use `npm run tui`/`npm test` with this Node, put its binary directory first in PATH and supply its library path:

```sh
PATH="$HOME/node-v26.11.1-linux-x64/bin:$PATH" LD_LIBRARY_PATH="$HOME/node26-lib" npm run tui
PATH="$HOME/node-v26.11.1-linux-x64/bin:$PATH" LD_LIBRARY_PATH="$HOME/node26-lib" npm test
```

The server builds one ESM bundle through esbuild and serves it only to web-admitted owners/share guests. Facets
are never imported from the visitor's checkout. Successful server plugin reloads rebuild/publish the bundle;
the launcher swaps to a fresh worker only after readiness and terminates its predecessor. TUI-only source/import
changes count as dirty plugins. TUI imports gate facet inclusion without expanding server/worker selection.
Keybindings, theme and display settings are guest-local: the launcher reads pi's `~/.pi/agent` files
(`PI_CODING_AGENT_DIR`) and `~/.pi/p2-tui/prefs.json`, validates them and posts data to the worker, watching for
changes; `<P2_DATA_DIR>/tui.json` (`TuiPreferences`) holds only server defaults below them. Launcher `config.json`
holds only per-origin cookies.

## Security boundary

Do not move authentication, sockets, raw terminal management or machine access into downloaded code. The launcher
recognizes a small message protocol; unknown capabilities are denied. Only opaque chord frames use its fixed-origin
socket. Download manifests/paths, byte bounds and version hashes are validated; redirects are refused.

The trusted Worker bootstrap must drop `fs.read`, `fs.write`, `worker`, `net`, `child`, `addon`, `wasi` and `inspector`
before ANY downloaded module evaluation. Node's permission-mode workers have implicit module-read grants until
explicitly dropped. Bundle import is from an in-memory data URL. Empty env, captured/discarded stdout/stderr,
V8 limits and cheap process/V8/worker-surface taming are required. Never expose parentPort or the Worker handle.
Disable the entire fs/fs-promises function facade too: inherited numeric descriptors can bypass path-based
permission checks, including raw fd reads/writes. BroadcastChannel and environment-data APIs must not communicate
with other host workers. These restrictions precede the bundle import and are tested through built-in aliases.

All downloaded output is untrusted: it must pass the launcher's bounded, complete-sequence terminal allowlist.
Never forward raw worker output, logs, exceptions, OSC/clipboard/title/hyperlinks or image protocols. Local file,
clipboard, browser, editor and job-control capabilities exist only as launcher actions (`src/hosts/tui-actions.ts`):
each needs an explicit, launcher-owned user grant (the visitor's own key, or a confirmation in the launcher-drawn
consent screen of the exact data) with validated data, never a server-provided path, a credentialed URL or a
simulated prompt. Adding one follows p2-tui-port.md sections 3.1-3.5.

Denial of service is owner-accepted. The watchdog samples RSS/ArrayBuffers and terminates the worker over its caps,
but sampling/V8 limits cannot enforce a hard native-memory quota; memory exhaustion can affect the host. There is
no OS sandbox. Runtime vulnerabilities remain out of scope. Keep Node patched and rerun the escape tests after
runtime changes. Tests use fake providers, disposable directories and port 0; no production or paid provider calls.

# `@earendil-works/pi-example-plugin`

This package provides conventional `session` and `tui` Chord facets. The Session-worker facet provides a remote greeting service. The TUI facet contributes `/hello` and calls that service.

The package needs no build script. Pi asks Chord to discover `src/session.ts` and `src/tui.ts`, builds both entries into its server-owned plugin cache, and sends the TUI artifact to clients.

From the repository root:

```bash
PI_EXPERIMENTAL=1 ./pi-test.sh server \
  -e "$PWD/packages/coding-agent/examples/plugins/pi-example-plugin"
```

Alternatively, a client can select the plugin for the Session it creates or resumes on one local server:

```bash
PI_EXPERIMENTAL=1 ./pi-test.sh client \
  -e "$PWD/packages/coding-agent/examples/plugins/pi-example-plugin"
```

Repeat `-e` to select multiple plugin packages. Client paths are resolved locally and sent only to a Unix server; Radius clients cannot select server filesystem paths. The Session and matching TUI facets are stored with that Session, so later server generations and clients can resume it without plugin arguments. Other Sessions and their workers are unaffected. An active Session rejects a different package selection instead of being restarted.

`server -e` establishes the server profile's default Session and TUI facets. Starting an explicit foreground server without `-e` clears that default. Client selection never changes the server's root facet generation.

Run `/hello Armin` in the TUI. After editing a facet, run `/reload`. The server atomically rebuilds the package, reloads the attached Session-worker generation, updates the current TUI generation, and serves the new artifact to future clients.

Package metadata can override or disable conventional entries:

```json
{
  "chord": {
    "facets": {
      "session": "./src/worker.ts",
      "tui": false
    }
  }
}
```

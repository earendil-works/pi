
# Things the OS Gives You {#natives lede="Start data, host-lifetime objects and natives: how a plugin opens a file watcher or a socket so that it is closed exactly once, also across reloads."}

Studio's notes get an inbox: a text file dropped into the session's `inbox/` directory becomes a note. That needs a
file watcher, a **native**: an OS-level value (a file handle, a socket, a process, a database connection) that cannot
be JSON, cannot be copied, must be opened, and must be closed exactly once. It also needs the session's data
directory, which the plugin does not know. This chapter covers both.

## Start data is an object

A worker knows things before any plugin loads: its session id, the data directory, init data from the server's start
message. There is no special mechanism for them. Start data is an ordinary `local` object with `lifetime: "host"` and
constant state, served by base code's core facet:

```ts
// studio/src/core/contract.ts
export const Init = obj({ id: str(), dataDir: str(), cwd: str(), env: opt(str()) });
export const SessionInfo = local("studio.session-info", {
  version: 1,
  input: obj({}),
  members: { init: Init },
});

// studio/src/core/worker.ts
export const coreWorkerFacet = (init: Static<typeof Init>) => defineFacet((host) => {
  host.serve(SessionInfo, () => ({ init: constant(init) }), { lifetime: "host" });
  // … the Harness and other core objects (chapter XIV)
});
```

Any plugin on the worker declares a reference and reads it **after activation**: in an opener, a derive, a routine or
a method, never synchronously in the factory.

```ts
const info = self.get(SessionInfo, {});
// later: info.init.value.id, info.init.value.dataDir
```

Paths are derived by the plugin from generic start data (`join(dataDir, id, "notes-inbox")`), never provided per
plugin. Platform bindings work the same way: on a Durable Object, a core object's `self.open` returns the binding
(`state`, `env`) and its close does nothing.

## `self.open`

```ts
const watcher = self.open(
  async ({ signal }) => watchDir(path, { signal }),       // open: during activation
  (w, reason) => w.close(),                               // close: when the object ends or restarts
  { closeTimeout: 10_000 },                               // optional; host default 30 s
);
watcher.value;                                            // the watcher; reading it before activation throws not_ready
```

`self.open` returns a handle with `.value` (type `Native<T>`), not a proxy. The rules:

- **Natives live only in objects.** Not at module level, not in the facet. A module-level watcher would survive a
  reload with nobody to close it.
- **Order:** natives open one after another in declaration order (a later opener may read an earlier handle's
  `.value`) and close in reverse. The object goes live after all opens succeeded.
- **The value never changes during an attempt.** No replacement, no versions, no stale-handle logic. To change a live
  native, the object restarts.
- **A failed open** makes the object `failed`: transient with backoff by default, broken if the opener says so
  (`throw broken(error)`). A partly failed activation closes the natives already open, with reason `end`; the next
  attempt opens all of them anew.
- **`close` gets a reason:** `{ kind: "reload" }` (the plugin reloads and this native object restarts), `{ kind:
  "stop" }` (the host shuts down) or `{ kind: "end" }` (the last reference ended, or the type was removed). Each
  `close` is bounded by `closeTimeout`, then reported as a possible leak while the rest continues. A throwing `close`
  does not stop the others; `host.close()` collects the errors, background ends report to `onError`.
- **Behaviour around a native goes into routines** (chapter X). Listeners on natives outside routines are forbidden.

An object with at least one `self.open` is a **native object**; one without is a **pure object**. The difference
decides what a reload does (chapter XV): pure objects are swapped in place, native objects restart.

## The inbox

The inbox must run as long as the worker, whether anyone looks at the notes or not. So it is a `lifetime: "host"`
object. The facet cannot `self.get` a type it serves, and the inbox has no meaningful input, so it is an object
without input that reads its session from the start data:

```ts
// notes/contract.ts
export const NoteInbox = local("notes.inbox", { version: 1, input: obj({}), members: {} });

// notes/worker.ts
host.serve(NoteInbox, (_input, self) => {
  const info = self.get(SessionInfo, {});
  const watcher = self.open(async ({ signal }) => {
    const { id, dataDir } = info.init.value;                       // read in the opener: after activation
    return watchDir(join(dataDir, id, "notes-inbox"), { signal });
  }, (w) => w.close());

  self.routines.loop("import", async (ctx) => {                    // chapter X
    const store = await ctx.get(NoteStore, { session: info.init.value.id });
    for await (const file of watcher.value.files(ctx.signal)) {
      await store.add({ text: await readFile(file, "utf8"), by: "inbox" }, ctx);
      await rm(file);
    }
  });
  return {};
}, { lifetime: "host" });
```

Note `ctx.get(NoteStore, …)` in the routine rather than `self.get` in the factory. The factory runs before the
session id is known (start data is read after activation), so a host-lifetime object without input gets
session-scoped objects with `ctx.get` in a routine or method (R22). A `get` whose input is computed after activation is
to be added only if a real case needs it.

## Natives with work in flight

A restart is sequential (R16): close the old native, then open the new one. When the old one still has work running,
use one of two patterns:

- **Drain in the background.** `close` detaches the old resource and returns at once; it disposes of it when its work
  finishes, or after `closeTimeout` at most. Chord opens the new one immediately. Code mode's sandbox does this: a
  script running during a reload finishes on the old sandbox (for up to 30 s, Q7; a longer one is aborted and its turn
  fails), new scripts start on the new one.
- **Swap through a registry.** The resource is a registry contribution (chapter XIII). Readers always look up the
  current one at use; a reader that must wait for one uses a cancellable "wait until present" with the park deadline.

Chord aborts only the object's own calls and jobs on close. Other work that uses the native (Durable tool calls on a
sandbox) is the owner's business: `close` may drain instead of tearing down. What an old native does after its owner
restarts is also the owner's `close`: a model runtime keeps working until collected, a closed SSH connection fails its
in-flight `exec`.

## Natives that follow a relocation

A session can move to another directory. The inbox watcher must follow. Restarting the object on every move would be
heavy-handed; instead the native is a stable manager opened once, and a routine on the session location switches its
internal resource and bumps a generation, so late events from the old location are dropped:

```ts
const watcher = self.open(async ({ signal }) => new SwitchableWatcher({ signal }), (w) => w.close());
self.routines.on(location.cwd, (cwd) => watcher.value.switchTo(join(cwd, ".notes-inbox")));
```

## Call-scoped natives

A native that lives exactly as long as one call (a temporary SSH session for a directory listing, a file handle for a
download) is opened and closed inside the method with `try/finally`. There is no `ctx.open`:

```ts
list: async ({ path }, ctx) => {
  const session = await ssh.open(config, ctx.signal);
  try { return await session.readDir(path, ctx.signal); }
  finally { session.close(); }
},
```

## Core vs. plugin

`SessionInfo` comes from base code, `NoteInbox` from a plugin; both use the same primitives. Where code lives decides
which it is. **Base code** (the app's `src/`, imported statically by the start code under a fixed name such as
`@studio/core`) is always there, not switchable, and a change restarts the hosts. **A plugin** (its own directory,
found by listing, named by its `package.json`) is switchable and reloads. Core is what the app always needs and
everything builds on: the harness, the session list, access, the session location. Optional features are plugins;
code mode is a plugin.

:::note | Built so far
Natives and host-lifetime objects are layer L4. `constant` is decided (R23), not built.
:::

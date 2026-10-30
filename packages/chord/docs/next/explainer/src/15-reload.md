
# Reload and Rollout {#reload lede="What happens when you press Reload: per host, per object, and across the server, the workers and every tab."}

Back to the preface. Mario changed the notes plugin's sort order and pressed Reload. Everything the earlier chapters
asked of plugin authors (synchronous factories, natives only in objects, routines instead of timers, data in
documents) exists so that this moment is safe. This chapter shows what Chord does with it.

## On one host

```text
1. load      new bundles; an import or syntax error rejects
2. staging   facet setups and every live object's new factory run with a recording self
             (declarations only, nothing activated); any throw rejects
3. commit    the host switches to the new code atomically
4. after     per object: pure objects swap, native objects restart
```

**Rollback is all-or-nothing per host.** Any load or staging error leaves the whole host on its previous code, so a
host is always completely at one revision and its status is one value. Runtime states (a registry conflict, a failed
open, a migration) are not reasons to roll back; after the commit, errors stay with one object. There is no factory
trial, no migrate dry run, and no consumer contract check in staging: an incompatible consumer fails at bind with
`contract_mismatch` and a notice naming plugin and type.

:::steps | Reloading @studio/notes on worker S1, object by object
+++ Load and stage
The new bundles load. The facet setup and the factories of `Notes` (three views), `NoteStore { S1 }` and `NoteInbox`
run with a recording `self`: they declare, nothing activates. Nothing throws, so the host commits to the new code.
+++ NoteStore: pure, swapped in place
`NoteStore` has no `self.open`. Its new methods and derives take over; `NoteList`, the drafts, its references and the
running import job stay. Routines restart, serialized: the new `cleanup` waits for the old handler in flight. The gate
opens.
+++ Running calls finish on old code
An `add` that was running when the swap happened finishes on the old code with its old handles; its transaction still
commits. Only new calls get the new handles. Exception (R15): if the reload raised a document's version, old code that
touches the migrated document throws, the document stays intact, and that call fails once.
+++ The import job keeps its old run
The job's `run` keeps the code it started with. When it settles, the **new** `finish` records the outcome.
+++ The views: pure, swapped
The three `Notes` views swap in place. Owner, Ann and Bob keep their references; the reader derive is recomputed with
the new sort and the difference is sent. Nobody sees a reconnect.
+++ NoteInbox: native, restarts
`NoteInbox` has a watcher. Its running work ends `aborted`, the watcher closes with reason `reload`, the new factory
runs, the watcher reopens. Its documents would stay. Whether a file dropped during the restart is seen is the
watcher's business: Studio's `watchDir` scans the directory once when it opens.
:::

**Why natives restart instead of being handed over:** a native has no line, no transactions and no schema. If old and
new code shared it, they would interleave on it unchecked. In practice restarts are cheap: the Durable harness is base
code, terminal PTYs live in a separate terminal host process, and model runtimes, sandboxes and a search index rebuild
in milliseconds. Only reloading the plugin that owns SSH connections (running remote commands die) or the relay socket
(relayed connections drop) hurts.

**Removing a type:** its objects end (routines stop, natives close, references end with an error); in-memory documents
go with them; persisted ones stay until retired. **Consumers elsewhere** see a restarting object like any object that
briefly goes away: `loading`, parked calls, then `live`.

**UI facets reload too.** A reload unmounts and remounts components. That is why "leaving" (abort a login, close an
overlay) is never derived from an unmount (chapter VIII).

## Across hosts

A **revision** is (server incarnation, sequence) and names the complete desired code set: every facet with its
digest, not a batch of changes. Every install reconciles everything missing, and a host reports a revision only when it
runs that complete set. A revision also carries the code-set digest (a hash over the facet bundles' content hashes),
so a server restart with unchanged code triggers no reinstall.

The order is **server, workers, clients**. Each host reports `installed`, `installed_failed` (with the objects that
failed) or `rejected` (with the reason; it stays on its previous code). A server that rejects stops the rollout. A
host that starts or reconnects installs the current revision before anything is routed to it. Installs are serialized
per host and bounded (60 s).

Calls keep flowing during a rollout. When a call reaches a provider on another revision, the mismatch response
carries the provider's revision and status:

| Provider | The call |
| --- | --- |
| ahead, or behind and installing | `updating`: values readable, calls park (with the park deadline) |
| rejected | fails at once; retried on the next revision |
| same revision | `contract_mismatch`: a real mismatch, final |

A host checks its own install status first: if its own install was rejected, a call fails at once with the reason
instead of waiting on a provider. Calls parked on a binding that is released end with an error and are not resent.
There are no cross-host transactions and no votes.

:::sequence animate | A tab calls into a worker that is still installing. The call parks and runs once the worker reports the revision.
actor tab "tab" "revision 8"
actor server "server" "revision 8" accent
actor worker "worker S1" "installing 8" blue
server => worker: install revision 8
tab -> server: call Notes.add (new contract)
server -> worker: relay
worker --> server: updating (rev 7, installing)
server --> tab: updating
tab -> tab: park (deadline 60 s)
worker --> server: installed 8
server --> tab: provider at 8
tab -> server: call Notes.add (resent from park)
server -> worker: relay
worker --> tab: result
:::

## Start barrier

At host start and first load there is one more rule (chapter XIV): load every facet (the core facet with its start
data among them), wait until every facet and `lifetime: "host"` object other than the harness is live or failed, then
resume dependent work. Plugin reloads need no barrier.

## Loading and the dev loop

- **Roots:** plugins come from built-in, global (`<data>/plugins`), package (npm or git, installed with
  `--ignore-scripts`) and project roots, found by directory listing; no source parsing. The server selects which load.
  Dependencies between plugins resolve by contract name at runtime. Names are prefixed: objects `<plugin>.<name>`,
  tools `<plugin>_<name>`.
- **Loader D:** one base bundle per surface (host packages and the app runtime) plus one script per facet, with host
  packages passed in (no module map). Old generations are reclaimed by the garbage collector; a stable filename per
  (facet, digest), and V8's compilation cache off on hosts that reload in place. The loader is an adapter: static
  imports (tests, Durable Objects) work the same, with the app passing the plugin name to `load`.
- **Dev loop:** a source watcher marks plugins dirty and never applies anything. A reload control (the playground's web
  shell, a CLI, an agent tool such as p2's `reload_plugins`) reloads the changed plugins, or restarts all hosts for
  base code. Reloads are always explicit.

:::review | Review: project plugins (#14, deferred)
Per-directory plugins with trust prompts and snapshots (`apps/p2/docs/plugin-loading.md`, still the reference for
roots, trust and scopes) need their own pass over this design. Until then, treat the project root as designed but not
settled.
:::

:::note | Built so far
Reload and rollout are layer L10, the last before telemetry. The frozen kernel has a reload path with host values and
a development freeze, both removed from the design.
:::

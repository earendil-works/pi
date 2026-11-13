# p3 org-managed Pis: details

Appendix to `book.md` (the short design note published as the artifact). This file is the third edition of the long
book, kept for reference and not built: the full Acme walkthrough with code for every file, eight traces, platform
lock-down (signed install, service user, sandboxes, execution control, device key), failure modes, kit changes, and
what the base needs when. Where it differs from `book.md` (it still puts the org gate, the profile cache and the
sharing switches in the base, and calls the preset lock `default`), `book.md` wins.


# Before we begin {.preface}

p3 gives one Pi to each person. Colin's plan has two dates. On December 1, Pi Roam: a person runs their own Pi,
reaches it through Radius, backs it up there. On December 18, Org Devices: an org has a machine, and each member
creates their own Pi on it with "Create my Pi here" in Radius. Dana works at Acme. Her Pi is hers: her sessions, her
logins, her plugins. But Acme wants three things from it. It should start with Acme's plugins, MCP servers and models
already set up. It should not share sessions with people outside Acme. And it should not quietly load code Acme never
approved.

The obvious answer is a permission system: plugins name their operations, the org writes rules over them, a policy
plugin decides each call. The consultations showed what that costs. Every plugin author classifies every method, the
base grows levels, a rule registry and a `may` member, and the result is still a guardrail, because code running in the
Pi's process can skip any check. And it does not even cover the first wish: provisioning ("start with our MCP
servers") is a separate mechanism.

This design takes the other road. **Everything an org wants is a setting.** Plugins already need settings for their
settings page; they declare them through one base mechanism. Acme's values form one **managed layer** on top of
Dana's own values. For each setting it names, the layer either provides a default (Dana may change it, or add entries
beside Acme's) or locks it (only Acme's value counts). "Start with our MCP servers" and "no MCP servers except ours" are
the same data with a different lock.

## Ten things to know

:::findings
1. **An org profile is a list of setting values,** each with a lock: `default` or `locked`. Plugins to install, MCP
   servers, model providers, sharing and peer audiences, company instructions: all are settings. There are no
   operations, levels, rule tables or policy functions.
2. **Plugins declare settings with `defineSetting`,** a token with a name, a schema, an initial value and a merge kind:
   `value` (one value) or `entries` (a record by name, such as MCP servers). Authors write nothing about orgs.
3. **Every write goes through `Settings.set`:** the settings page, the agent's tools, other plugins. It refuses a locked
   setting and any change to an org's entry with the error code `managed` ("Managed by Acme").
4. **Enrollment is a root-owned file:** "you belong to org Acme, its server is this, its key is this; do nothing before
   you have synced". It holds no secrets and no settings.
5. **The profile comes from the org server (Radius), signed with the org's key.** An enrolled Pi starts locked, fetches
   its profile, installs the required plugins, writes the signed profile as its cache and unlocks. Later starts use the
   cache at once and follow the server live.
6. **The gate is one tagged state:** `unmanaged`, `pending`, `ready`, `stale`, `revoked`. Sessions start, workers
   authorize and plugins load only when it is `unmanaged` or `ready`.
7. **In the Pi it is a guardrail; at Radius it is real.** It stops Dana's agent and well-behaved plugins. A shell under
   the Pi's Unix user, root, or an admitted plugin can ignore it. Sharing, peers and org-paid models are enforced at
   Radius from the same profile.
8. **The base must have one settings mechanism now,** before any org exists: one write path, a `managed` error, base
   switches for sharing and peers, and a gate that is always `unmanaged`. Retrofitting a single write path later is the
   expensive part.
9. **One mechanism covers every case Acme cares about.** Adding an MCP server, editing Acme's Jira entry, installing a
   plugin, writing one, sharing outside Acme, a live removal, and a lock on Acme's own plugin's setting all end in
   `Settings.set`, `admit` or a setting a plugin follows. Chapter IV traces each one through the code.
10. **On an Org Device the shell is moved out of reach.** The Pi runs as a service under its own Unix user, from a
   root-owned install; the agent's tools run only in Gondolin sandboxes with the folders Acme allows; Radius serves org
   resources only to a Pi that proves a device-bound key. A patched copy gets nothing from Acme, and a member's agent
   can no longer touch the Pi's files at all. Restriction plugins, picked in Radius, narrow it further.
:::

## Words used throughout

A **member** is a person in an org, and the owner of one Pi. A **setting** is a named, typed piece of configuration a
plugin declares with **`defineSetting`**. Its **merge** kind is **value** (one value) or **entries** (a record of named
entries). The **user layer** holds the member's own values; the **managed layer** holds the org's, each with a
**lock**: **default** (the org's value is a starting point) or **locked** (only the org's value counts). The
**effective value** is what plugins read after both layers are combined. The **enrollment file** binds a machine's Pis
to an org. The **profile** is the org's managed layer for one member's Pi, signed with the **org key**; the Pi keeps the
last good one as its **cache**. The **gate** is the Pi's org state. **Admit** is the kit's check that decides at
discovery which plugins load. A **guardrail** holds against the member's agent and well-behaved code; a **wall** holds
even against a modified Pi, because Radius enforces it. On a locked-down machine the Pi runs as a **service user** of its own, and the
agent's tools run in **sandboxes**, Gondolin VMs with chosen folders mounted. A **restriction plugin** is a required
org plugin that narrows what members and their agents can do.

:::note | What this supersedes
The decision "Resource model direction" (2026-11-08) planned one replaceable policy plugin that guards create, bring
and add-member operations. It is dropped: an org restricts by locking settings. Company resources of the decision
"Instance resources" (2026-11-13: a shared login, a team server) become org-managed entries of the setting that holds
them, such as an MCP server in `mcp.servers`. The research note `authz-research.md` (named operations, levels, `may`)
is not pursued.
:::

# What Acme Sets {#profile lede="The two files behind an org-managed Pi: the admin's enrollment and Acme's signed profile."}

Two documents make Dana's Pi Acme's. The first sits on the machine and never changes: it says which org the machine's
Pis belong to. The second lives in Radius, changes whenever Acme's admin edits it, and says what Acme wants. The split
matters. The machine admin decides once that a machine is Acme's. Acme's admin then edits one profile in Radius, and
every member's Pi follows it live, with no agent on the machine keeping files in sync.

## The enrollment file

On an Org Device, the Device's own setup (running as root, with the org's service token) writes this file once. On a
member's laptop, the org's device management (MDM: the tool an IT department uses to push files and settings to
company laptops) delivers it. Without the file, a Pi is personal and unmanaged, as on December 1.

```json
// PROPOSED · /etc/p3/enrollment.json, owned by root, mode 0644, parent directories root-owned
{
  "org": "acme",
  "name": "Acme",
  "server": "https://radius.example.com/orgs/acme",
  "orgKey": "ed25519:MCowBQYDK2VwAyEAq4…",
  "pluginSources": ["https://github.com/acme/", "https://github.com/earendil-works/"]
}
```

It holds no secrets. `orgKey` is the public key profiles are signed with. `pluginSources` limits where the org may push
code from: a profile naming a plugin outside these prefixes is refused, even when signed. The path is fixed in the base
code: no flag and no environment variable can point the Pi at another file, so a member's agent cannot enroll the Pi
somewhere else or skip enrollment.

The Pi's own credential is not in the file. "Create my Pi here" in Radius, or Dana's Radius sign-in on the gate page,
gives her Pi its own token, kept in the Pi's data directory. A shared token in a machine-wide file would be wrong: the
profile is per member.

## The profile

Radius resolves Acme's groups to one profile per member and Pi. Here is Dana's:

```json
// PROPOSED · the profile Radius serves to Dana's Pi
{
  "payload": {
    "org": "acme",
    "orgName": "Acme",
    "member": "dana@acme.com",
    "pi": "pi_7f3a",
    "revision": 42,
    "issuedAt": "2026-12-18T09:00:00Z",
    "maxOffline": null,
    "settings": {
      "p3.plugins": { "lock": "locked", "value": {
        "acme-tools":   { "source": { "git": "https://github.com/acme/p3-tools", "ref": "v1.4.0" },   "hash": "sha256-9c1e…", "required": true },
        "acme-deploy":  { "source": { "git": "https://github.com/acme/p3-deploy", "ref": "v0.9.2" },  "hash": "sha256-41b0…", "required": true },
        "acme-reviews": { "source": { "git": "https://github.com/acme/p3-reviews", "ref": "v2.0.1" }, "hash": "sha256-77de…", "required": false }
      } },
      "p3.plugins.own": { "lock": "locked", "value": false },
      "mcp.servers": { "lock": "locked", "value": {
        "jira":   { "url": "https://mcp.atlassian.com/v1/sse", "auth": { "radius": "jira" } },
        "linear": { "url": "https://mcp.linear.app/mcp", "auth": { "radius": "linear" } }
      } },
      "models.providers": { "lock": "locked", "value": {
        "radius": { "kind": "radius", "auth": { "radius": "models" } }
      } },
      "p3.sharing.audience": { "lock": "locked", "value": "org" },
      "p3.peers.audience":   { "lock": "locked", "value": "org" },
      "prompt.instructions": { "lock": "default", "value": {
        "acme": { "text": "Acme code is reviewed on GitHub before merge. Never paste customer data into issues." }
      } }
    }
  },
  "signature": { "alg": "ed25519", "key": "acme-2026-11", "value": "Zm9v…" }
}
```

Read line by line, it says:

| Setting | Lock | Effect on Dana's Pi |
| --- | --- | --- |
| `p3.plugins` | locked | `acme-tools` and `acme-deploy` are installed at the pinned ref and hash. `acme-reviews` is allowed: offered in the catalog, installed on request. Nothing else may be installed. |
| `p3.plugins.own` | locked `false` | Plugins Dana or her agent write do not load: only approved builds run. |
| `mcp.servers` | locked | Jira and Linear are connected; Dana cannot add a server. |
| `models.providers` | locked | Only Radius's model gateway; Acme's provider keys stay at Radius. |
| `p3.sharing.audience` | locked `"org"` | Sessions can be shared with Acme members only. |
| `p3.peers.audience` | locked `"org"` | The Pi connects only to Pis of Acme members. |
| `prompt.instructions` | default | Acme's instructions are in every session; Dana may add her own beside them, not edit Acme's. |

Every setting the profile does not name stays Dana's. Credentials are never in the profile: `auth: { radius: "jira" }`
is a reference, resolved at Radius when the MCP plugin connects. Leaving Acme removes access at Radius, with nothing to
wipe on the machine.

`member` and `pi` bind the profile to Dana's Pi: a profile issued for another member or another Pi is refused, even
when the signature is valid. `revision` only grows: the Pi never takes a lower one than it has. `maxOffline` is
optional; it is explained in chapter III.

:::review | Review: who holds the org key
The consultation says the profile is signed "with the org key, not with Radius's key, so Radius alone cannot forge
one". That holds only if the private key is not at Radius: the admin signs in the browser with a key Radius never sees.
If Radius's profile editor signs with a per-org key it stores, the signature still stops edits of the cache on the
machine, but a compromised Radius can push code to every member's Pi. Decision needed (Open Questions).
:::

# Everything Is a Setting {#settings lede="One declaration per setting, two merge kinds, two locks, one write path: what plugin authors write, and what they do not."}

Without a shared mechanism, every plugin keeps its configuration its own way. p2's MCP plugin reads `mcp.json`, the
models plugin reads `models.json`. An org that wants to lock MCP servers would need a hook in each of them, and a
plugin that keeps a private config file would escape any lock. So the base owns configuration: a plugin declares each
setting once, the base stores the member's values, combines them with the org's, and every write goes through one
method that knows about locks.

## Declaring a setting

A setting is a token in the contract file of the plugin that owns it, like a `defineState` token: a name, a schema, a
merge kind and an initial value. The plugin contributes it to the registry `SettingKinds`, from which the settings page
renders its forms and which the Pi reports to the org server so its admin form knows the setting.

```ts
// PROPOSED · apps/p3/plugins/mcp/contract.ts (full file in chapter IV)
export const McpServers = defineSetting("mcp.servers", map(McpServerConfig), { merge: "entries", initial: {} });
```

`defineSetting`, `SettingKinds`, `Settings` and `setting()` are in `apps/p3/app/v1/settings.ts`, shown in full in
chapter IV.

## Two merge kinds, two locks

**Value** settings hold one value: a boolean, a string, an object. `p3.sharing.audience` is a value setting.
**Entries** settings hold a record of named entries: MCP servers by name, providers by name, plugins by name. The
difference matters for the default lock: an org default of a value setting is replaced by the member's value; org
entries are added beside the member's.

The effective value follows four rules:

| Managed layer says | Value setting | Entries setting |
| --- | --- | --- |
| nothing | the member's value, else the initial value | the member's entries |
| `default` | the member's value, else the org's | the member's entries plus the org's; on the same name the org's wins, read-only |
| `locked` | the org's value | the org's entries only |
| (gate not open) | the initial value | none |

A locked setting does not delete the member's values. They are kept and ignored, so when Acme unlocks
`mcp.servers`, or Dana's Pi leaves Acme, her own servers come back. While the gate is closed (`pending`, `stale`,
`revoked`), every setting reads its initial value; nothing from Dana's own configuration acts before Acme has spoken.

## The one write path

`Settings` is a local object with empty params on the server: one per Pi, persisted, the only writer of the user
layer. Its one method, `set`, takes either a whole value or one entry of an entries setting, and refuses in this order:

1. the gate is closed: `gated`, "Waiting for Acme";
2. no loaded plugin declares the name: `unknown_setting`;
3. the org locked the setting: `managed`, "Managed by Acme: mcp.servers is locked";
4. the write touches one of the org's entries: `managed`, "Managed by Acme: the entry jira of mcp.servers";
5. the value fails the declaring plugin's schema: `invalid_value`.

Then it writes Dana's layer. The gate is read per call, not when the page was drawn, so a lock that arrived a second
ago counts. Pages and the terminal render `managed` as "Managed by Acme" and draw a lock beside every name in the
store's `managed` member; Dana's agent gets the same error from its tools, which call the same `set`. Chapter IV has the
code (`apps/p3/plugins/settings/server.ts`) and traces both paths.

:::note | Workers read settings through the server
`Settings` is a server object. A session worker that needs a setting (the harness reading `prompt.instructions`)
follows it through a server view, as other per-session server data is followed today; the worker never holds its own
copy.
:::

## What a plugin author writes

The MCP plugin declares its servers as a setting, contributes it, and reconciles its connections with the effective
value. It never names an org, a lock, a gate or a principal.

```ts
// PROPOSED · apps/p3/plugins/mcp/server.ts, shortened (full file in chapter IV)
export default defineFacet<P3Principal>((host, facet) => {
	facet.contribute(SettingKinds, [McpServers]);
	host.serve(McpConnections, (_params, self) => {
		const servers = setting(self, McpServers);                     // Acme's entries, plus Dana's unless locked
		self.on(servers, async ({ value }) => reconcile(value));       // a server an update locks out disconnects now
		return { status, tools, call };
	});
});
```

The `self.on` routine is needed for Dana's own edits anyway: when she removes a server on the settings page, it
disconnects. An org update that locks a server out takes the same path. That is the whole point of the design: the
plugin already follows its configuration, so following the org costs it nothing.

The plugin review rule is one sentence: **all configuration goes through settings.** A plugin that keeps a private
config file escapes the locks. The remedy is not a check in the base but the plugin list: Acme admits only plugins it
reviewed.

## Provisioning and deny lists are the same data

Acme's first draft gave every member Jira and Linear and let them add more: `mcp.servers` with lock `default`. A month
later security asks for "no MCP servers except ours". The admin changes one word, `default` to `locked`. Dana's
personal servers disconnect within a second, stay stored, and come back if the lock is ever lifted. There is no
second mechanism for restrictions.

# Enrolled, Locked, Ready {#gate lede="How a Pi waits for its org, unlocks, starts from its cache and follows updates, and the one kit change it needs."}

The enrollment file says "do nothing before you have synced". The Pi needs a single place that knows whether it has
synced, which every part consults: the start of a session, a worker's authorization, plugin loading, `Settings.set`.
That place is the **gate**, a derived value of one base object, `OrgGate`.

## Five states

```text
// PROPOSED · OrgGate.gate
unmanaged                        no enrollment file: personal Pi, everything open
pending { org, why }             enrolled, no valid profile yet: locked; the page shows "Connect to Acme" and why
ready   { profile, live }        a valid profile is applied: open; live = following the server now, else from cache
stale   { profile }              offline longer than the profile's maxOffline: locked again (only if Acme set one)
revoked { org }                  Acme removed this member or Pi: locked; the data stays where it is
```

:::flow wide animate | The gate's states. Only `unmanaged` and `ready` are open; every other state runs no session and loads no plugin beyond the app's own.
row "Open" blue
box unmanaged "unmanaged" "no enrollment file"
box ready "ready" "profile applied, live or cached" accent
row "Locked" muted
box pending "pending" "enrolled, no valid profile"
box stale "stale" "offline > maxOffline" dashed
box revoked "revoked" "Acme removed the Pi"
arrow pending -> ready "first sync"
arrow ready -> stale "too long offline"
arrow stale -> ready "reconnect"
arrow ready -> revoked "server says revoked"
note "A cache that fails its signature check is no profile: the gate is pending again."
:::

Locked means four things, all through hooks Chord already has or the one kit change below:

- The session worker kind's `start` throws and its synchronous `authorize` refuses: no session runs.
- `admit` lets only the app's own root load: the base, `Settings`, `OrgGate` and the gate page. Neither Acme's plugins
  nor Dana's own load.
- Every setting reads its initial value, and `Settings.set` refuses with "Waiting for Acme".
- The base's own paths (share a session, connect to a peer) refuse.

## First start

:::sequence animate | Dana's Pi on its first start. Nothing outside the app root runs before the accent step.
actor start "start script" "base code"
actor gate "OrgGate" "app root" accent
actor radius "Radius" "org server" blue
actor disk "data dir" muted
start -> start: read /etc/p3/enrollment.json
start -> gate: startServer (admit: app root only)
gate -> radius: follow profile (Pi token)
radius --> gate: signed profile, revision 42
gate -> gate: check signature, member, pi, hashes, pluginSources
gate -> disk: install acme-tools, acme-deploy into the org root
gate => disk: write profile cache (atomic rename)
gate -> start: gate ready: Apply (admit follows the profile)
:::

1. The start script (base code, not a plugin) reads the enrollment file before `startServer`, and the cache if there
   is one. With no cache the gate starts `pending`.
2. `OrgGate` connects to `server` with the Pi's token. Without a token, the gate page asks Dana to sign in with Radius.
3. It checks the profile: the signature against `orgKey`, `org`, `member` and `pi`, every plugin source under
   `pluginSources`. A profile that fails is not used, and the gate page says why.
4. It installs every required plugin at its pinned ref into the org root, and checks each installed tree against its
   `hash`. A required plugin that fails to install or build keeps the gate `pending`, with the reason on the page.
5. It writes the signed profile as the cache, in one atomic rename. This one write is the commit: the managed layer
   is whatever the cache holds.
6. The gate turns `ready`. The base runs Apply: `admit` now follows the profile, so Acme's plugins and Dana's admitted
   ones load, and workers may start.

## Later starts

The start script reads the cache with the enrollment file, before `startServer`, and checks the signature and, if
Acme set `maxOffline`, the age of `issuedAt`. If both hold, the gate is `ready` from the first moment, with no network
wait, and `admit` loads the right plugins at the first discovery. `OrgGate` follows the server in the background.

:::review | Review: the cache is a file, not a Chord document
The consultation kept the cache as a persisted Chord document in the server store. But `admit` runs at the first
discovery, inside `startServer`, before any store object exists. With the cache in the store, every start would load
only the app root first and run a second Apply once the gate reads the cache: a second build pass on every start,
against the decision "Efficiency is a requirement". A file the start script reads synchronously avoids it. A file also
moves with the machine, not with a backup: restoring a backup onto another machine must enroll there, not carry
Acme's profile along.
:::

## Updates

A profile with a higher revision arrives live. Its settings and its plugins apply in a fixed order:

1. **Settings first, at once.** The new cache is written and the gate's profile changes. Every effective setting
   changes in place: the MCP plugin disconnects a server that is now forbidden, the sharing plugin ends shares whose
   audience no longer conforms, the peer plugin closes links outside the audience. Removed plugins unload on the Apply
   that follows.
2. **Plugin additions when installed.** New and updated plugins install into the org root; each loads with the next
   Apply once its hash matches. Until then the previous version keeps running.
3. **A failed install is reported**, to Dana on the page and to Acme through Radius, and retried. It never holds back
   a tightening: a broken new plugin in the same update as a removed MCP server does not keep that server connected.

No restart is needed: the roots stay fixed, and `admit` plus Apply change which plugins are loaded.

:::review | Review: "never half-applied" refined
The consultation applies an update whole or not at all, keeping the last good profile when an install fails. Two
other consultations point out that this lets one broken plugin publish keep a revoked MCP server or an outside share
alive. Settings first, plugins when installed, keeps every tightening immediate; additions wait for their install.
:::

## The one kit change

Today `startServer` fixes the plugin roots to two (`packages/chord/src/node/app/app.ts`, line 348: the app root,
required, and `layout.plugins`) and loads everything discovered. Discovery already lets the first root win a name and
reports the duplicate (`discover.ts`, `discoverPlugins`), so a plugin in a later root cannot shadow an org plugin.

```ts
// PROPOSED · kit change in packages/chord/src/node/app/app.ts. `Plugin` and `PluginRoot` exist in node/plugins/discover.ts.
export type AppOptions<P extends Principal> = {
	// … as today …
	readonly plugins?: {
		/** Roots after the app's own, in order; the first root wins a plugin name. Default: the user's root. */
		readonly roots?: readonly PluginRoot[];
		/** Read at every discovery: whether a discovered plugin loads. Default: every plugin. */
		readonly admit?: (plugin: Plugin) => boolean;
	};
};

export type AppPlugins = {
	// … as today …
	/** Marks that `admit` may answer differently now: the next `applyChanges` discovers again. */
	readmit(): void;
};
```

`readmit` belongs to the same change. Today `applyChanges` builds the dirty plugins and discovers again only when the
watcher saw files change (`plugins.ts`, `needsDiscovery`); a gate that turns `ready` changes no file, so the base
says so before its Apply.

```ts
// PROPOSED · apps/p3/src/server.ts (base code). Chord API: startServer, App.host, Host.get, reference members' .value.
const start = readStart(ENROLLMENT_PATH, dataDir);      // sync: enrollment, cache, signature, maxOffline, verified hashes
let held: Reference<typeof OrgGate> | undefined;
let plugins: Reference<typeof Plugins> | undefined;
const gate = () => held?.gate.value ?? start.gate;      // the start read until OrgGate is live
// What `admits` needs: the gate, the verified org plugins, the effective `p3.plugins.own` (chapter IV, admit.ts).
const admitState = () => ({ gate: gate(), verified: plugins?.verified.value ?? start.verified, ownPlugins: own() });

const app = await startServer<P3Principal>({
	name: "p3",
	dataDir,
	// … api, kinds, principal, web …
	workers: [{ ...sessionKind, authorize: (principal, address) => isOpen(gate()) && mayUse(principal, address) }],
	plugins: {
		roots: [orgRoot(dataDir), memberRoot(dataDir)],
		admit: (plugin) => admits(admitState(), plugin, roots),
	},
}, context);
held = await app.host.get(OrgGate, {}, context);
plugins = await app.host.get(Plugins, {}, context);
```

`own()` reads the effective `p3.plugins.own`: from the cached profile before the host is up, from `Settings` after.
`admits` (`apps/p3/src/admit.ts`, in chapter IV) is a few lines. The app root always loads. Nothing else loads while the gate is locked. In the org root, a
plugin loads when its name is an org entry of `p3.plugins` and its tree matched its hash. In the member root, a
plugin loads when the Pi is unmanaged, or when the effective `p3.plugins.own` is `true`.

`p3.plugins.own` is how "no agent-written plugins" becomes enforceable: not by tracking who wrote a file, which no
check can know, but by loading only approved builds. An org plugin edited in place no longer matches its hash: the base
checks the org root's hashes at start and before each Apply, and an edited plugin stays out until it is installed
again.

## The gate object

`OrgGate` owns the connection to the org server as a native, follows it, and runs installs and Apply in a routine.

```ts
// PROPOSED · plugins/org/server.ts (app root). Chord API: local, self.open, self.follow, self.get, self.derive,
// self.on. `OrgClient` (base code) reads the enrollment file and the cache, follows the server with backoff, checks
// profiles, and writes the cache by atomic rename; `Plugins` is the plugin service of chapter IV.
host.serve(OrgGate, (_params, self) => {
	const client = self.open((ctx) => openOrgClient(ctx), (c) => c.close());
	// { enrollment, cached, offered, revoked, live, now }: the client's observer, attached once it opened.
	const org = self.follow((observer, ctx) => client.value.attach(observer, ctx));
	const plugins = self.get(Plugins, {});
	const offered = self.derive([org], ([o]) => o.offered);   // a checked profile newer than the cache, or null
	self.on(offered, async ({ value }, ctx) => {
		if (value === null) return;
		const first = org.value.cached === null;
		// First sync: required plugins install before anything opens; a throw leaves the gate pending.
		if (first) {
			const failed = await plugins.reconcile(orgPlugins(value), ctx);
			if (failed.length > 0) throw new PluginError("required_failed", failed.map((f) => `${f.name}: ${f.error}`).join("; "));
		}
		await client.value.commit(value, ctx);                  // the cache is the managed layer: settings apply now
		// Updates: settings first, plugins when installed; failures are reported and retried, never thrown.
		if (!first) await plugins.reconcile(orgPlugins(value), ctx);
		await plugins.apply(null, ctx);                         // recheck hashes, readmit, the kit's applyChanges
	});
	return { gate: self.derive([org], ([o]) => gateOf(o)) };
});
```

`gateOf` is the table of five states as a pure function. The first sync is the same routine: with no cache, `offered`
is the first profile, and the cache is written only after `reconcile` installed the required plugins. When the
routine throws, the client offers the profile again after its backoff.

# Acme End to End {#e2e lede="What Acme's admin types into Radius, the files that come out of it, the code they pass through, and eight traces from a click or a tool call to what Dana and her agent see."}

The chapters so far describe the mechanism. This one shows all of it at once, for one org: what the admin fills in,
the two documents that result, every file of p3 that takes part, and what happens, line by line, in the eight cases
an org cares about. Every code block is PROPOSED and names its path as it would be in `apps/p3`; every Chord call in it
exists on origin/main (checked again for this edition: `local`, `remote`, `hostKind`, `method`, `defineState` with
`persist` and `checkpointWhen`, `defineRegistry`, `keyedEntries`, `StoreSelf.state`, `self.registry`, `self.get`,
`self.derive`, `self.on`, `self.onLive`, `self.open`, `self.follow`, `self.writable`, `self.contribute`, `PluginError`,
`forbidden`,
`useHold`, `useWatch`). Names from pi's other packages are real too: Durable's `defineTool` and its
`ToolExecutionResult`, pi-mcp's `McpClient`, `StreamableHttpTransport`, `createMcpToolName`, `toLlmContent`,
pi-schema's `compile`.

## What the admin fills in

Acme's admin opens the org's page in Radius. Each field becomes one place in the profile:

| Section | Field | Acme's value | Becomes |
| --- | --- | --- | --- |
| Org | Name, id | Acme, `acme` | `orgName`, `org` |
| Org | Signing key | `acme-2026-11` (see Open Questions) | `signature.key` |
| Org | Plugin sources | `github.com/acme/` | `pluginSources` of the enrollment file |
| Assignment | Profile per group | everyone in `acme-staff` | one profile per member and Pi |
| Plugins | Name, source (git URL and ref, or npm name and version), Required or Allowed | `acme-tools` and `acme-deploy` required, `acme-reviews` allowed | `p3.plugins` entries; Radius fetches each source and computes its `hash` on save |
| Plugins | Members may add or write plugins | off | `p3.plugins` locked, `p3.plugins.own` locked `false` |
| MCP servers | Name, URL, credential (a Radius connection), "only these servers" | Jira, Linear; only these | `mcp.servers` entries, locked |
| Models | Providers, "only these" | Radius gateway; only this | `models.providers` entries, locked |
| Sharing | Sessions may be shared with: anyone, members of Acme, nobody; locked | members of Acme; locked | `p3.sharing.audience` |
| Peers | Pis this Pi may connect to: any, Acme's, none; locked | Acme's; locked | `p3.peers.audience` |
| Instructions | Name, text, members may add their own | `acme`; yes | `prompt.instructions` entries, default |
| Offline | Lock a Pi after this many days without Radius | off | `maxOffline` |
| Environments | Kinds allowed; folders that may be mounted (path, writable); hosts sandboxes may reach | sandboxes only; `~/work/acme` writable, `~/Documents/acme-specs` read-only; GitHub, npm, `*.acme.internal` | `environments.kinds`, `sandbox.folders`, `sandbox.allowHosts`, locked (chapter VI) |
| Restriction plugins | Earendil's catalog and Acme's own; each with its settings | sandbox environments; tool rules blocking `mcp__linear__delete_*` and `session_export` | required `p3.plugins` entries; `toolRules.blocked` (chapter VI) |
| Other settings | Setting name, value, lock | `deploy.targets`: staging and production, locked | `settings["deploy.targets"]` |

The last row is what makes the design flexible: any setting any approved plugin declares can be managed, not a fixed
list of switches. Radius learns the names and schemas from the Pis: after each sync a Pi reports the `SettingKinds` of
its loaded plugins (name, merge kind, JSON schema), and the form for `deploy.targets` is generated from that schema and
checked against it on save.

## The profile Radius signs

This is Dana's profile, complete. Hashes and the key are shortened; nothing else is left out.

```json
// PROPOSED · served by Radius at GET /orgs/acme/pis/pi_7f3a/profile
{
  "payload": {
    "org": "acme",
    "orgName": "Acme",
    "member": "dana@acme.com",
    "pi": "pi_7f3a",
    "deviceKey": "p256:BHk2…",
    "revision": 42,
    "issuedAt": "2026-12-18T09:00:00Z",
    "maxOffline": null,
    "settings": {
      "p3.plugins": {
        "lock": "locked",
        "value": {
          "acme-tools": {
            "source": { "git": "https://github.com/acme/p3-tools", "ref": "v1.4.0" },
            "hash": "sha256-9c1e…",
            "required": true
          },
          "acme-deploy": {
            "source": { "git": "https://github.com/acme/p3-deploy", "ref": "v0.9.2" },
            "hash": "sha256-41b0…",
            "required": true
          },
          "acme-reviews": {
            "source": { "git": "https://github.com/acme/p3-reviews", "ref": "v2.0.1" },
            "hash": "sha256-77de…",
            "required": false
          }
        }
      },
      "p3.plugins.own": { "lock": "locked", "value": false },
      "mcp.servers": {
        "lock": "locked",
        "value": {
          "jira": { "url": "https://mcp.atlassian.com/v1/sse", "auth": { "radius": "jira" } },
          "linear": { "url": "https://mcp.linear.app/mcp", "auth": { "radius": "linear" } }
        }
      },
      "models.providers": {
        "lock": "locked",
        "value": {
          "radius": { "kind": "radius", "auth": { "radius": "models" } }
        }
      },
      "p3.sharing.audience": { "lock": "locked", "value": "org" },
      "p3.peers.audience": { "lock": "locked", "value": "org" },
      "prompt.instructions": {
        "lock": "default",
        "value": {
          "acme": {
            "text": "Acme code is reviewed on GitHub before merge. Never paste customer data into issues or chats."
          }
        }
      },
      "deploy.targets": {
        "lock": "locked",
        "value": {
          "staging": { "host": "deploy.staging.acme.internal", "branch": "main", "approval": "none" },
          "production": { "host": "deploy.acme.internal", "branch": "release", "approval": "review" }
        }
      }
    }
  },
  "signature": { "alg": "ed25519", "key": "acme-2026-11", "value": "Zm9vYmFy…" }
}
```

The signature covers the canonical JSON of `payload` (keys sorted, no whitespace). `deviceKey` is the public half of
the key Dana's Pi made at enrollment (chapter VI); Radius serves the profile, and every org resource, only to a Pi that
proves it holds the private half.

## The enrollment file

The same as in chapter I, complete:

```json
// PROPOSED · /etc/p3/enrollment.json, owner root, mode 0644, parent directories root-owned
{
  "org": "acme",
  "name": "Acme",
  "server": "https://radius.example.com/orgs/acme",
  "orgKey": "ed25519:MCowBQYDK2VwAyEAq4…",
  "pluginSources": ["https://github.com/acme/", "https://github.com/earendil-works/"]
}
```

## The files that take part

| Path | What it holds |
| --- | --- |
| `apps/p3/app/v1/hosts.ts` | the host kinds: `Server`, `Session` |
| `apps/p3/app/v1/settings.ts` | `defineSetting`, `SettingKinds`, `Settings`, `SettingsView`, `setting()`, `refusedBy()` |
| `apps/p3/plugins/settings/server.ts` | the registry's provider, the store, the view |
| `apps/p3/app/v1/org.ts` | `OrgGate` and the `Gate` and `Profile` schemas |
| `apps/p3/plugins/org/server.ts` | `OrgGate` (chapter III) |
| `apps/p3/app/v1/plugins.ts` | `PluginEntries`, `OwnPlugins`, `Plugins`, `PluginsView` |
| `apps/p3/plugins/plugins/server.ts` | the only path that installs, writes and applies plugins |
| `apps/p3/src/org/roots.ts` | the org root and the member root under the data directory; the verified-hashes file |
| `apps/p3/src/org/tree-hash.ts` | the plugin tree hash (Radius runs the same function) |
| `apps/p3/src/admit.ts` | `admits`, the function the kit asks at every discovery |
| `apps/p3/src/server.ts` | the start script (chapter III) |
| `apps/p3/plugins/harness/refusals.ts` | how any refusal becomes a tool result for the model |
| `apps/p3/plugins/mcp/contract.ts`, `server.ts`, `worker.ts`, `web.tsx` | the MCP plugin |
| `apps/p3/plugins/sharing/contract.ts`, `server.ts` | sharing |
| `github.com/acme/p3-deploy`: `contract.ts`, `server.ts` | Acme's own deploy plugin |

## Settings: the contract

```ts
// PROPOSED · apps/p3/app/v1/settings.ts
// The settings contract (`@p3/app/v1/settings`): how plugins declare settings, the registry of declared settings,
// the server's store, the view pages and session agents use, and `setting()` for server objects.

import {
	arr, defineRegistry, lit, local, map, method, obj, oneOf, PluginError, remote, type Schema, type Self, type Static,
	str, type TableItem, union, unknown, type Watchable,
} from "@earendil-works/chord";
import type { JsonValue } from "@earendil-works/chord/json";
import { compile, type Validator } from "@earendil-works/pi-schema";
import { Server } from "./hosts.ts";

/** A declared setting as the registry and the store see it. */
export type SettingKind = {
	readonly name: string;
	readonly merge: "value" | "entries";
	readonly initial: JsonValue;
	/** Reported to the org server, which renders its form from it. */
	readonly schema: Schema;
	/** Checks a whole value (an entries setting: the whole record); compiled once, at declaration. */
	readonly validator: Validator;
};

/** A declared setting with its value type. */
export type Setting<T extends JsonValue> = SettingKind & { readonly initial: T };

/** Declares a setting; its plugin contributes it to `SettingKinds` and reads it with `setting(self, token)`. */
export function defineSetting<S extends Schema>(
	name: string,
	schema: S,
	options: { readonly merge: "value" | "entries"; readonly initial: Static<S> & JsonValue },
): Setting<Static<S> & JsonValue> {
	return { name, merge: options.merge, initial: options.initial, schema, validator: compile(schema) };
}

/** Every declared setting by name, with its plugin; a name declared twice is reported, the first by plugin name kept. */
export const SettingKinds = defineRegistry<readonly SettingKind[], ReadonlyMap<string, TableItem<SettingKind>>>(
	"p3.setting-kinds",
	{ version: 1 },
);

/** How the org manages one setting: what pages draw and the agent is told. */
export const ManagedMark = obj({ orgName: str(), lock: oneOf("default", "locked"), entries: arr(str()) });

/** One write: a value setting's whole value, or one entry of an entries setting (`null` removes it). */
export const SettingWrite = union([
	obj({ kind: lit("value"), name: str(), value: unknown() }),
	obj({ kind: lit("entry"), name: str(), entry: str(), value: unknown() }),
]);

export type SettingWrite = Static<typeof SettingWrite>;

/** The settings store, on the server: the only writer of the member's values (server objects only). */
export const Settings = local("p3.settings", {
	version: 1,
	params: {},
	members: {
		/** Effective values by setting name. */
		effective: map(unknown()),
		/** The settings the org manages. */
		managed: map(ManagedMark),
		set: method(SettingWrite),
	},
});

/** The store for the owner's page and terminal and the owner's session agents. */
export const SettingsView = remote("p3.settings-view", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: {
		main: {
			state: { effective: map(unknown()), managed: map(ManagedMark) },
			methods: { set: method(SettingWrite) },
		},
	},
});

/** A setting's effective value, for any server object. */
export function setting<T extends JsonValue>(self: Self, token: Setting<T>): Watchable<T> {
	const all = self.get(Settings, {}).effective;
	// Cast: `set` and the profile check validated the value against this token's schema.
	return self.derive([all], ([values]) => (values[token.name] ?? token.initial) as T);
}

/** The error a plugin throws when an effective setting forbids an action; pages and the harness say who manages it. */
export function refusedBy(token: SettingKind, message: string): PluginError {
	return new PluginError("refused_by_setting", message, { setting: token.name });
}
```

`refusedBy` is the only thing a plugin may use that sounds like policy, and it says nothing about orgs: it names the
setting that forbade the action. Whether that setting is Dana's own choice or Acme's lock is for the page and the
harness to say, from `managed`.

## Settings: the store

```ts
// PROPOSED · apps/p3/plugins/settings/server.ts (app root)
// The registry of declared settings, the store of the member's values with the managed layer on top, and the view.

import { defineState, forbidden, keyedEntries, map, obj, PluginError, unknown } from "@earendil-works/chord";
import type { JsonValue } from "@earendil-works/chord/json";
import { defineFacet, type P3Principal } from "@p3/app/v1";
import { type Gate, type ManagedSetting, OrgGate } from "@p3/app/v1/org";
import { type SettingKind, SettingKinds, Settings, SettingsView, type SettingWrite } from "@p3/app/v1/settings";

const UserLayer = defineState("p3.settings.user", {
	schema: obj({ values: map(unknown()) }),
	version: 1,
	initial: () => ({ values: {} }),
	persist: true,
	checkpointWhen: () => true,
});

export default defineFacet<P3Principal>((host) => {
	host.serve(SettingKinds, {
		compose: (table, context) =>
			keyedEntries(table, (kinds) => Object.fromEntries(kinds.map((kind) => [kind.name, kind])), context.report),
	});

	host.serve(Settings, (_params, self) => {
		const user = self.state(UserLayer);
		const kinds = self.registry(SettingKinds);
		const gate = self.get(OrgGate, {}).gate;
		return {
			effective: self.derive([user, kinds, gate], ([mine, declared, now]) => effectiveAll(mine.values, declared, now)),
			managed: self.derive([gate], ([now]) => managedMarks(now)),
			set: async (write, ctx) => {
				// Followed state, read per call: a profile that arrived since the page rendered counts.
				const kind = writable(write, kinds.value.get(write.name)?.value, gate.value);
				const next = write.kind === "value" ? write.value : withEntry(user.value.values[write.name], write.entry, write.value);
				// Trust boundary: the page's and the agent's input, checked against the declaring plugin's schema.
				const checked = kind.validator.validate(next);
				if (!checked.ok) throw new PluginError("invalid_value", `Invalid value for ${write.name}`, { errors: checked.errors });
				await user.change((draft) => {
					draft.values[write.name] = next;
				}, ctx);
			},
		};
	});

	host.serve(SettingsView, (_params, principal, self) => {
		// The owner (page, terminal) and the owner's session workers; a guest never writes settings.
		if (principal.kind !== "user" && principal.kind !== "worker") throw forbidden("Settings are the owner's");
		const settings = self.get(Settings, {});
		return {
			variant: "main",
			members: { effective: settings.effective, managed: settings.managed, set: (write, ctx) => settings.set(write, ctx) },
		};
	});
});

/** The declared setting `write` may change, or the refusal. */
function writable(write: SettingWrite, kind: SettingKind | undefined, gate: Gate): SettingKind {
	if (gate.kind !== "unmanaged" && gate.kind !== "ready")
		throw new PluginError("gated", `Waiting for ${gate.orgName}`, { setting: write.name });
	if (kind === undefined) throw new PluginError("unknown_setting", `No setting ${write.name}`);
	const managed = gate.kind === "ready" ? gate.profile.settings[write.name] : undefined;
	if (managed === undefined) return kind;
	const orgName = gate.profile.orgName;
	if (managed.lock === "locked")
		throw new PluginError("managed", `Managed by ${orgName}: ${write.name} is locked`, { setting: write.name });
	if (write.kind === "entry" && kind.merge === "entries" && Object.hasOwn(managedEntries(managed), write.entry))
		throw new PluginError("managed", `Managed by ${orgName}: the entry ${write.entry} of ${write.name}`, {
			setting: write.name,
			entry: write.entry,
		});
	return kind;
}

/** Every declared setting's effective value: the table in chapter II. */
function effectiveAll(
	mine: Readonly<Record<string, JsonValue>>,
	declared: ReadonlyMap<string, { readonly value: SettingKind }>,
	gate: Gate,
): Record<string, JsonValue> {
	const open = gate.kind === "unmanaged" || gate.kind === "ready";
	const layer = gate.kind === "ready" ? gate.profile.settings : {};
	const out: Record<string, JsonValue> = {};
	for (const [name, { value: kind }] of declared) {
		out[name] = open ? effectiveOf(kind, layer[name], mine[name]) : kind.initial;
	}
	return out;
}

/** One setting's effective value from the org's entry (if any) and the member's value (if any). */
function effectiveOf(kind: SettingKind, managed: ManagedSetting | undefined, mine: JsonValue | undefined): JsonValue {
	if (managed === undefined) return mine ?? kind.initial;
	// An org value that fails the plugin's schema: a lock reads as the initial value, a default as absent (reported at sync).
	const valid = kind.validator.check(managed.value);
	if (managed.lock === "locked") return valid ? managed.value : kind.initial;
	if (!valid) return mine ?? kind.initial;
	if (kind.merge === "value") return mine ?? managed.value;
	// Cast: an entries setting's values are records (its schema is a `map`).
	return { ...((mine ?? {}) as Record<string, JsonValue>), ...(managed.value as Record<string, JsonValue>) };
}
```

`managedMarks`, `managedEntries` and `withEntry` are three-line helpers: the marks are `{ orgName, lock, entries:
Object.keys(value) }` per managed setting, and `withEntry` copies the member's record with one entry put or deleted.
The member's own entry named like an org entry stays stored and is hidden by the spread, so it comes back if Acme ever
drops its entry.

## The org contract

```ts
// PROPOSED · apps/p3/app/v1/org.ts
// The gate's contract and schemas (`@p3/app/v1/org`): the org's managed settings as the profile carries them, and the
// five states of the gate.

import { bool, lit, local, map, nul, num, obj, oneOf, type Static, str, union, unknown } from "@earendil-works/chord";

/** One managed setting in a profile. */
export const ManagedSetting = obj({ lock: oneOf("default", "locked"), value: unknown() });

/** A profile's payload, after the signature, the member, the Pi and the plugin sources were checked. */
export const Profile = obj({
	org: str(),
	orgName: str(),
	member: str(),
	pi: str(),
	deviceKey: str(),
	revision: num(),
	issuedAt: str(),
	maxOffline: union([num(), nul()]),
	settings: map(ManagedSetting),
});

/** The Pi's org state. */
export const Gate = union([
	obj({ kind: lit("unmanaged") }),
	obj({ kind: lit("pending"), org: str(), orgName: str(), why: str() }),
	obj({ kind: lit("ready"), orgName: str(), profile: Profile, live: bool() }),
	obj({ kind: lit("stale"), orgName: str(), profile: Profile }),
	obj({ kind: lit("revoked"), org: str(), orgName: str() }),
]);

export type Gate = Static<typeof Gate>;
export type ManagedSetting = Static<typeof ManagedSetting>;

/** The Pi's org state, on the server. */
export const OrgGate = local("p3.org-gate", { version: 1, params: {}, members: { gate: Gate } });
```

## Plugins: the only install path

```ts
// PROPOSED · apps/p3/app/v1/plugins.ts
// The plugin settings and the plugin service (`@p3/app/v1/plugins`): installs, writes and Apply go only through it.

import { arr, bool, lit, local, map, method, nul, obj, oneOf, remote, type Static, str, union } from "@earendil-works/chord";
import { Server } from "./hosts.ts";
import { defineSetting } from "./settings.ts";

export const PluginSource = union([
	obj({ git: str(), ref: str() }),
	obj({ npm: str(), version: str() }),
]);

/** An installed plugin's source, its tree hash (`null`: not pinned, member installs only) and whether it is required. */
export const PluginEntry = obj({ source: PluginSource, hash: union([str(), nul()]), required: bool() });

export type PluginEntry = Static<typeof PluginEntry>;

/** The plugins installed from a pinned source: the org's into the org root, the member's into the member root. */
export const PluginEntries = defineSetting("p3.plugins", map(PluginEntry), { merge: "entries", initial: {} });

/** Whether the member root loads: plugins the member installs from any source, and plugins the agent writes. */
export const OwnPlugins = defineSetting("p3.plugins.own", bool(), { merge: "value", initial: true });

export const CatalogItem = obj({
	name: str(),
	from: oneOf("app", "org", "member"),
	required: bool(),
	state: oneOf("loaded", "available", "left-out", "failed"),
	why: union([str(), nul()]),
});

export const InstallRequest = union([
	obj({ kind: lit("catalog"), name: str() }),
	obj({ kind: lit("source"), source: PluginSource }),
]);

export const PluginFile = obj({ plugin: str(), path: str(), content: str() });

/** The plugin service on the server. */
export const Plugins = local("p3.plugins", {
	version: 1,
	params: {},
	members: {
		catalog: arr(CatalogItem),
		/** Names and tree hashes of the org root's plugins that matched their profile entry. */
		verified: map(str()),
		install: method(InstallRequest),
		write: method(PluginFile),
		reconcile: method(map(PluginEntry), arr(obj({ name: str(), error: str() }))),
		apply: method(),
	},
});

/** The same for the owner's page and terminal and the owner's session agents (the plugin tools). */
export const PluginsView = remote("p3.plugins-view", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: {
		main: {
			state: { catalog: arr(CatalogItem) },
			methods: { install: method(InstallRequest), write: method(PluginFile), apply: method() },
		},
	},
});
```

```ts
// PROPOSED · apps/p3/plugins/plugins/server.ts (app root)
// The plugin service: installs into the right root, checks org plugins against their hash, writes agent plugins, and
// runs Apply. `PluginManager` is the kit's platform binding (base inventory #14): install, readmit, apply, discovered.

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { forbidden, PluginError } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import { defineFacet, type P3Principal, PluginManager } from "@p3/app/v1";
import { OrgGate } from "@p3/app/v1/org";
import { OwnPlugins, PluginEntries, type PluginEntry, Plugins, PluginsView } from "@p3/app/v1/plugins";
import { refusedBy, Settings, setting } from "@p3/app/v1/settings";
import { MEMBER_ROOT, ORG_ROOT, readVerified, writeVerified } from "../../src/org/roots.ts";
import { treeHash } from "../../src/org/tree-hash.ts";

export default defineFacet<P3Principal>((host) => {
	host.serve(Plugins, (_params, self) => {
		const kit = self.get(PluginManager, {});
		const settings = self.get(Settings, {});
		const entries = setting(self, PluginEntries);
		const own = setting(self, OwnPlugins);
		const gate = self.get(OrgGate, {}).gate;
		const stored = self.open(() => readVerified(ORG_ROOT), () => {});
		const verified = self.writable<Readonly<Record<string, string>>>({});
		// The start script read the same file for its first discovery; this copy serves the catalog and later Applies.
		self.onLive(() => verified.set(stored.value));

		/** Installs an org entry into the org root and keeps it only if its tree matches the entry's hash. */
		const installOrg = async (name: string, entry: PluginEntry, ctx: Context) => {
			await kit.install({ source: entry.source, root: ORG_ROOT }, ctx);
			const actual = await treeHash(join(ORG_ROOT, name));
			if (actual !== entry.hash) {
				await rm(join(ORG_ROOT, name), { recursive: true, force: true });
				throw new PluginError("hash_mismatch", `${name}: the installed tree is not the approved build`);
			}
			const next = { ...verified.value, [name]: actual };
			await writeVerified(ORG_ROOT, next);                  // read by the start script at the next start
			verified.set(next);
		};

		return {
			catalog: self.derive([kit.discovered, entries, settings.managed, gate, verified], (values) => catalogOf(...values)),
			verified: self.derive([verified], ([v]) => v),
			install: async (request, ctx) => {
				const mark = settings.managed.value[PluginEntries.name];
				if (request.kind === "catalog") {
					// Only the org's entries are in the catalog to install from by name.
					if (!mark?.entries.includes(request.name)) throw new PluginError("unknown_plugin", `${request.name} is not in the catalog`);
					await installOrg(request.name, entries.value[request.name]!, ctx);
				} else {
					if (!own.value) throw refusedBy(OwnPlugins, "Plugins from other sources do not load on this Pi");
					if (mark?.lock === "locked") throw refusedBy(PluginEntries, "Only the catalog's plugins can be installed");
					const [name] = await kit.install({ source: request.source, root: MEMBER_ROOT }, ctx);
					await settings.set({ kind: "entry", name: PluginEntries.name, entry: name!, value: { source: request.source, hash: null, required: false } }, ctx);
				}
				await kit.readmit(ctx);
				await kit.apply(ctx);
			},
			write: async ({ plugin, path, content }, ctx) => {
				if (!own.value) throw refusedBy(OwnPlugins, "Plugins written on this Pi do not load");
				await writePluginFile(MEMBER_ROOT, plugin, path, content, ctx);   // stays inside the member root
			},
			reconcile: async (wanted, ctx) => {
				const failures: { name: string; error: string }[] = [];
				// `wanted` comes from the offered profile: at the first sync it is not the effective value yet.
				for (const [name, entry] of Object.entries(wanted)) {
					const installed = Object.hasOwn(verified.value, name);
					if (verified.value[name] === entry.hash || (!entry.required && !installed)) continue;
					await installOrg(name, entry, ctx).catch((error: Error) => failures.push({ name, error: error.message }));
				}
				await removeUnlisted(ORG_ROOT, wanted, ctx);          // dropped by the org: gone at the next Apply
				return failures;
			},
			apply: async (_args, ctx) => {
				// An org plugin edited in place no longer matches its hash: it is dropped from `verified` and left out.
				verified.set(await recheck(ORG_ROOT, verified.value));
				await kit.readmit(ctx);
				await kit.apply(ctx);
			},
		};
	});

	host.serve(PluginsView, (_params, principal, self) => {
		if (principal.kind !== "user" && principal.kind !== "worker") throw forbidden("Plugins are the owner's");
		const plugins = self.get(Plugins, {});
		return {
			variant: "main",
			members: {
				catalog: plugins.catalog,
				install: (request, ctx) => plugins.install(request, ctx),
				write: (file, ctx) => plugins.write(file, ctx),
				apply: (_args, ctx) => plugins.apply(null, ctx),
			},
		};
	});
});
```

`catalogOf` lists every discovered plugin and every catalog entry with its state, and for each plugin that is not
loaded it runs the same `admits` the kit runs and says why: "not in Acme's catalog", "edited since it was installed",
"plugins written on this Pi do not load (managed by Acme)".

```ts
// PROPOSED · apps/p3/src/admit.ts (base code)
// Which discovered plugins load: the kit asks `admits` at every discovery (the kit change of chapter III).

import type { Plugin } from "@earendil-works/chord/plugins";
import type { Gate } from "../app/v1/org.ts";

/** What admission depends on: the gate, the org root's verified hashes, and the effective `p3.plugins.own`. */
export type AdmitState = {
	readonly gate: Gate;
	readonly verified: Readonly<Record<string, string>>;
	readonly ownPlugins: boolean;
};

export type Roots = { readonly app: string; readonly org: string; readonly member: string };

/** Whether `plugin` loads now. */
export function admits(state: AdmitState, plugin: Plugin, roots: Roots): boolean {
	if (plugin.root === roots.app) return true;
	const { gate } = state;
	if (gate.kind === "unmanaged") return true;
	if (gate.kind !== "ready") return false;
	if (plugin.root === roots.org) {
		// Cast: `p3.plugins` passed its schema when the profile was checked.
		const entry = (gate.profile.settings["p3.plugins"]?.value as Record<string, { hash: string }> | undefined)?.[plugin.name];
		return entry !== undefined && state.verified[plugin.name] === entry.hash;
	}
	return state.ownPlugins;
}
```

```ts
// PROPOSED · apps/p3/src/org/tree-hash.ts (base code; Radius runs the same function when the admin saves a plugin)

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** sha256 over a plugin's files: sorted relative paths, each with its length and bytes; `.git` and `node_modules` left out. */
export async function treeHash(dir: string): Promise<string> {
	const files = (await readdir(dir, { recursive: true, withFileTypes: true }))
		.filter((entry) => entry.isFile())
		.map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
		.filter((path) => !path.startsWith(".git/") && !path.includes("node_modules/"))
		.sort();
	const hash = createHash("sha256");
	for (const path of files) {
		const bytes = await readFile(join(dir, path));
		hash.update(`${path}\0${bytes.length}\0`);
		hash.update(bytes);
	}
	return `sha256-${hash.digest("hex")}`;
}
```

The hash covers the plugin's own files, including its `package-lock.json`; `npm install` (run by the kit with
`--ignore-scripts`) checks every dependency against the integrity hashes in that lockfile. A plugin without a lockfile
cannot be pinned, and Radius refuses to save it as an org plugin.

## How a refusal reaches the model

```ts
// PROPOSED · apps/p3/plugins/harness/refusals.ts (app root, worker side)
// Every tool error goes through `toolError`: a refusal that names a setting tells the model who manages it and that
// retrying will not help.

import { PluginError } from "@earendil-works/chord";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import type { ManagedMark } from "@p3/app/v1/settings";

/** The tool result for `error`, with `managed` (the view's marks) to say who manages the setting it names. */
export function toolError(error: unknown, managed: Readonly<Record<string, ManagedMark>>): ToolExecutionResult {
	if (!(error instanceof PluginError)) return text(error instanceof Error ? error.message : String(error));
	// Wire input: `details` came over a link.
	const setting = typeof error.details === "object" && error.details !== null && "setting" in error.details ? String(error.details.setting) : undefined;
	const mark = setting === undefined ? undefined : managed[setting];
	if (mark === undefined) return text(error.message);
	return text(
		`${error.message}. The setting ${setting} is managed by ${mark.orgName}` +
			(mark.lock === "locked" ? " and locked" : "") +
			`. Do not retry or look for another way; tell the user to ask ${mark.orgName}'s admin.`,
	);
}

function text(message: string): ToolExecutionResult {
	return { output: [{ type: "text", text: message }], isError: true };
}
```

The last sentence matters. Without it, a model told "refused" tries the next way: edit a config file, write a plugin,
run a command. With it, the model stops and tells Dana.

## The MCP plugin

```ts
// PROPOSED · apps/p3/plugins/mcp/contract.ts
// The MCP plugin's setting, its connections on the server, and their tools for session workers.

import { arr, local, map, method, nul, obj, oneOf, opt, remote, str, union, unknown } from "@earendil-works/chord";
import { Server } from "@p3/app/v1/hosts";
import { defineSetting } from "@p3/app/v1/settings";

/** One server: its URL and how it signs in (a Radius connection, a secret by name, or nothing). Never a credential. */
export const McpServerConfig = obj({
	url: str(),
	auth: union([nul(), obj({ radius: str() }), obj({ secret: str() })]),
});

export const McpServers = defineSetting("mcp.servers", map(McpServerConfig), { merge: "entries", initial: {} });

export const McpTool = obj({ server: str(), name: str(), description: str(), inputSchema: unknown() });

export const McpCall = obj({ server: str(), tool: str(), args: unknown() });

/** The connections, on the server. */
export const McpConnections = local("mcp.connections", {
	version: 1,
	params: {},
	members: {
		status: map(obj({ state: oneOf("connected", "failed"), error: opt(str()) })),
		tools: arr(McpTool),
		call: method(McpCall, unknown()),
	},
});

/** The tools for the owner's session workers. */
export const McpToolsView = remote("mcp.tools", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { main: { state: { tools: arr(McpTool) }, methods: { call: method(McpCall, unknown()) } } },
});
```

```ts
// PROPOSED · apps/p3/plugins/mcp/server.ts
// The connections: one MCP client per effective server, reconciled whenever the effective `mcp.servers` changes.

import { forbidden, PluginError, type Reference } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { McpClient, StreamableHttpTransport, type Tool } from "@earendil-works/pi-mcp";
import { defineFacet, type P3Principal } from "@p3/app/v1";
import { RadiusAuth } from "@p3/radius/contract";
import { SettingKinds, setting } from "@p3/app/v1/settings";
import { McpConnections, type McpServerConfig, McpServers, McpToolsView } from "./contract.ts";

type Live =
	| { readonly kind: "connected"; readonly config: McpServerConfig; readonly client: McpClient; readonly tools: readonly Tool[] }
	| { readonly kind: "failed"; readonly config: McpServerConfig; readonly error: string };

export default defineFacet<P3Principal>((host, facet) => {
	facet.contribute(SettingKinds, [McpServers]);

	host.serve(McpConnections, (_params, self) => {
		const servers = setting(self, McpServers);              // Acme's entries, plus Dana's unless locked
		const radius = self.get(RadiusAuth, {});
		const pool = self.open(
			async () => new Map<string, Live>(),
			async (live) => { for (const each of live.values()) if (each.kind === "connected") await each.client.close(); },
		);
		const snapshot = self.writable<ReadonlyMap<string, Live>>(new Map());

		// The same routine serves Dana's edits, Acme's updates and the first start.
		self.on(servers, async ({ value: wanted }) => {
			const live = pool.value;
			for (const [name, each] of live) {
				if (JSON.stringify(wanted[name]) === JSON.stringify(each.config)) continue;
				live.delete(name);
				// Removed or changed: calls in flight fail with McpConnectionClosedError.
				if (each.kind === "connected") await each.client.close();
			}
			for (const [name, config] of Object.entries(wanted)) {
				if (!live.has(name)) live.set(name, await connect(config, radius));
			}
			snapshot.set(new Map(live));
		});

		return {
			status: self.derive([snapshot], ([live]) =>
				Object.fromEntries([...live].map(([name, each]) => [name, each.kind === "connected" ? { state: "connected" } : { state: "failed", error: each.error }])),
			),
			tools: self.derive([snapshot], ([live]) =>
				[...live].flatMap(([server, each]) =>
					each.kind === "connected"
						? each.tools.map((tool) => ({ server, name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema }))
						: [],
				),
			),
			call: async ({ server, tool, args }, ctx) => {
				const each = pool.value.get(server);
				if (each?.kind !== "connected") throw new PluginError("mcp_unavailable", `MCP server ${server} is not connected`);
				// Cast: MCP arguments are a JSON object; the tool's input schema was checked by the harness.
				return each.client.callTool(tool, args as Record<string, unknown>, { signal: ctx.abortSignal });
			},
		};
	});

	host.serve(McpToolsView, (_params, principal, self) => {
		if (principal.kind !== "worker" && principal.kind !== "user") throw forbidden("MCP tools are for the owner's sessions");
		const connections = self.get(McpConnections, {});
		return { variant: "main", members: { tools: connections.tools, call: (args, ctx) => connections.call(args, ctx) } };
	});
});

/** A connected client, or the reason it is not; never throws, so one bad server does not stop the others. */
async function connect(config: McpServerConfig, radius: Reference<typeof RadiusAuth>): Promise<Live> {
	const client = new McpClient({ name: "p3", version: "1" });
	const auth = config.auth;
	try {
		await client.connect(
			new StreamableHttpTransport({
				url: config.url,
				// Host lifetime: the provider is asked before every request, long after this routine call ended.
				authProvider: auth === null ? undefined : { token: () => tokenFor(auth, radius, BACKGROUND_CONTEXT) },
			}),
		);
		return { kind: "connected", config, client, tools: await client.listTools() };
	} catch (error) {
		return { kind: "failed", config, error: error instanceof Error ? error.message : String(error) };
	}
}
```

`RadiusAuth` and `RadiusOrg` are the Radius plugin's server objects (PROPOSED: tokens for Radius connections,
membership, shares). `tokenFor` asks the Radius plugin (`RadiusAuth.token({ connection: "jira" })`) for a short-lived token, or the secrets
store for a named secret. The Jira token never enters the profile, the settings or the MCP plugin's state.

```ts
// PROPOSED · apps/p3/plugins/mcp/worker.ts
// A session's MCP tools, and the agent's tool to add a server: both through server views, as the owner's session.

import type { Reference } from "@earendil-works/chord";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { createMcpToolName, toLlmContent } from "@earendil-works/pi-mcp";
import { obj, str } from "@earendil-works/pi-schema";
import { defineFacet, HarnessTools, local, type P3Principal } from "@p3/app/v1";
import { SettingsView } from "@p3/app/v1/settings";
import { toolError } from "../harness/refusals.ts";
import { McpServers, type McpTool, McpToolsView } from "./contract.ts";

const McpAgent = local("mcp.agent", { version: 1, params: {}, members: {} });

export default defineFacet<P3Principal>((host) => {
	host.serve(McpAgent, (_params, self) => {
		const view = self.get(McpToolsView, {});
		const settings = self.get(SettingsView, {});
		const tools = self.writable<readonly ToolRegistration[]>([addServer(settings)]);
		// Follows the server's tool list: a server Acme removes takes its tools out of the next model request.
		self.on(view.tools, ({ value }) => tools.set([addServer(settings), ...value.map((tool) => mcpTool(tool, view, settings))]));
		self.contribute(HarnessTools, tools);
		return {};
	});
});

/** The agent's way to add a server: the same `set` the settings page calls. */
function addServer(settings: Reference<typeof SettingsView>): ToolRegistration {
	return defineTool({
		name: "mcp_add_server",
		description: "Add a remote MCP server to this Pi. Its tools are available from the next turn.",
		parameters: obj({ name: str(), url: str() }),
		async execute({ name, url }, _api, context) {
			try {
				await settings.set({ kind: "entry", name: McpServers.name, entry: name, value: { url, auth: null } }, context);
				return { output: [{ type: "text", text: `Added MCP server ${name}. Its tools are available from the next turn.` }] };
			} catch (error) {
				return toolError(error, settings.managed.value);
			}
		},
	});
}

/** One server tool, called on the server, where the connection lives. */
function mcpTool(tool: McpTool, view: Reference<typeof McpToolsView>, settings: Reference<typeof SettingsView>): ToolRegistration {
	return defineTool({
		name: createMcpToolName(tool.server, tool.name),
		description: tool.description,
		// Cast: an MCP input schema is a JSON schema object.
		parameters: tool.inputSchema as object,
		async execute(args, _api, context) {
			try {
				return { output: toLlmContent(await view.call({ server: tool.server, tool: tool.name, args }, context)) };
			} catch (error) {
				return toolError(error, settings.managed.value);
			}
		},
	});
}
```

`HarnessTools` is the harness's registry of tools (base inventory #4); the session's own selection of resources still
applies on top of it (decision "No per-run authority").

```tsx
// PROPOSED · apps/p3/plugins/mcp/web.tsx
// The MCP section of the settings page: drawn from the effective value and the managed marks, never from a guess.

import { PluginError } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { useHold, useWatch } from "@earendil-works/chord/react";
import { useState } from "react";
import { SettingsView } from "@p3/app/v1/settings";
import { McpServers, type McpServerConfig } from "./contract.ts";

export function McpSettings() {
	const view = useHold(SettingsView, {});
	const effective = useWatch(view?.effective);
	const managed = useWatch(view?.managed);
	const [error, setError] = useState<string | undefined>(undefined);
	// Cast: the effective value passed the setting's schema.
	const servers = (effective?.[McpServers.name] ?? {}) as Record<string, McpServerConfig>;
	const mark = managed?.[McpServers.name];
	const locked = mark?.lock === "locked";

	const add = async (name: string, url: string) => {
		setError(undefined);
		try {
			await view?.set({ kind: "entry", name: McpServers.name, entry: name, value: { url, auth: null } }, BACKGROUND_CONTEXT);
		} catch (failure) {
			if (failure instanceof PluginError) setError(failure.message);
			else throw failure;
		}
	};

	return (
		<section>
			<h2>MCP servers</h2>
			{mark && <p className="managed">Managed by {mark.orgName}{locked ? ". Only its servers are used." : ""}</p>}
			<ul>
				{Object.entries(servers).map(([name, server]) => (
					<li key={name}>
						<span>{name}</span> <code>{server.url}</code>
						{mark?.entries.includes(name) ? <span className="lock" title={`Managed by ${mark.orgName}`} /> : <EditButtons name={name} />}
					</li>
				))}
			</ul>
			<AddServerForm disabled={locked} title={locked ? `Managed by ${mark?.orgName}` : undefined} onAdd={add} />
			{error && <p role="alert">{error}</p>}
		</section>
	);
}
```

## Sharing

```ts
// PROPOSED · apps/p3/plugins/sharing/contract.ts

import { arr, local, method, obj, oneOf, remote, str } from "@earendil-works/chord";
import { Server } from "@p3/app/v1/hosts";
import { defineSetting } from "@p3/app/v1/settings";

/** Who sessions may be shared with. Radius applies the same value from the profile to every invite and sign-in. */
export const SharingAudience = defineSetting("p3.sharing.audience", oneOf("anyone", "org", "nobody"), { merge: "value", initial: "anyone" });

export const Share = obj({ id: str(), session: str(), invitee: str(), mode: oneOf("read", "send") });
export const ShareRequest = obj({ session: str(), invitee: str(), mode: oneOf("read", "send") });

export const Shares = local("p3.shares", {
	version: 1,
	params: {},
	members: { shares: arr(Share), share: method(ShareRequest, Share), revoke: method(str()) },
});

/** The owner's sharing controls. */
export const Sharing = remote("p3.sharing", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { owner: { state: { shares: arr(Share) }, methods: { share: method(ShareRequest, Share), revoke: method(str()) } } },
});
```

```ts
// PROPOSED · apps/p3/plugins/sharing/server.ts (app root)
// Shares: refused by the audience setting before Radius is asked; ended when the setting tightens.

import { arr, defineState, forbidden, obj } from "@earendil-works/chord";
import { defineFacet, type P3Principal } from "@p3/app/v1";
import { RadiusOrg } from "@p3/radius/contract";
import { refusedBy, SettingKinds, setting } from "@p3/app/v1/settings";
import { Share, Shares, Sharing, SharingAudience } from "./contract.ts";

const ShareList = defineState("p3.shares.list", {
	schema: obj({ shares: arr(Share) }),
	version: 1,
	initial: () => ({ shares: [] }),
	persist: true,
	checkpointWhen: () => true,
});

export default defineFacet<P3Principal>((host, facet) => {
	facet.contribute(SettingKinds, [SharingAudience]);

	host.serve(Shares, (_params, self) => {
		const audience = setting(self, SharingAudience);
		const radius = self.get(RadiusOrg, {});
		const list = self.state(ShareList);

		// A tightened audience ends every share that no longer conforms, here and at Radius.
		self.on(audience, async ({ value }, ctx) => {
			for (const share of list.value.shares) {
				if (value === "anyone") break;
				if (value === "org" && (await radius.isMember({ email: share.invitee }, ctx))) continue;
				await radius.revokeShare(share.id, ctx);
				await list.change((draft) => {
					draft.shares = draft.shares.filter((each) => each.id !== share.id);
				}, ctx);
			}
		});

		return {
			shares: self.derive([list], ([doc]) => doc.shares),
			share: async (request, ctx) => {
				const now = audience.value;
				if (now === "nobody") throw refusedBy(SharingAudience, "Sessions on this Pi cannot be shared");
				if (now === "org" && !(await radius.isMember({ email: request.invitee }, ctx)))
					throw refusedBy(SharingAudience, `${request.invitee} is not a member of the org; sessions can be shared with members only`);
				// Radius checks again from the profile it signed: a modified Pi gets the same answer.
				const share = await radius.share(request, ctx);
				await list.change((draft) => {
					draft.shares.push(share);
				}, ctx);
				return share;
			},
			revoke: async (id, ctx) => {
				await radius.revokeShare(id, ctx);
				await list.change((draft) => {
					draft.shares = draft.shares.filter((each) => each.id !== id);
				}, ctx);
			},
		};
	});

	host.serve(Sharing, (_params, principal, self) => {
		if (principal.kind !== "user") throw forbidden("Only the owner shares sessions");
		const shares = self.get(Shares, {});
		return {
			variant: "owner",
			members: {
				shares: shares.shares,
				share: (request, ctx) => shares.share(request, ctx),
				revoke: (id, ctx) => shares.revoke(id, ctx),
			},
		};
	});
});
```

```ts
// PROPOSED · Radius: POST /orgs/:org/pis/:pi/shares (the invite endpoint behind RadiusOrg.share)
async function createShare(request: Request): Promise<Response> {
	const pi = await authenticatePi(request);                 // a short-lived token minted against the device key
	const profile = await profiles.current(pi.org, pi.member, pi.id);
	const audience = profile.settings["p3.sharing.audience"]?.value ?? "anyone";
	const { session, invitee, mode } = await request.json();
	if (audience === "nobody") return refuse(403, "sharing_disabled");
	if (audience === "org" && !(await orgs.isMember(pi.org, invitee))) return refuse(403, "outside_org");
	// Org-only shares need a Radius sign-in to redeem: no anonymous link, and membership is checked again at sign-in.
	const grant = await grants.create({ pi: pi.id, session, invitee, mode, requireMember: audience === "org" ? pi.org : null });
	return Response.json(grant);
}
```

## Acme's own plugin

```ts
// PROPOSED · github.com/acme/p3-deploy, contract.ts. Written by Acme's developers; nothing in it knows about orgs.

import { local, map, method, obj, oneOf, str } from "@earendil-works/chord";
import { defineSetting } from "@p3/app/v1/settings";

export const DeployTarget = obj({ host: str(), branch: str(), approval: oneOf("none", "review") });

export const DeployTargets = defineSetting("deploy.targets", map(DeployTarget), { merge: "entries", initial: {} });

export const Deployer = local("acme.deployer", {
	version: 1,
	params: {},
	members: { targets: map(DeployTarget), deploy: method(obj({ target: str(), ref: str() }), str()) },
});
```

```ts
// PROPOSED · github.com/acme/p3-deploy, server.ts

import { PluginError } from "@earendil-works/chord";
import { defineFacet, type P3Principal } from "@p3/app/v1";
import { SettingKinds, setting } from "@p3/app/v1/settings";
import { Deployer, DeployTargets } from "./contract.ts";

export default defineFacet<P3Principal>((host, facet) => {
	facet.contribute(SettingKinds, [DeployTargets]);
	host.serve(Deployer, (_params, self) => {
		const targets = setting(self, DeployTargets);
		return {
			targets,
			deploy: async ({ target, ref }, ctx) => {
				const chosen = targets.value[target];
				if (chosen === undefined) throw new PluginError("unknown_target", `No deploy target ${target}`);
				return startDeploy(chosen, ref, ctx);   // asks for a review first when chosen.approval is "review"
			},
		};
	});
});
```

## Eight traces

Each trace starts with what Dana or her agent does and ends with what they see. The line that decides is named.

### (i) Dana clicks "Add MCP server"

:::sequence animate | The settings page draws the lock from the managed marks; `set` refuses even when the page is behind.
actor page "settings page" "Dana's browser"
actor view "SettingsView" "server" blue
actor settings "Settings" "server" accent
actor gate "OrgGate" "server" muted
page -> view: useHold, useWatch(effective, managed)
view --> page: mcp.servers: jira, linear; managed: locked by Acme
page -> page: draw lock icons, disable "Add"
note page: an old tab, opened before revision 42, still shows "Add"
page -> view: set { kind: entry, name: mcp.servers, entry: github }
view -> settings: set
settings -> gate: gate.value (ready, revision 42)
settings => view: PluginError managed, "Managed by Acme: mcp.servers is locked"
view --> page: the same PluginError over the link
page -> page: show the alert
:::

1. `McpSettings` holds `SettingsView` and watches `effective` and `managed`. `managed["mcp.servers"]` is `{ orgName:
   "Acme", lock: "locked", entries: ["jira", "linear"] }`. The page draws both rows with a lock, and `AddServerForm`
   disabled with the title "Managed by Acme". This is how the page knows: it never guesses from the error, it renders
   the marks.
2. A page that missed the update (a tab left open since before Acme locked the list) still shows the form. Dana enters
   `github`, `https://github-mcp.example.com/mcp` and clicks Add. The page calls `view.set({ kind: "entry", name:
   "mcp.servers", entry: "github", value: { url, auth: null } })`.
3. `Settings.set` reads `gate.value` (followed state, per call): `ready`, revision 42. `writable` finds
   `managed.lock === "locked"` and throws `PluginError("managed", "Managed by Acme: mcp.servers is locked", { setting:
   "mcp.servers" })`. Nothing is written.
4. The error crosses the link as code, message and details (Chord sends nothing else), and the page rethrows it as a
   `PluginError`. `add` shows the message under the form: **Managed by Acme: mcp.servers is locked.**

### (ii) The agent calls `mcp_add_server`

Dana asks: "connect the GitHub MCP server". The model calls `mcp_add_server({ name: "github", url: "…" })`.

1. The tool runs in the session's worker. It calls `settings.set(...)` on its `SettingsView` reference: the worker's
   principal `{ kind: "worker", session }` is let in by the view's factory.
2. `Settings.set` refuses exactly as in (i): same method, same line.
3. `toolError` finds `details.setting = "mcp.servers"` and the mark, and the model's tool result is:

```text
Managed by Acme: mcp.servers is locked. The setting mcp.servers is managed by Acme and locked. Do not retry or look
for another way; tell the user to ask Acme's admin.
```

The model answers Dana that Acme manages the MCP servers. If it tries `bash` instead, to edit a config file: there is
none (MCP servers are a setting, not a file), and with the lock-down of chapter VI its shell runs in a sandbox that sees
only Acme's allowed folders, not the Pi's data directory.

### (iii) Acme's Jira entry appears, connects, and cannot be edited

1. At the first sync `OrgGate` writes revision 42 as the cache; `gate` turns `ready`.
2. `Settings.effective` recomputes: `effectiveOf` for `mcp.servers` with `lock: "locked"` returns Acme's record, `{
   jira, linear }`. Any servers Dana had before enrollment stay in her layer, unused.
3. `McpConnections`'s routine (`self.on(servers, …)`) gets the new record: nothing live yet, so it calls `connect` for
   both. The Jira transport's `authProvider.token()` asks `RadiusAuth` for a token of the Radius connection `jira`.
4. `snapshot.set(...)`: `tools` now lists Jira's tools; each session's `McpAgent` sees `view.tools` change and
   contributes the new tools; the next model request offers `mcp__jira__search_issues` and the others.
5. Dana clicks the edit button on the Jira row: there is none, the row has a lock. Her agent calls `set({ kind:
   "entry", name: "mcp.servers", entry: "jira", value: { url: "…", auth: null } })`: refused by `writable` because the
   setting is locked. Had Acme used `lock: "default"` (its servers plus Dana's), the second check would refuse the
   same write: `Object.hasOwn(managedEntries(managed), "jira")`, with "Managed by Acme: the entry jira of
   mcp.servers". Dana could still add `github` beside it.

### (iv) Dana installs plugins

**An allowed optional plugin.** The plugins page lists the catalog from `PluginsView.catalog`: `acme-reviews`,
"available", from Acme. Dana clicks Install.

1. `Plugins.install({ kind: "catalog", name: "acme-reviews" })`: the mark of `p3.plugins` lists it, so `installOrg`
   runs.
2. The kit's binding clones `https://github.com/acme/p3-reviews` at `v2.0.1` into the org root and runs `npm install
   --ignore-scripts` there.
3. `treeHash` of the installed tree is `sha256-77de…`, equal to the profile's: it goes into `verified` and the file
   the start script reads.
4. `kit.readmit()`, `kit.apply()`: discovery runs again, `admits` sees an org-root plugin with a matching entry and
   hash, and returns `true`. The plugin loads; the catalog shows it "loaded".

**A plugin that is not allowed.** Dana pastes `https://github.com/someone/p3-weather` into "Install from a source".

1. `Plugins.install({ kind: "source", … })`: `own.value` is `false` (Acme locked `p3.plugins.own`), so
   `refusedBy(OwnPlugins, "Plugins from other sources do not load on this Pi")`. The page shows it with "Managed by
   Acme", because `managed["p3.plugins.own"]` exists.
2. Suppose the tree got into the member root anyway (copied there before enrollment, or by a shell running as the
   Pi's user without the lock-down). Discovery finds it; `admits` reaches the last line, `state.ownPlugins` is
   `false`, and it does not load. The catalog lists it as "left-out: plugins written or installed on this Pi do not
   load (managed by Acme)".
3. And if someone put it into the org root under a catalog name? Its hash does not match: `recheck` drops it from
   `verified`, and `admits` refuses it.

### (v) The agent writes a plugin

Dana asks for "a small plugin that shows the weather in the sidebar". The agent calls the plugin tool `plugin_write({
plugin: "weather", path: "web.tsx", content: "…" })`.

1. `PluginsView.write` → `Plugins.write`: `own.value` is `false`, so `refusedBy(OwnPlugins, "Plugins written on this Pi
   do not load")`.
2. `toolError` turns it into: **"Plugins written on this Pi do not load. The setting p3.plugins.own is managed by Acme
   and locked. Do not retry or look for another way; tell the user to ask Acme's admin."**
3. Without the lock-down, a determined agent could still write the files with its own file tools into the member
   root and call `plugin_apply`. Apply runs, the plugin is discovered, `admits` returns `false`, and the apply tool's
   result lists `weather: left out: plugins written on this Pi do not load (managed by Acme)`. With the lock-down, the
   write itself fails: the member root belongs to the Pi's service user and is in no sandbox's folders.

### (vi) Dana shares a session with an outside email

Dana opens the share sheet of a session and types `sam@partner.example`.

1. `Sharing.share` → `Shares.share`. `audience.value` is `"org"`. `radius.isMember({ email: "sam@partner.example" })`
   answers `false`. The method throws `refusedBy(SharingAudience, "sam@partner.example is not a member of the org;
   sessions can be shared with members only")`, and the sheet shows it with "Managed by Acme".
2. A modified Pi that skips that check reaches Radius's `createShare`. Radius loads the profile it signed for
   `pi_7f3a`, finds `"org"`, asks its own membership table and answers `403 outside_org`. No grant, no link, no relay.
3. A grant made before the lock (when the audience was `"anyone"`) is ended by the `self.on(audience, …)` routine:
   `radius.revokeShare` for every invitee who is not a member. Radius also ends such grants itself when the profile
   changes, so a Pi that is offline at that moment does not keep them alive.

### (vii) Acme removes Linear, live

Acme's admin deletes the Linear row and saves. Radius signs revision 43.

1. `OrgClient` receives it over the follow connection, checks the signature, `member`, `pi` and the plugin sources,
   and offers it. `OrgGate`'s routine writes the cache (settings first) and calls `plugins.reconcile` (nothing to
   install) and `plugins.apply`.
2. `gate` changes, so `Settings.effective` changes: `mcp.servers` is now `{ jira }`.
3. `McpConnections`'s routine runs with `{ jira }`. `linear` is live but no longer wanted: removed from the pool, its
   client closed. A Linear call in flight at that moment rejects with `McpConnectionClosedError`; its tool result is an
   error the model sees ("MCP server linear: connection closed").
4. `snapshot.set` → `tools` loses Linear's tools → every running session's `McpAgent` routine sets its tools → the
   harness's next model request in each session no longer offers `mcp__linear__*`. No session restarts; nothing else
   reconnects.

The page's MCP section loses its Linear row in the same second, because it watches the same `effective` value.

### (viii) Acme locks its own plugin's setting

`acme-deploy` declares `deploy.targets` and reads it with `setting(self, DeployTargets)`. Its authors wrote the
settings page form for it, as for any setting; they never mention orgs.

1. Acme's admin opens "Other settings" in Radius. The setting is listed because Dana's Pi reported the `SettingKinds`
   of its loaded plugins at its last sync, with the schema `map(DeployTarget)`. Radius renders the form from the
   schema; the admin adds `staging` and `production` and picks "locked".
2. The profile carries `"deploy.targets": { "lock": "locked", "value": { … } }`. On Dana's Pi, `effectiveOf` returns
   exactly those two targets; `Deployer.targets` (a derive of the effective value) shows them; `deploy({ target:
   "my-box" })` fails with "No deploy target my-box" from the plugin's own check.
3. Dana's attempt to add `my-box` on the settings page, or her agent's through a settings tool, ends in `Settings.set`
   with "Managed by Acme: deploy.targets is locked".

The plugin did one thing: it kept its configuration as a setting. That is the whole contract between plugin authors
and orgs. A plugin that keeps its targets in a private file instead would escape the lock; Acme's answer is not to
admit it.

# Guardrails and Walls {#trust lede="Who this stops, who it does not, and what Radius enforces whatever the Pi does."}

Every check in the Pi runs in the Pi's process, as the Pi's Unix user. That decides what it can stop. The design is
honest about it: in the Pi, managed settings are a guardrail; where Radius sits in the path, they are a wall.

## Three adversaries

**Dana's agent** is the main target: prompt injection or plain sloppiness. Its ordinary means are the settings tool,
the plugin tools, the share tool and file edits. `Settings.set` refuses locked settings. The base's install path
refuses plugins outside the profile, and `admit` keeps unapproved code from loading. The enrollment file is root-owned.
An edited cache fails its signature, and the gate falls back to `pending`. All of these hold. What does not hold, on a
Pi that runs as Dana's own user, is `bash` under the Pi's Unix user: it can start a modified copy of the Pi on the same
data directory, with Dana's token, ignoring the gate. On a personal Pi that is the decided trust line ("The agent
writes plugins": the boundary is access to the server). On an Org Device chapter VI moves it: the Pi runs as a user of
its own and the agent's shell runs in a sandbox, so the shell cannot reach the Pi's files.

**A third-party plugin** is server code in the Pi's process. It can do anything the process can. Admitting it is the
trust decision, and the only control is `p3.plugins`. A plugin that keeps its configuration through settings is covered
without knowing it.

**Dana herself.** On her own laptop she is not an adversary: enrollment is compliance, and she could simply not
enroll. On an Org Device she is held as far as her agent is. Anything that must hold against a determined member is
enforced at Radius.

## What is real

| Acme wants | Pi-side check | Real at Radius |
| --- | --- | --- |
| No MCP servers except Acme's | `set` refuses; MCP connects only to effective entries | Jira and Linear tokens live at Radius (`auth: radius`), so only those two work with Acme's accounts. Another server with Dana's own credentials: guardrail. |
| Only Radius's models | `set` refuses; the models plugin offers only effective providers | Acme's keys never leave Radius; leaving Acme ends access. Another provider with Dana's own key: guardrail. |
| Required and approved plugins only | install path, `admit`, hash checks | guardrail: the org root is written by the Pi's Unix user; with the service user of chapter VI the agent cannot write it. |
| No sharing outside Acme | the share method refuses; tightening ends non-conforming shares | Radius issues guest sign-ins and relays from the same profile: real. |
| No Pis outside Acme | the peer plugin refuses and closes links | Radius brokers every Pi-to-Pi link: real. |
| Company instructions | the harness reads the effective value | guardrail (it is a prompt). |

On an Org Device, the Device's setup may pre-install Acme's plugins into a root-owned directory such as
`/opt/p3/org-plugins` and give it as the org root. The Pi can then load but not change them, which makes "approved
builds only" hold against the agent's `bash` too, for that root. It is an option, not a requirement.

:::note | Revocation while offline
Radius-enforced parts end the moment Acme removes Dana: guest links, peer links and org models stop at Radius. The
Pi-side settings follow only when the Pi reconnects and receives `revoked`. A Pi that stays offline keeps its cached
profile, and an offline Pi can be given an older signed profile it was once sent. Acme bounds both with `maxOffline`,
at the price of a Pi that locks itself after that long without the server.
:::

# Locking Down the Machine {#lockdown lede="How a managed Pi holds against a member or an agent with a shell: a signed install, a service user, tools only in sandboxes, execution control, a key Radius checks, and restriction plugins the org picks."}

Chapter V ends at one line: `bash` under the Pi's Unix user defeats every check in the Pi. On a personal Pi that line
is fine, it is the decided trust boundary. On an Org Device it is the first thing a curious agent finds. Dana's agent
runs `bash` as the user the Pi runs as, so it can edit the profile cache, read the Radius token, write into the org
root, or start a patched copy of the Pi on the same data directory with Dana's token.

The fix is not more checks inside the Pi. It is to move the Pi out of reach of the shell: the Pi runs as a user of its
own, from files nobody else can write, and the agent's tools run in sandboxes that see only the folders Acme allows,
never as the Pi's user and never as Dana's. Five pieces do that, and a sixth lets Acme narrow what members can do
further. Each stops some adversaries and not others; the table at the end says which.

## "Can't I just patch out the check?"

Armin asked it on 2026-11-13: "in practice surely the only way to enforce a lock down status is after user signs in
with their org? otherwise i just patch out that check". The owner's answer: "not if pi runs as a different provisioned
user on the machine." Both are right, about different things, and the pieces below are why.

**Armin is right that Radius is where org resources are gated.** Whatever a Pi does locally, Acme's models, Acme's
MCP credentials, the sharing relay and peer links come from Radius, and Radius gives them only to a Pi that signed in
as a member of Acme and proves its device key (piece (e)). A Pi that skips every local check gets nothing from Acme.

**The owner is right that the managed Pi itself cannot be patched by Armin.** The check Armin would patch runs in a
process he does not own, from files he cannot write:

1. The binary is installed by the admin into a system location and signed (a). Armin cannot change it in place.
2. It runs as `p3-armin`, not as `armin` (b). Armin cannot attach a debugger to it, read its memory, edit its profile
   cache, its store or its plugin roots, or read its Radius token: the operating system refuses all of that across
   users.
3. Armin can run his own patched copy, as himself. Execution control (d) can stop a patched binary from starting. If
   it starts anyway (from source, with a `node` Armin needs for his work), it has no access to the managed Pi's data
   directory, no Radius token and no device key. It is a personal, unmanaged Pi with Armin's own provider keys and
   none of Acme's resources.
4. His agent cannot help him: its tools run in a sandbox (c) that sees only the folders Acme allows and none of the
   Pi's files.

**What a member with local admin rights can still do:** everything on that machine. Root can stop the service, replace
the binary, edit the data directory, read the process's memory, and use the device key from a patched Pi (a TPM or
Secure Enclave key cannot be exported, but root on the same machine can use it). Such a Pi ignores every Pi-side lock
and still gets Acme's resources, on that machine. What still holds then is what Radius enforces from the profile it
signed: who sessions can be shared with, which Pis can connect, what the model gateway and the MCP credentials allow.
That is why Org Devices give members no root, and why laptops in the MDM's care do not make members administrators.
Measured boot (a TPM attesting the system's state) could let Radius notice a modified machine; it is not part of this
design.

## (a) One signed executable in a system location

The Pi is installed by the machine's admin (on a laptop: the MDM, the tool an IT department uses to push software and
settings to company machines) into a directory only an administrator can write: `/opt/p3` on Linux,
`/Library/Application Support/p3` or `/usr/local/p3` on macOS, `C:\Program Files\p3` on Windows. Dana and her agent can
read and run it, not change it.

**What pi has today.** The coding agent already ships standalone binaries:

- `packages/coding-agent`'s `build:binary` script and `scripts/build-binaries.sh` compile `dist/bun/cli.js` with Bun's
  `--compile` into one executable per platform (darwin arm64 and x64, linux x64 and arm64, windows x64 and arm64),
  embedding two worker entry points (the image resize worker and the code mode worker).
- The executable is not alone: the release archives carry assets next to it (themes, the export template and its
  vendor scripts, the photon wasm file, docs), and `src/config.ts` finds them relative to the executable when
  `isBunBinary` is set (`getPackageDir`, `getThemesDir`, `getExportTemplateDir`).
- There is also an esbuild-bundled Node distribution (`dist/bundle/cli.js`, detected by `isBundledNode`).
- Nothing is signed. `.github/workflows/build-binaries.yml` builds and uploads the archives; there is no code signing,
  notarization or Authenticode step.

**What p3 needs is different.** p3's server is a Chord app, and the kit depends on Node in ways the coding agent does
not: the store uses `node:sqlite`; session workers are separate Node processes started with `child_process.fork` and
advanced serialization (`packages/chord/src/node/workers/process.ts`); plugin builds call esbuild, which is a native
executable of its own (`packages/chord/src/node/plugins/build.ts`); installs run `git`, `tar` and `npm`
(`packages/chord/src/node/plugins/install.ts`). So p3's executable is a Node single executable application (Node's
own mechanism: one Node binary with the bundled server injected into it), and it does not travel alone either:

| File in `/opt/p3/bin` | Why it is separate | Signed |
| --- | --- | --- |
| `p3` | Node with the bundled server, the worker entry and the TUI; started as `p3 serve`, `p3 worker`, `p3` (TUI) | yes |
| `esbuild` | plugin builds; found through `ESBUILD_BINARY_PATH` | yes |
| `pi-env` | the tool daemon of `packages/env` (Rust), copied into each sandbox VM, (c) below | yes |
| `p3-devkey` | the device key helper, (e) below | yes, with the platform's key access entitlement on macOS |

Three kit changes follow, all for laptops later rather than Dec 18: the worker fork must start the same executable in
worker mode (`fork` runs `process.execPath`, which is `p3` itself, so its entry point dispatches on its arguments, and
the worker kind's Node flags are fixed at build time); installs of org plugins must not need `npm` and `git` on the
machine, so Radius (or Acme's CI) builds each approved plugin into a complete tree with its `node_modules`, hashed as
a whole, and the kit installs that tarball; and esbuild's path comes from the install directory, never from the data
directory, where the service user could replace it.

On macOS the four files are signed with a Developer ID and the package is notarized; on Windows they carry
Authenticode signatures. Signing is what lets (d) tell this Pi from a patched copy.

## (b) The Pi runs as a service under its own user

Each member's Pi is a system service with a Unix user (a Windows service account) of its own, created by the root
setup when Dana's Pi is created:

| | Linux (Org Devices, Dec 18) | macOS | Windows |
| --- | --- | --- | --- |
| Service | systemd unit `p3@dana.service`, `User=p3-dana` | launchd daemon `/Library/LaunchDaemons/com.earendil.p3.dana.plist`, `UserName` `_p3dana` | a Windows service per member, virtual account `NT SERVICE\p3-dana` |
| Data directory | `/var/lib/p3/dana`, owner `p3-dana`, mode 0700 | `/Library/Application Support/p3/dana`, owner `_p3dana`, 0700 | `C:\ProgramData\p3\dana`, ACL: the service account only |
| Inside it | the Chord store, the profile cache, the Pi's Radius token, the org root, the member root, secrets | same | same |
| Listens on | `127.0.0.1:<port>`, a port per member Pi | same | same |

The profile cache, the Radius token and both plugin roots now belong to `p3-dana`. Dana's user cannot read or write
them, and neither can anything running as Dana: her shell, her editor.

**How Dana's clients sign in.** The kit already has the pieces: device sign-ins, the owner token file (a device
sign-in of the owner, mode 0600, `ownerTokenFile` in `packages/chord/src/node/app/owner.ts`), and one-time owner links
for the browser. Only where the token lives changes:

- When the root setup creates the Pi, it writes `~dana/.p3/pi.json`, owner `dana`, mode 0600: `{ "url":
  "http://127.0.0.1:47123", "token": "<a device sign-in of the owner>" }`. Other members on the same Org Device cannot
  read it. On Windows the file is under `%LOCALAPPDATA%\p3` with an ACL for Dana only.
- **The TUI** (`p3`, run by Dana) reads the file and opens its Chord link with the token as a bearer credential, as
  command-line clients use the owner token file today.
- **The browser on the same machine:** `p3 open` reads the same file, asks the Pi for a fresh one-time owner link
  (`POST /_chord/owner-link` with the bearer token; the base route calls the kit's existing `App.ownerLink()` through
  the platform binding), and opens it. The page posts the one-time token from the URL fragment and gets the owner
  cookie, as the kit's owner link works today.
- **The browser anywhere else** (an Org Device in the cloud, Dana's phone): through the Radius relay. Dana signs in
  with Radius; the Radius plugin's authenticator, contributed to the kit's `Authenticators` registry, maps her Radius
  identity to the owner.

A unix socket checked by peer credentials would avoid the token file, but Node has no API to read a socket peer's
credentials (`SO_PEERCRED`, `LOCAL_PEERCRED`), and the kit listens on TCP only (`ListenAddress` is a host and a port).
The token file gives the same guarantee through the file system: only Dana can read it. Her agent can read it too,
and that is fine: it then talks to the Pi as the owner, and the owner is held by the locks.

## (c) The agent's tools run only in sandboxes

A Pi running as `p3-dana` that runs `bash` in its own process would hand `p3-dana`'s rights to the agent, and the
service user would protect nothing. Running the tools as Dana instead (a sudo rule that lets `p3-dana` start `pi-env`
as `dana`, as the first draft of this chapter proposed) protects the Pi, but hands the agent everything Dana has: her
SSH keys, her browser profile, every file in her home, any host on the network. Prompt injection then reaches all of
it.

So, at the owner's suggestion, the agent's tools run **only in sandbox environments**: Gondolin VMs with chosen local
folders mounted into them, never directly as the Pi's service user and never as Dana's user. This is a profile setting,
enforced by the environments plugin, which Earendil ships as a Pi plugin that Acme selects in Radius like any other.

**What Gondolin is, as it exists today.** `@earendil-works/gondolin` (0.14.0 in this repo's lockfile) is Earendil's
sandbox: "Local Linux micro-VMs with a fully programmable network stack and filesystem", running on macOS or Linux with
QEMU or krun (libkrun; prebuilt runners for macOS arm64 and Linux x64), guest images of about 200 MB (Alpine Linux by default),
Node 22.19 or newer on the host. Its network stack and virtual file system are TypeScript in the host process: a VM sees
only the folders it is given (`RealFSProvider`, `ReadonlyProvider` in `vfs.mounts`) and reaches only the hosts
`createHttpHooks` allows, and secrets are injected into outbound HTTP headers by the host, so the VM sees placeholders
only. Its README lists no Windows support.

**p2 already runs it.** p2's environments plugin (`apps/p2/plugins/envs/`) has a `gondolin` environment kind
(`GondolinEnvConfigSchema` in `schema.ts`: a host, an image, up to 16 `mounts` of a host folder at a guest path with
`readonly`, `allowHosts`, CPUs, memory, a disk). Its launcher (`sandbox/p2-sandbox.sh`, `p2-sandbox.mjs`) keeps one
long-lived VM per sandbox in a supervisor process, copies the `pi-env` daemon into the VM and speaks pi-env's protocol
to it, so the session's tools run inside the VM exactly as on an SSH machine. It checks host names before DNS
resolution (`isRequestAllowed`), keeps the VM's own disk across restarts, refuses a writable mount of `~` or `~/.pi`,
and today needs Linux with a usable `/dev/kvm` and QEMU 7.2 or newer (`sandboxSupport` in `manager.ts`). p3's
environments plugin takes this code; the difference is that the VM runs on the Pi's own machine, under the service
user, instead of on an SSH host.

**The settings.** Three settings, declared by the environments plugin, carry Acme's rules:

```ts
// PROPOSED · @earendil/p3-environments (github.com/earendil-works/p3-environments), contract.ts
import { arr, bool, obj, oneOf, str } from "@earendil-works/chord";
import { defineSetting } from "@p3/app/v1/settings";

/** Which kinds of environment sessions may use. `local` is the Pi's own process user. */
export const EnvironmentKinds = defineSetting("environments.kinds", arr(oneOf("local", "ssh", "sandbox")), {
	merge: "value",
	initial: ["local", "ssh", "sandbox"],
});

/** The host folders a sandbox may mount, and whether writable; a mount must be inside one of them. */
export const SandboxFolders = defineSetting("sandbox.folders", arr(obj({ path: str(), writable: bool() })), {
	merge: "value",
	initial: [{ path: "~", writable: true }],
});

/** The hosts sandboxes may reach over HTTP(S) (`*` wildcards), passed to Gondolin's `createHttpHooks`. */
export const SandboxHosts = defineSetting("sandbox.allowHosts", arr(str()), { merge: "value", initial: ["*"] });
```

Acme's profile locks them:

```json
// PROPOSED · in Dana's profile, beside the settings of chapter IV
"environments.kinds": { "lock": "locked", "value": ["sandbox"] },
"sandbox.folders": { "lock": "locked", "value": [
  { "path": "~/work/acme", "writable": true },
  { "path": "~/Documents/acme-specs", "writable": false }
] },
"sandbox.allowHosts": { "lock": "locked", "value": [
  "github.com", "*.github.com", "registry.npmjs.org", "*.acme.internal"
] }
```

**The enforcement**, in the environments plugin's server object, at the two places an environment comes to exist or
starts:

```ts
// PROPOSED · @earendil/p3-environments, server.ts (excerpt). Chord API: host.serve, self.on, setting(), refusedBy.
host.serve(Environments, (_params, self) => {
	const kinds = setting(self, EnvironmentKinds);
	const folders = setting(self, SandboxFolders);
	const hosts = setting(self, SandboxHosts);
	const list = self.state(EnvironmentList);

	// A tightened profile stops every running sandbox whose kind or folders no longer conform.
	self.on(self.derive([kinds, folders], (values) => values), async ({ value: [allowedKinds, allowed] }, ctx) => {
		for (const env of list.value.envs) {
			if (allowedKinds.includes(env.kind) && (env.kind !== "sandbox" || mountsAllowed(env.mounts, allowed))) continue;
			await stopEnvironment(env.name, ctx);   // calls in flight end like a disconnect
		}
	});

	return {
		envs: self.derive([list, kinds], ([doc, allowedKinds]) => doc.envs.filter((env) => allowedKinds.includes(env.kind))),
		create: async (config, ctx) => {
			if (!kinds.value.includes(config.kind)) throw refusedBy(EnvironmentKinds, `Environments of kind ${config.kind} are not allowed`);
			if (config.kind === "sandbox") {
				// Real paths: a symlink inside an allowed folder must not lead out of it.
				for (const mount of config.mounts) {
					const where = await realHostPath(mount.host);
					const rule = folders.value.find((folder) => isInside(where, expand(folder.path)));
					if (rule === undefined) throw refusedBy(SandboxFolders, `${mount.host} may not be mounted into a sandbox`);
					if (!mount.readonly && !rule.writable) throw refusedBy(SandboxFolders, `${mount.host} may only be mounted read-only`);
				}
			}
			await list.change((draft) => { draft.envs.push(config); }, ctx);
		},
		// Starting a sandbox passes the effective hosts, never the config's own list: Acme's list wins.
		start: (name, ctx) => startSandbox(name, { allowHosts: hosts.value }, ctx),
	};
});
```

The session side needs one rule in the base: a session's environment comes only from `Environments.envs`, and the
Pi's own process user (`local`) is an environment like any other, so with `environments.kinds` locked to `["sandbox"]`
no session gets `bash` in the service's process. A tool call made before a session picked a sandbox has no environment
and fails.

**Which folders the Pi can reach at all.** The VM's file system is served by the Pi's process, which runs as
`p3-dana`, and `p3-dana` cannot read Dana's home. So Dana grants the Pi her chosen folders herself, with the operating
system's access lists: `p3 folders add ~/work/acme` runs, as Dana, `setfacl -R -m u:p3-dana:rwX,d:u:p3-dana:rwX,d:u:dana:rwX
~/work/acme` on Linux (`chmod +a` on macOS). That gives three layers, each with its own owner: Dana decides which of
her folders the Pi can reach, Acme decides which of those may be mounted, and each sandbox mounts what its session
needs.

**Compared with running the tools as Dana:**

| | Tools as Dana (sudo rule, first draft) | Tools only in sandboxes |
| --- | --- | --- |
| Privilege crossing | `p3-dana` starts processes as `dana`: a root-written sudoers rule per Pi | none: the VM runs as `p3-dana`; Dana grants folders with her own access lists |
| What the agent's `bash` can read | everything Dana can: home, SSH keys, browser profile | only the mounted folders |
| Network | anything Dana's user can reach | only `sandbox.allowHosts`, checked before DNS |
| Secrets | in Dana's environment and files | outside the VM, injected into requests for their hosts |
| Set by the org | no: Dana's rights are Dana's | yes: three settings in the profile |
| Platforms | Linux, macOS; Windows needs a logon launcher | where Gondolin runs: Linux with KVM, macOS; not Windows |
| Costs | small: one daemon process per environment | a VM per sandbox (memory, the image download on first start), and tools run in Alpine Linux, not on Dana's host toolchain |

The sandbox is simpler because nothing crosses users: no sudoers file, no helper with privileges, no launcher. It is
stronger because the agent's reach is what Acme wrote down, not everything Dana happens to have. Its cost is real:
virtualization must be available (on a cloud Org Device that means nested virtualization or a bare-metal host with
`/dev/kvm`), every sandbox is a VM with its own memory, and a Mac developer's local toolchain is not inside the VM.
Dana's own terminal work is unaffected: only the agent's tools are sandboxed.

## (d) Execution control

(a) to (c) protect the managed Pi. They do not stop Dana from running a different Pi: a patched copy of the binary,
or pi from source, as her own user, with her own provider keys. Execution control is the MDM's job, not the Pi's:

- **macOS:** an endpoint-security agent installed by the MDM, with an allow list by signing team; Dana is not an
  administrator. Gatekeeper alone checks only downloaded files.
- **Linux:** fapolicyd with a trust database of approved binaries, or `noexec` mounts for home and temporary
  directories.
- **Windows:** App Control for Business or AppLocker publisher rules, pushed by the MDM.

Execution control has a hard limit on developer machines: it stops a patched `p3` binary, not a Pi run from source by
an interpreter Dana needs for her work (`node`, `python`). That is why (e) matters more: a copy that runs gets nothing
from Acme.

## (e) A device-bound key

At enrollment the Pi asks `p3-devkey` to create a key that cannot leave the machine: in the Secure Enclave on macOS
(P-256, the only curve it offers), in the TPM 2.0 on Linux and Windows (`/dev/tpmrm0`, the Windows Platform Crypto
Provider; a cloud Org Device has a virtual TPM). The public half goes to Radius with the first sync and is in the
profile as `deviceKey`. From then on Radius gives org resources only to a Pi that proves it holds the private half:

:::sequence animate | Every Radius token is minted against the device key. A copy of the Pi's data on another machine, or under another user, has no key.
actor pi "Dana's Pi" "p3-dana"
actor key "p3-devkey" "TPM / Secure Enclave" muted
actor radius "Radius" blue
pi -> radius: POST /pis/pi_7f3a/challenge
radius --> pi: nonce
pi -> key: sign(nonce)
key --> pi: signature
pi -> radius: POST /pis/pi_7f3a/token { nonce, signature }
radius => pi: access token, 10 minutes (models, MCP gateway, relay, peers)
:::

The org's resources at Radius (the model gateway with Acme's keys, the MCP credentials behind `auth: radius`, the
sharing relay, peer links) all take only that short-lived token. Copying the data directory, or the Pi's long-lived
Radius token, to another machine gives a Pi that cannot get one. The key handle is readable only by `p3-dana` (on
Linux the TPM device is opened by the service, in the `tss` group; Dana is not).

For Dec 18 a simpler form is enough: a key file in the data directory, mode 0600, owner `p3-dana`. It stops Dana and
her agent (they cannot read it) but not root, which could copy it; the TPM form stops the copy too.

## Restriction plugins

Some limits are not about configuration but about what the agent may do: never call a tool that deletes Linear
issues, never export a session, require a review before a deploy. These are plugins too, and Acme picks them in Radius
the way it picks its own plugins. The admin form has a section **Restriction plugins**: a catalog of plugins Earendil
publishes (the sandbox environments above among them) plus Acme's own. Selecting one adds a required, hash-pinned entry
to `p3.plugins` and shows the plugin's settings, whose schemas Radius knows from the published plugin. In the profile it
is nothing new:

```json
// PROPOSED · in Dana's profile
"p3.plugins": { "lock": "locked", "value": {
  "environments": { "source": { "git": "https://github.com/earendil-works/p3-environments", "ref": "v1.0.0" }, "hash": "sha256-0a5c…", "required": true },
  "tool-rules":   { "source": { "git": "https://github.com/earendil-works/p3-tool-rules", "ref": "v1.0.0" },   "hash": "sha256-d71f…", "required": true }
} },
"toolRules.blocked": { "lock": "locked", "value": ["mcp__linear__delete_*", "session_export"] }
```

(The plugin entries sit beside Acme's own in the same `p3.plugins` record; the enrollment file's `pluginSources` then
lists `https://github.com/earendil-works/` too.) A restriction plugin limits through the harness's hooks, which Durable
has today: a `beforeTool` hook on the built-in tool task may return `{ block: reason }`, and the call ends as a
blocked tool result the model sees.

```ts
// PROPOSED · @earendil/p3-tool-rules, worker.ts. Durable API: defineExtension, hook, ToolTask, beforeTool's { block }.
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";

/** Blocks every tool whose name matches the effective `toolRules.blocked`, in every session. */
export function toolRules(blocked: () => readonly string[]) {
	return defineExtension({
		name: "tool-rules",
		hooks: [
			hook(ToolTask, {
				beforeTool: (call) => {
					const rule = blocked().find((pattern) => matches(pattern, call.name));
					return rule === undefined ? {} : { block: `Blocked by the setting toolRules.blocked (${rule})` };
				},
			}),
		],
	});
}
```

Two things make such a plugin a restriction and not a suggestion. It is required and pinned, so it loads on every
start and cannot be edited (`admit` and the hash). And its extension must apply to every session whatever the
session's own selection says, which the base has to provide: a harness registry of **required extensions**, filled
only by plugins from the org root. Without that, a session that does not select the extension would escape it.

## Which piece stops whom

| Piece | Dana's agent | Dana with a shell | Dana with admin rights | A third-party plugin |
| --- | --- | --- | --- | --- |
| (a) signed install in a system location | cannot patch the Pi | cannot patch it; can run another copy | no | no: it runs inside |
| (b) service user | cannot edit the cache, token, roots or store | same | no | no: it runs as the service user |
| (c) tools only in sandboxes | sees only the mounted folders and allowed hosts; never the Pi's files, never all of Dana's | not needed: her own shell is hers | no | no: it runs in the Pi's process, outside any VM |
| (d) execution control | cannot start a patched binary | same, except interpreters she needs | only where the MDM holds admin rights back | not applicable |
| (e) device-bound key | a copy it starts gets nothing from Acme | same | cannot export the key; can use it on that machine | can use it from inside |
| Restriction plugins | its blocked tools stay blocked in every session | same, inside the managed Pi | no | no: it runs beside them |
| Plugin list (`admit`, hashes) | its plugins do not load | same | no | holds: unadmitted code never runs |
| Radius enforcement | holds | holds | holds | holds |

Read by column: an agent is held by (b) and (c), and by restriction plugins for what they block. A member with a shell
is held by (a), (b), (d) for binaries, and (e). A member with admin rights is held only by Radius, and on that machine
not even by (e), which then only stops copies to other machines. A third-party plugin is held only by the plugin list
and Radius.

## What Dec 18 needs, and what waits for laptops

**Dec 18, Linux Org Devices:**

- (b) a systemd unit and a Unix user per member Pi, data in `/var/lib/p3/<member>`;
- (a) a root-owned install directory `/opt/p3`, installed by the Device setup: Node, the bundled server, esbuild,
  `pi-env`, Gondolin's runtime; not yet a single executable, not yet signed (on Linux, file ownership already does the
  work);
- (c) sandbox-only environments from Earendil's environments plugin, built from p2's `gondolin` kind: QEMU 7.2 or
  newer and `/dev/kvm` on the Device (for a cloud Device: nested virtualization or bare metal), the service user in the
  `kvm` group, `p3 folders add` for the member's folders, the three settings in the profile; the service user's own
  `local` environment never offered;
- restriction plugins: the Radius catalog section, the tool-rules plugin, and the base's required-extensions registry;
- `~<member>/.p3/pi.json` for the TUI and `p3 open`, and Radius sign-in through the relay for the browser;
- (e) the key-file form of the device key.

**Later, for laptops:** the single executable and its signing and notarization; launchd daemons and Windows services;
sandboxes on macOS (Gondolin runs there with QEMU or krun; the krun runner needs the hypervisor entitlement in a signed install);
Windows, where Gondolin lists no support, has no sandbox-only mode yet; the Secure Enclave and TPM forms of the device
key; installs from complete, hashed plugin artifacts without `npm` and `git`; and execution control, which is the
MDM's, configured by the org.

# When Things Fail {#failures lede="Every failure the consultations found, and what the Pi does."}

The rule behind every row: a failure never makes an enrolled Pi unmanaged, and never opens what the last good profile
closed.

| Failure | What happens | Note |
| --- | --- | --- |
| First sync never succeeds (server down, wrong URL, Dana not signed in) | `pending` with the reason; retried with backoff; no sessions | Fail closed, as the owner wants. An admin's typo locks every new Pi, visibly. |
| A required plugin fails to install or build on the first sync | `pending` with the plugin and its error | Required means required. |
| Enrollment file present but invalid | `pending` with the parse error | Never unmanaged. |
| Enrollment file missing | `unmanaged` on the next start | Only root can remove it (root-owned file and parent directories). The path is fixed in base code. On an Org Device the Device's supervisor refuses to start a member Pi without it. |
| Offline after the first sync | `ready` from the cache, `live: false` | With `maxOffline` set: `stale` once it passes. None by default. |
| Cache edited or deleted under the Pi's Unix user | signature check fails or no cache: `pending` | Fail closed. |
| Older signed profile replayed | refused while the Pi knows a higher revision; after a deleted cache, accepted until the next sync | Bounded by `maxOffline`. |
| Profile for another member or Pi | refused (`member`, `pi`) | Signed is not enough. |
| Plugin source outside `pluginSources` | the profile is refused | Bounds what a stolen org key can push. |
| Profile names a setting no loaded plugin declares | kept in the layer; applies when the plugin loads | A plugin installed later is managed from its first moment. |
| An org value fails the plugin's schema | that setting reads its initial value and refuses writes; reported to Acme | The rest applies. |
| Update tightens while sessions run | settings change live; MCP disconnects, shares and peer links end; removed plugins unload on Apply | Calls already sent cannot be recalled. |
| Update's plugin install fails | settings applied, the failed plugin's previous version keeps running; reported and retried | A tightening never waits for an install. |
| Dana or her Pi removed from Acme | `revoked`: locked; data stays | Radius ends org access at once. What happens to the data on an Org Device is Acme's decision. |
| Org server or Radius compromised, org key safe | cannot forge profiles | Radius still controls its own enforcement (sharing, peers, models). |
| Org key compromised | can push code to every enrolled Pi | Pinned refs and hashes, `pluginSources` in the root-owned file. Required plugins are a code-push channel by design. |
| Clock set back to dodge `maxOffline` | the check passes | Guardrail: the clock belongs to the machine. |
| Shell under the Pi's Unix user | can run a modified Pi on the same data | Without lock-down, not enforceable on the machine; Radius-side checks hold. With chapter VI, the member's shell is not that user. |
| A copy of the Pi's data and token on another machine | gets no Radius token: it cannot prove the device key | Org models, MCP credentials, relay and peers stay closed to it (chapter VI, (e)). |
| Root, or an admitted plugin | ignores everything | Root is the admin; admitting a plugin is the trust decision. |

# What the Base Needs Now {#now lede="What p3 must build before any org exists, and what waits for December 18."}

The org machinery itself is small and late: an enrollment reader, a client, a gate page. What is expensive to add later
is the shape it relies on: that every piece of configuration is a declared setting with one write path, and that every
place that starts a session or loads a plugin asks one gate. With no org, all of it is one store and a constant.

## Now, for December 1

1. **One settings mechanism.** `defineSetting`, `SettingKinds`, the `Settings` store with `set` as the only write path,
   and `setting(self, token)` for readers. No plugin JSON files like p2's `mcp.json` and `models.json`: MCP servers,
   model providers, company or personal instructions and the plugin list are settings from the start.
2. **The `managed` error.** `set` throws it for a locked setting; the page, the terminal and the agent's settings tool
   render it as "Managed by X", and the page draws locks from `Settings.managed`.
3. **Plugins only through the base.** Installs, Apply and the plugin-writing tool are methods of one base object
   (`Plugins`, on top of the kit's `PluginManager` binding, base inventory #14), never a side effect of a file write; the member root is a separate root from
   the app's own.
4. **Base switches with permissive defaults:** `p3.sharing.audience` (`"anyone" | "org" | "nobody"`) and
   `p3.peers.audience`. The share and peer paths read them, and end shares and links that no longer conform when they
   change.
5. **A gate that is always `unmanaged`,** already consulted by the worker kind's `start` and `authorize` and by
   Apply.
6. **Credentials by reference.** Setting values name credentials (`auth: { radius: "jira" }`) and never contain them
   (base inventory #13).

## For December 18

- The enrollment reader and its fixed path; `readStart` in the start script.
- `OrgGate`, `OrgClient`, the profile cache and the gate page ("Connect to Acme", the reason, sign-in).
- The kit change: plugin roots and `admit`.
- Hash checks of the org root at start and before each Apply.
- In Radius: the profile editor per org and group, per-member profiles, signing, the `revoked` answer, "Create my Pi
  here", and enforcement of sharing and peers from the same profile.
- On Org Devices: the Device setup writes the enrollment file; its supervisor refuses to start a member Pi without it.
- The lock-down of chapter VI for Linux Org Devices: a service user and systemd unit per member Pi, the root-owned
  install in `/opt/p3`, sandbox-only environments (Gondolin, KVM on the Device), restriction plugins with the base's
  required-extensions registry, the client token file in the member's home, and the key-file form of the device key.
  The single signed executable, launchd and Windows services, hardware keys and execution control wait for laptops.

# What It Cannot Do {.epilogue lede="The limits of managed settings, and the decisions still open."}

Managed settings lock configuration. That covers what Acme asked for: provisioning, closed lists, audiences, approved
plugins. It does not cover everything, and the limits are deliberate.

- **Rules over values.** "MCP servers only on `*.acme.com`" or a token budget is not a lock. A plugin has to offer a
  setting for it (an allowed-hosts setting), and budgets belong at Radius.
- **Denying an action that is not configuration,** such as exporting or deleting a session, unless the base or the
  plugin exposes a switch setting for it.
- **Different rights for different people in one Pi.** There is one person per Pi; Radius picks the profile per
  member, and guests get what the session gives them.
- **A plugin's private config files.** The answer is the plugin list.
- **A shell under the Pi's Unix user, root, or an admitted plugin.** They are past the boundary.
- **Instant revocation while offline,** and replays of an older signed profile, unless Acme sets `maxOffline`.
- **Running without the org server.** A new enrolled Pi does nothing before its first sync, by design.
- **One Pi in two orgs.** The enrollment file names one.

## Decisions needed

1. **Who holds the org key.** The admin in the browser (Radius cannot forge profiles; key loss and rotation are the
   org's problem), or Radius per org (simpler; a compromised Radius can push code). Recommended: Radius for December 18,
   with the key id in the profile so an admin-held key can replace it later.
2. **`maxOffline` default.** None (offline work always continues) or a default such as 30 days for Org Devices.
3. **Instructions as entries.** `prompt.instructions` is drawn here as an entries setting so Acme's text and Dana's sit
   side by side. The harness's prompt design may want a different owner for it.
4. **What `revoked` does to data on an Org Device.** Keep it (as here), export it to the org, or delete it.
5. **Lock-down on laptops.** A per-member system service with sandbox-only tools (chapter VI) protects the Pi's files
   from the member's shell, but costs a service user, a signed install and a VM per sandbox, and has no Windows form
   yet. The alternative is a Pi under the member's own user with Radius-side enforcement only. Recommended: the
   service on Org Devices from Dec 18; decide for laptops once an org asks for MDM deployment.
6. **Hosts without virtualization.** Sandbox-only needs `/dev/kvm` (or macOS's hypervisor) and has no Windows support.
   On such a host an org can allow `ssh` environments to a machine it controls, or no tools at all; running tools as
   the member (the sudo rule this edition dropped) is the fallback only if the owner wants one.

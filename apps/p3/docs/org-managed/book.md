---
title: p3: org-managed Pis through managed settings
cover: Org-Managed / Pis
kicker: A design book · p3 · first edition · 2026-11-13
subtitle: How Acme gives every member's Pi its plugins, MCP servers and models, and closes what it must, without a policy language
stats:
  - 1 | write path for every setting, Settings.set
  - 2 | locks a managed setting can have, default and locked
  - 5 | gate states, from unmanaged to revoked
  - 1 | kit change, plugin roots and admit
note: |
  The design the owner chose on 2026-11-13 ("I'm in favor of the Opus model ... it just needs to be flexible"), written
  from the consultation `org-opus` and the good parts of `org-fable`, `org-astra` and `org-sol` (read-only notes in
  `/tmp`, not in the repo). Every Chord API used in the code was checked against `packages/chord/src` on origin/main
  `8f3f08561`; every p3 name is a proposal. Nothing is built: every code block is marked PROPOSED. Notes marked
  *review* are corrections to the consultation or points still open.
colophon: p3 org-managed Pis · design, first edition · 2026-11-13 · sources: org consultations (opus, fable, astra, sol), apps/p3/docs/decisions.md, packages/chord/src
---

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

## Eight things to know

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
even against a modified Pi, because Radius enforces it.

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
  "pluginSources": ["github.com/acme/"]
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
        "acme-tools":   { "source": { "git": "github.com/acme/p3-tools", "ref": "v1.4.0" },   "hash": "sha256-9c1e…", "required": true },
        "acme-deploy":  { "source": { "git": "github.com/acme/p3-deploy", "ref": "v0.9.2" },  "hash": "sha256-41b0…", "required": true },
        "acme-reviews": { "source": { "git": "github.com/acme/p3-reviews", "ref": "v2.0.1" }, "hash": "sha256-77de…", "required": false }
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

A setting is a token in the contract file of the plugin that owns it, like a `defineState` token. The plugin
contributes it to the registry `SettingKinds`, from which the settings page renders its forms.

```ts
// PROPOSED · @p3/app/v1/settings.ts (base contract file). Chord API: defineRegistry, keyedEntries, TableItem, Schema.
export type SettingKind = {
	readonly name: string;
	readonly schema: Schema;
	readonly merge: "value" | "entries";
	readonly initial: JsonValue;
};

/** Declares a setting; its plugin contributes it to `SettingKinds` and reads it with `setting(self, token)`. */
export function defineSetting<S extends Schema>(
	name: string,
	schema: S,
	options: { readonly merge: "value" | "entries"; readonly initial: Static<S> },
): SettingKind & { readonly initial: Static<S> } {
	return { name, schema, merge: options.merge, initial: options.initial };
}

/** Every declared setting by name, with the plugin that contributed it (the first by plugin name wins a name). */
export const SettingKinds = defineRegistry<readonly SettingKind[], ReadonlyMap<string, TableItem<SettingKind>>>(
	"p3.setting-kinds",
	{ version: 1 },
);
```

The base serves `SettingKinds` with `keyedEntries(table, (kinds) => Object.fromEntries(kinds.map((k) => [k.name, k])),
report)`, which reports a name two plugins declare.

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
layer.

```ts
// PROPOSED · @p3/app/v1/settings.ts. Chord API: local, method, obj, str, arr, map, unknown, oneOf, union, nul.
export const Settings = local("p3.settings", {
	version: 1,
	params: {},
	members: {
		/** Effective values by setting name. */
		effective: map(unknown()),
		/** The names the org manages, with their lock and the names of the org's entries: what the page marks. */
		managed: map(obj({ org: str(), lock: oneOf("default", "locked"), entries: arr(str()) })),
		/** Sets a value setting, or puts (`value`) or removes (`null`) one entry of an entries setting. */
		set: method(union([
			obj({ name: str(), value: unknown() }),
			obj({ name: str(), entry: str(), value: union([unknown(), nul()]) }),
		])),
	},
});
```

```ts
// PROPOSED · plugins/settings/server.ts (app root). Chord API: defineState (persist, checkpointWhen), StoreSelf.state,
// self.registry, self.get, self.derive, reference members' .value, PluginError (data/errors.ts), handle.change.
const UserLayer = defineState("p3.settings.user", {
	schema: obj({ values: map(unknown()) }),
	version: 1,
	initial: () => ({ values: {} }),
	persist: true,
	checkpointWhen: () => true,
});

host.serve(Settings, (_params, self) => {
	const user = self.state(UserLayer);
	const kinds = self.registry(SettingKinds);
	const gate = self.get(OrgGate, {}).gate;
	return {
		effective: self.derive([user, kinds, gate], ([u, k, g]) => effectiveAll(u.values, k, g)),
		managed: self.derive([gate], ([g]) => managedMarks(g)),
		set: async (args, ctx) => {
			// Followed state, read per call: a profile that arrived since the last call counts.
			const g = gate.value;
			if (g.kind !== "unmanaged" && g.kind !== "ready") throw new PluginError("gated", `Waiting for ${g.orgName}`);
			const kind = kinds.value.get(args.name)?.value;
			if (kind === undefined) throw new PluginError("unknown_setting", `No setting ${args.name}`);
			const managed = g.kind === "ready" ? g.profile.settings[args.name] : undefined;
			if (managed !== undefined && (managed.lock === "locked" || ("entry" in args && args.entry in managed.value)))
				throw new PluginError("managed", `Managed by ${g.orgName}`, { org: g.org, setting: args.name });
			// Trust boundary: the page's and the agent's input, checked against the declaring plugin's schema.
			const next = "entry" in args ? withEntry(user.value.values[args.name], args.entry, args.value) : args.value;
			validate(kind.schema, next);
			await user.change((draft) => { draft.values[args.name] = next; }, ctx);
		},
	};
});
```

`effectiveAll`, `managedMarks`, `withEntry` and `validate` are small pure helpers of the settings plugin: the table above,
the page's marks, a record with one entry put or removed, and a pi-schema check. The error carries the code `managed`;
pages and the terminal render it as "Managed by Acme", and draw a lock beside every name in `managed`. Dana's agent
gets the same error from its settings tool, which calls the same `set`.

:::note | Workers read settings through the server
`Settings` is a server object. A session worker that needs a setting (the harness reading `prompt.instructions`)
follows it through a server view, as other per-session server data is followed today; the worker never holds its own
copy.
:::

## What a plugin author writes

The MCP plugin declares its servers as a setting, contributes it, and reconciles its connections with the effective
value. It never names an org, a lock, a gate or a principal.

```ts
// PROPOSED · plugins/mcp: everything it writes for orgs is nothing. Chord API: defineFacet's (host, self),
// FacetSelf.contribute, host.serve, self.on.
export const McpServers = defineSetting("mcp.servers", map(McpServerConfig), { merge: "entries", initial: {} });

export default defineFacet((host, facet) => {
	facet.contribute(SettingKinds, [McpServers]);
	host.serve(McpConnections, (_params, self) => {
		const servers = setting(self, McpServers);           // Acme's entries, plus Dana's unless locked
		self.on(servers, ({ value }, ctx) => reconcile(value, ctx));   // a server an update locks out disconnects now
		return { /* … */ };
	});
});
```

```ts
// PROPOSED · @p3/app/v1/settings.ts. Chord API: self.get, self.derive.
/** A setting's effective value, for any server object. */
export function setting<T extends JsonValue>(self: Self, token: { readonly name: string; readonly initial: T }): Watchable<T> {
	const all = self.get(Settings, {}).effective;
	// Cast: `set` and the profile check validated the value against this token's schema.
	return self.derive([all], ([values]) => (values[token.name] ?? token.initial) as T);
}
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
const start = readGate(ENROLLMENT_PATH, dataDir);       // sync: enrollment, cache, signature, maxOffline
let held: Reference<typeof OrgGate> | undefined;
const gate = () => held?.gate.value ?? start;           // the start read until OrgGate is live

const app = await startServer<P3Principal>({
	name: "p3",
	dataDir,
	// … api, kinds, principal, web …
	workers: [{ ...sessionKind, authorize: (principal, address) => isOpen(gate()) && mayUse(principal, address) }],
	plugins: {
		roots: [orgRoot(dataDir), memberRoot(dataDir)],
		admit: (plugin) => admits(gate(), plugin),
	},
}, context);
held = await app.host.get(OrgGate, {}, context);
```

`admits` is four lines. The app root always loads. Nothing else loads while the gate is locked. In the org root, a
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
// profiles, and writes the cache by atomic rename; `PluginManager` is base inventory #14 (install, apply).
host.serve(OrgGate, (_params, self) => {
	const client = self.open((ctx) => openOrgClient(ctx), (c) => c.close());
	// { enrollment, cached, offered, revoked, live, now }: the client's observer, attached once it opened.
	const org = self.follow((observer, ctx) => client.value.attach(observer, ctx));
	const plugins = self.get(PluginManager, {});
	const offered = self.derive([org], ([o]) => o.offered);   // a checked profile newer than the cache, or null
	self.on(offered, async ({ value }, ctx) => {
		if (value === null) return;
		const first = org.value.cached === null;
		// First sync: required plugins install before anything opens; a throw leaves the gate pending.
		if (first) await plugins.reconcile(orgPlugins(value), ctx);
		await client.value.commit(value, ctx);                  // the cache is the managed layer: settings apply now
		// Updates: settings first, plugins when installed; failures are reported and retried, never thrown.
		if (!first) await plugins.reconcile(orgPlugins(value), ctx);
		await plugins.apply(ctx);                               // readmit, then the kit's applyChanges
	});
	return { gate: self.derive([org], ([o]) => gateOf(o)) };
});
```

`gateOf` is the table of five states as a pure function. The first sync is the same routine: with no cache, `offered`
is the first profile, and the cache is written only after `reconcile` installed the required plugins. When the
routine throws, the client offers the profile again after its backoff.

# Guardrails and Walls {#trust lede="Who this stops, who it does not, and what Radius enforces whatever the Pi does."}

Every check in the Pi runs in the Pi's process, as the Pi's Unix user. That decides what it can stop. The design is
honest about it: in the Pi, managed settings are a guardrail; where Radius sits in the path, they are a wall.

## Three adversaries

**Dana's agent** is the main target: prompt injection or plain sloppiness. Its ordinary means are the settings tool,
the plugin tools, the share tool and file edits. `Settings.set` refuses locked settings. The base's install path
refuses plugins outside the profile, and `admit` keeps unapproved code from loading. The enrollment file is root-owned.
An edited cache fails its signature, and the gate falls back to `pending`. All of these hold. What does not hold is
`bash` under the Pi's Unix user: it can start a modified copy of the Pi on the same data directory, with Dana's token,
ignoring the gate. That is the decided trust line ("The agent writes plugins": the boundary is access to the server).

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
| Required and approved plugins only | install path, `admit`, hash checks | guardrail: the org root is written by the Pi's Unix user. On an Org Device a root-owned root is stronger (below). |
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
| Shell under the Pi's Unix user | can run a modified Pi on the same data | Not enforceable on the machine; Radius-side checks hold. |
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
   (`PluginManager`, base inventory #14), never a side effect of a file write; the member root is a separate root from
   the app's own.
4. **Base switches with permissive defaults:** `p3.sharing.audience` (`"anyone" | "org" | "nobody"`) and
   `p3.peers.audience`. The share and peer paths read them, and end shares and links that no longer conform when they
   change.
5. **A gate that is always `unmanaged`,** already consulted by the worker kind's `start` and `authorize` and by
   Apply.
6. **Credentials by reference.** Setting values name credentials (`auth: { radius: "jira" }`) and never contain them
   (base inventory #13).

## For December 18

- The enrollment reader and its fixed path; `readGate` in the start script.
- `OrgGate`, `OrgClient`, the profile cache and the gate page ("Connect to Acme", the reason, sign-in).
- The kit change: plugin roots and `admit`.
- Hash checks of the org root at start and before each Apply.
- In Radius: the profile editor per org and group, per-member profiles, signing, the `revoked` answer, "Create my Pi
  here", and enforcement of sharing and peers from the same profile.
- On Org Devices: the Device setup writes the enrollment file; its supervisor refuses to start a member Pi without it.

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

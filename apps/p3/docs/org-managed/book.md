---
title: p3: org-managed Pis
cover: Org-Managed / Pis
kicker: A design note · p3 · fifth edition · 2026-11-13
subtitle: A small base, Earendil plugins on top, and a deployment profile Acme edits in Radius without ever seeing a plugin
stats:
  - 3 | base mechanisms
  - 6 | Earendil plugins
  - 1 | write path for every setting
note: |
  The owner's model of 2026-11-13: "a nice base system in p3 that allows us to model all this as Earendil plugins we can
  provide to enterprise users when they configure deployment profiles for their employees. the Radius UI might even hide
  the fact that things are implemented as plugins behind the scenes." Code is PROPOSED; Chord, Durable and Gondolin APIs
  in it exist on origin/main. Full traces, platform lock-down, failure modes and kit details: `details.md` next to this
  file (not part of this page).
colophon: p3 org-managed Pis · fifth edition, short · 2026-11-13
---

> **Partly superseded (2026-11-13, evening):** the settings layer (`defineSetting`, managed layer) is replaced by locks and the org profile as the company layer in `apps/p3/docs/people/book.md`; enrollment, the gate and machine lock-down here stay valid.


# The Model {.nodrop}

Each person has one Pi. An org configures its members' Pis through a **deployment profile**: a list of Earendil
plugins plus their settings, each preset (the member may change it) or locked. The machine's admin writes a root-owned
**enrollment file** ("this machine belongs to Acme, its server is this Radius URL, its key is this"). An enrolled Pi
stays locked until its first sync with Radius has delivered and applied the signed profile; after that it starts from
its cached copy and follows changes live. Radius shows the plugins as features with forms generated from their declared
settings, so Acme's admin configures "Agent sandboxes" and "Sharing", not plugins. p2 already has the hard parts
(Gondolin sandboxes in `apps/p2/plugins/envs`, session locks in `apps/p2/src/runtime/session-lock.ts`); p3 needs the base
that lets an org set them.

# The Base {.nodrop}

Three mechanisms, none of which knows about orgs. A personal Pi uses them too.

## 1. Settings: declared by plugins, preset or locked, one write path

A plugin declares each setting once. A trusted plugin (the `org` plugin, installed by the admin) provides one managed
layer over the member's values. Every write, from the page, the agent's tools or another plugin, goes through
`Settings.set`, which refuses a locked setting or a managed entry.

```ts
// PROPOSED · plugins/mcp/contract.ts: what a plugin author writes. Nothing about orgs.
export const McpServers = defineSetting("mcp.servers", map(McpServerConfig), {
	title: "MCP servers",
	description: "Remote MCP servers whose tools the agent can use.",
	merge: "entries", // a record by name; "value" for one value
	initial: {},
});

// PROPOSED · plugins/settings/server.ts (base): the check inside Settings.set.
const managed = layer?.settings[write.name]; // { lock: "preset" | "locked", value }
if (managed?.lock === "locked")
	throw new PluginError("managed", `Managed by ${layer.source}: ${write.name} is locked`, { setting: write.name });
if (write.kind === "entry" && managed !== undefined && Object.hasOwn(managed.value as object, write.entry))
	throw new PluginError("managed", `Managed by ${layer.source}: the entry ${write.entry}`, { setting: write.name });
```

Effective value: locked → the managed value; preset → the member's value, else the managed one (entries: both,
managed entries read-only); while the startup is held → the initial value. Locked member values are kept, not deleted.

## 2. Plugin admission: required, allowed, forbidden, own

The plugin list is two base settings, filled by the profile like any other. The kit asks `admits` at every discovery
(kit change: `startServer` takes plugin roots and an `admit` function).

```ts
// PROPOSED · src/admit.ts (base). Roots: app (base), system (Earendil, admin-installed), org (pinned), member.
export function admits(state: AdmitState, plugin: Plugin, roots: Roots): boolean {
	if (plugin.root === roots.app) return true;
	const entry = state.entries[plugin.name]; // effective "p3.plugins": required | allowed | forbidden, with source and hash
	if (entry?.mode === "forbidden") return false;
	if (plugin.root === roots.system) return true;
	if (state.held) return false; // nothing the profile or the member brings runs before the holds release
	if (plugin.root === roots.org) return entry !== undefined && state.verified[plugin.name] === entry.hash;
	return state.own; // effective "p3.plugins.own": installed-from-anywhere and agent-written plugins
}
```

Installs, writes and Apply go only through the base's `Plugins` service, which installs pinned entries into the org
root and keeps them only if their tree hash matches.

## 3. Startup gate: a trusted plugin holds the Pi until it is ready

```ts
// PROPOSED · app/v1/startup.ts (base). Only system-root plugins' holds count.
export const Hold = obj({ title: str(), why: str() });
export const StartupHolds = defineRegistry<Hold | null, readonly TableItem<Hold | null>[]>("p3.startup-holds", { version: 1 });

// PROPOSED · plugins/org/server.ts (Earendil): held until a verified profile is applied.
self.contribute(StartupHolds, self.derive([org], ([o]) => (o.applied === null ? { title: "Acme", why: o.why } : null)));
```

While held: no session worker starts, only the app and system roots load, settings read their initial values, and the
page shows the hold ("Connect to Acme", with a Radius sign-in). When the last hold goes, the base readmits and applies.

# Acme's Deployment Profile {.nodrop}

What Acme's admin sees in Radius as a few feature forms is, underneath, this signed document:

```json
// PROPOSED · served by Radius to Dana's Pi
{
  "payload": {
    "org": "acme", "orgName": "Acme", "member": "dana@acme.com", "pi": "pi_7f3a", "revision": 42,
    "plugins": {
      "org":           { "mode": "required", "source": { "system": true } },
      "device-key":    { "mode": "required", "source": { "system": true } },
      "environments":  { "mode": "required", "source": { "system": true }, "settings": {
        "environments.kinds": { "lock": "locked", "value": ["sandbox"] },
        "sandbox.folders":    { "lock": "locked", "value": [{ "path": "~/work/acme", "writable": true }] },
        "sandbox.allowHosts": { "lock": "locked", "value": ["github.com", "registry.npmjs.org", "*.acme.internal"] } } },
      "tool-rules":    { "mode": "required", "source": { "system": true }, "settings": {
        "tools.blocked": { "lock": "locked", "value": ["mcp__linear__delete_*", "session_export"] } } },
      "sharing":       { "mode": "required", "source": { "system": true }, "settings": {
        "sharing.audience": { "lock": "locked", "value": "org" } } },
      "mcp":           { "mode": "required", "source": { "system": true }, "settings": {
        "mcp.servers": { "lock": "locked", "value": {
          "jira":   { "url": "https://mcp.atlassian.com/v1/sse", "auth": { "radius": "jira" } },
          "linear": { "url": "https://mcp.linear.app/mcp", "auth": { "radius": "linear" } } } } } },
      "acme-deploy":   { "mode": "required", "source": { "git": "https://github.com/acme/p3-deploy", "ref": "v0.9.2" },
                         "hash": "sha256-41b0…", "settings": {
        "deploy.targets": { "lock": "locked", "value": { "staging": { "host": "deploy.staging.acme.internal" } } } } },
      "acme-reviews":  { "mode": "allowed", "source": { "git": "https://github.com/acme/p3-reviews", "ref": "v2.0.1" },
                         "hash": "sha256-77de…" }
    },
    "ownPlugins": { "lock": "locked", "value": false }
  },
  "signature": { "alg": "ed25519", "key": "acme-2026-11", "value": "Zm9v…" }
}
```

The `org` plugin checks the signature and the binding to Dana and her Pi, then turns this into the managed layer: the
plugin entries become `p3.plugins`, `ownPlugins` becomes `p3.plugins.own`, each plugin's settings go in as they are.
Radius builds the admin forms from each catalog plugin's manifest: its feature title and its `defineSetting` metadata
(title, description, JSON schema), with a "members choose / preset / locked" control per setting.

| Earendil plugin | What it does | Settings |
| --- | --- | --- |
| `org` | reads the enrollment file, follows the profile from Radius, checks the signature, holds the startup until the first sync, provides the managed layer | `org.maxOffline` |
| `environments` | runs the agent's tools only in Gondolin sandboxes with allowed folders and hosts (p2's `plugins/envs`, `GondolinEnvConfigSchema`); Gondolin runs its VMs on QEMU or krun (libkrun, `sandbox.vmm = "krun"`, prebuilt runners for macOS arm64 and Linux x64, the macOS runner signed with the hypervisor entitlement) | `environments.kinds`, `sandbox.folders`, `sandbox.allowHosts` |
| `mcp` | MCP connections; the "MCP lock" is just this setting, locked | `mcp.servers` |
| `sharing` | shares sessions through the Radius relay; Radius applies the same audience | `sharing.audience` |
| `tool-rules` | blocks tools in every session through Durable's `beforeTool` hook (`{ block }`), built on p2's session lock and tool guard (`tool-access.ts`) | `tools.blocked`, `sessions.lock` |
| `device-key` | keeps a key in the TPM or Secure Enclave; Radius issues tokens for Acme's models, MCP accounts, relay and peers only against it | `deviceKey.required` |

# One Trace: Dana Adds an MCP Server {.nodrop}

**From the page.** The MCP settings section renders from the settings view, so it knows the list is locked before
anyone clicks:

```tsx
// PROPOSED · plugins/mcp/web.tsx
const view = useHold(SettingsView, {});
const servers = useWatch(view?.effective)?.[McpServers.name] ?? {}; // { jira, linear }
const mark = useWatch(view?.managed)?.[McpServers.name]; // { source: "Acme", lock: "locked", entries: [...] }
// Rows in mark.entries get a lock icon; "Add" is disabled with the title "Managed by Acme".
const add = (name: string, url: string) =>
	view?.set({ kind: "entry", name: McpServers.name, entry: name, value: { url, auth: null } }, BACKGROUND_CONTEXT)
		.catch((error) => setError(error instanceof PluginError ? error.message : String(error)));
```

A tab opened before the lock still shows "Add". The click calls `Settings.set`, which reads the current layer, finds
`mcp.servers` locked, and throws `managed`. The page shows **"Managed by Acme: mcp.servers is locked."**

**From the agent.** Dana asks it to connect a GitHub MCP server. Its `mcp_add_server` tool calls the same `set` through
the same view, and the harness turns the refusal into the tool result:

```text
Managed by Acme: mcp.servers is locked. The setting mcp.servers is managed by Acme and locked. Do not retry or look
for another way; tell the user to ask Acme's admin.
```

The other cases, in one line each:

- **Editing Acme's Jira entry:** `set` refuses a write to a managed entry, also when the list is only preset.
- **Installing `acme-reviews`:** allowed in the profile, so `Plugins` installs it into the org root, the hash matches,
  `admits` loads it.
- **Installing anything else, or the agent writing a plugin:** `p3.plugins.own` is locked off, so `Plugins` refuses, and
  `admits` would leave the files out anyway.
- **Sharing with `sam@partner.example`:** the sharing plugin refuses (not an Acme member), and Radius refuses the invite
  from the same profile even if a modified Pi skipped the check.
- **Acme removes Linear:** the new revision changes the layer, the MCP plugin's routine on its effective setting closes
  the connection, and running sessions lose Linear's tools at their next request.
- **Acme locks `deploy.targets`:** its own plugin reads the setting through `setting()` and never learns it is locked.
- **The agent tries to mount `~/.ssh`:** the environments plugin refuses: not under `sandbox.folders`.

# What Really Holds {.nodrop}

In the Pi, all of this is a guardrail. It becomes a wall where the operating system or Radius enforces it: on an Org
Device the Pi runs as its own service user from a root-owned, signed install; the agent's tools run in sandboxes; Radius
serves Acme's resources only to a Pi proving its device key. Answering Armin's "can't I just patch out the check?": not
in the managed Pi, which he cannot write or debug; a patched copy he runs himself gets nothing from Acme.

| Adversary | Held by | Not held |
| --- | --- | --- |
| Dana's agent | `Settings.set`, admission, sandboxes (sees only allowed folders and hosts), the service user | nothing it reaches through supported paths |
| Dana with a shell | the service user and root-owned install (cannot edit or debug the Pi), the device key (a copy gets nothing from Acme) | running her own unmanaged Pi with her own keys, unless the MDM's execution control stops it |
| Dana with admin rights | Radius only: sharing audience, peers, what the model gateway and MCP accounts allow | everything on that machine, including using the device key from a patched Pi |
| A third-party plugin | the plugin list: unlisted code never loads | everything once admitted: it runs inside the Pi |

# Open Decisions {.epilogue .nodrop}

1. Who holds the org key: the admin in the browser (Radius cannot forge profiles) or Radius per org (simpler).
2. A default `maxOffline` for Org Devices, or none (offline work always continues).
3. Which Gondolin backend per platform (krun on macOS arm64 and Linux x64, QEMU elsewhere), and what to do where neither has hardware virtualization (Windows; cloud machines without KVM, where QEMU falls back to slow software emulation): SSH environments, no tools, or tools as the member.
4. Laptops: a per-member service and signed install like Org Devices, or a Pi under the member's own user with Radius-side checks only.
5. What `revoked` does to a member's data on an Org Device: keep, export to the org, or delete.
6. Which Earendil plugins ship in the system root by default, and which are installed only when a profile requires them.

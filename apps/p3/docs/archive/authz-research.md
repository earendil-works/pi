# Users and permissions: prior art and the smallest model for p3

Research note for the owner, 2026-11-13 (subagent "authz-research"). Nothing here is decided. It builds on
`rundown/book.md` chapters I–VI and on decisions.md ("No per-run authority", "Resource model direction", "Instance
resources"). APIs marked *proposed* do not exist yet; every Chord call they use does.

## The problem in one paragraph

Two people write code that never meet. A plugin author (`@someone/p3-todos`) knows nothing about Acme's SSO, groups
or rules. Acme's admin knows nothing about todos. Every system below solves this the same way: **a small vocabulary
both sides know**. The plugin tags each of its operations with a word from it; the policy writes rules in those words
and names specific operations only when it cares. The systems differ in how big the vocabulary is, and the ones that
went wrong made it either too big (Zanzibar-style schemas everyone must merge, Backstage's conditional rules) or too
loose (AWS and Kubernetes wildcards that silently grant tomorrow's actions; Slack's old all-powerful `bot` scope).

## The model (one page)

**Three words are the whole vocabulary.**

1. **Owner** of the thing a call touches: `mine`, `instance`, or someone else's. Every plugin object that touches
   owned data has the flat params `{ owner, id }` (`owner` is a user id or `"instance"`). The base computes the
   relation from params and principal alone.
2. **Level** of each method: `read`, `write` or `admin`, declared by the plugin next to its contract. `admin` means
   the worst thing the call can cause is beyond the thing itself: it runs code, reaches a new host, deletes for
   everyone, grants access. (Kubernetes' lesson: "create a pod" quietly grants reading secrets. The level names the
   worst effect, not the verb.)
3. **Operation name** `plugin:method` (`@someone/p3-todos:purge`, the base's own `p3:create`, `p3:bring`,
   `p3:delete`). Only for policies that want one specific rule, as AWS actions are named.

**Hard rules (no policy changes them).** A user never reaches another user's resource directly; a resource reaches a
session only when its owner brings it (decided). A session's worker reaches only resources on its session's list; the policy was
applied when the list was computed, so worker calls are never asked again (decided: no per-run authority).

**The policy** is one synchronous, pure function over state its own plugin follows:
`decide(request, baseline) → allow | deny(reason)`, with
`request = { user, plugin, operation, level, kind, owner: "mine" | "instance" }`. The baseline is the base's own
answer: allow, except `admin` level for non-admins (admin comes from the directory, `users-sketch.md`). With no policy
plugin installed the baseline is the answer; a single user is admin, so "the single user may do everything"
(decided). Groups are the policy plugin's business: it follows them from its directory (SCIM, sign-in claims) as
state. The base has no groups, roles or ACL tables.

**What p3's base does in between.**

- **Wraps every method when serving** (`serveResource`, the rundown's `serveGated`, edge 2, without a Chord hook):
  user calls go through `policy.decide` with the method's level; worker calls go through "is `(kind, owner, id)` on
  my session's list". It adds a derived `may` state member (`{ add: true, purge: false }`) so pages hide buttons,
  and hides state for a reader the policy refuses `read` (members become `null`).
- **Keeps ownership and bringing**: the resource index (kind, owner, id, label), `create`, `delete` and `bring` as
  its own operations `p3:*`, each asked of the policy with `owner` and `kind`. The plugin keys its data by
  `owner/id` and never sees a principal.
- **Computes each session's list** in a derive over the source (own list, owner's defaults, a grouping), the index
  and the policy; a resource the policy now refuses drops out live, and the wrapped methods start refusing at once.
- **Starts one extension per list entry** of a kind, from the plugin's per-resource extension factory, on the worker
  (decided: one Durable extension = one resource).

**How the synchronous factory rule is kept.** The factory decides only what params and principal tell it: user or
worker; `mine`, `instance` or someone else's (refused right there). It *declares* the policy registry and, for a
worker, the session's list. Everything that changes (groups, policy settings, the list) is followed state, read
synchronously inside each wrapped method and inside derives. That is why the policy must be synchronous: the same
function answers a method call, the `may` member, the session list and "which kinds may I create". The directory's
async work (SCIM, token refresh) runs in the policy plugin's own routines and lands as state.

**How an unknown plugin is governed.** Its operations already carry levels (the contract helper's types require a
level for every method, so agent-written plugins cannot forget one). A company policy's level rules apply to it the
moment it is installed, as Grafana's `grants` and Kubernetes' `aggregate-to-edit` do. A policy can also refuse a
plugin by name until approved (Chrome's `ExtensionSettings` `"*"` entry). Its tools reach no session unless someone
brings its resources, and its built-in tools are instance resources whose bringing is `p3:bring`, a policy question
(decided 2026-11-13).

**What it copies.** **Backstage's split**: plugins declare named permissions with one `action` attribute and a
resource type; exactly one policy decides; generic rules key on the attribute, specific rules on the name. Backstage
is the only system built for exactly our two audiences inside one app. Plus **Kubernetes/Grafana's three default
levels** (view/edit/admin; Viewer/Editor/Admin) as the attribute. Dropped from Backstage: async policies and
conditional decisions (the plugin-supplied rules like "is owner" that the plugin evaluates): p3 has exactly one
relation, owner, and the base knows it from params.

**Not covered here.** Who may view or send in a session is the session's own membership (rundown chapter V, options
a/b/c), not policy. Sharing a resource with another user directly does not exist; you bring it into a session.

## Example 1: what a plugin author writes

```ts
// PROPOSED · @someone/p3-todos/contract.ts
import { arr, method, obj, str } from "@p3/app/v1";
import { resourceKind } from "@p3/app/v1/resources";

/** A todo list is a resource: owned by a user or the instance, brought into sessions. */
export const TodoList = resourceKind("todos.list", {
	version: 1,
	// The helper adds params { owner: str(), id: str() } and the derived `may` state member.
	state: { items: arr(Todo) },
	methods: {
		add: method(obj({ text: str() }), str()),
		done: method(obj({ id: str() })),
		purge: method(), // empties the list for everyone who brought it
	},
	levels: { add: "write", done: "write", purge: "admin" }, // a missing method is a type error
});

// PROPOSED · @someone/p3-todos/server.ts: no principal, no policy, no session in sight
export default defineFacet((host) => {
	host.serve(TodoStore, (_params, self) => {
		const lists = self.state(Lists); // defineState(…, { keyed: true }): one document per "owner/id"
		return {
			lists,
			add: async ({ list, text }, ctx) => {
				const id = newId();
				await lists.change(list, (draft) => { draft.items.push({ id, text, done: false }); }, ctx);
				return id;
			},
			// … done, purge
		};
	});
	serveResource(host, TodoList, ({ owner, id }, self) => {
		const store = self.get(TodoStore, {});
		const key = `${owner}/${id}`;
		return {
			items: self.derive([store.lists.at(key)], ([doc]) => doc.items), // pinned from params: synchronous
			add: ({ text }, ctx) => store.add({ list: key, text }, ctx),
			done: ({ id: item }, ctx) => store.done({ list: key, item }, ctx),
			purge: (_args, ctx) => store.purge({ list: key }, ctx),
		};
	});
});

// PROPOSED · @someone/p3-todos/worker.ts: one extension per todo list on the session's list
export default defineFacet((host) => {
	resourceTools(host, TodoList, (list) => ({
		namespace: "todos",
		tools: [tool("add", obj({ text: str() }), ({ text }, ctx) => list.add({ text }, ctx))],
	}));
});
```

## Example 2: what a policy author writes

```ts
// PROPOSED · @acme/p3-policy/server.ts: Acme's rules over SSO groups. Knows no plugin except the two it names.
import { defineFacet, local, Policy, allow, deny, type PolicyProvider, type UserId } from "@p3/app/v1/server";
import { AcmeMembers } from "@acme/p3-sso/contract"; // SCIM-synced members and groups, followed as state

const APPROVED = new Set(["p3", "@pi/mcp", "@pi/coding-tools", "@someone/p3-todos"]);

const AcmePolicy = local("acme.policy", { version: 1, params: {}, members: {} });

export default defineFacet((host) => {
	host.serve(AcmePolicy, (_params, self) => {
		const members = self.get(AcmeMembers, {}).groupsByUser; // Record<UserId, string[]>, kept by the SSO plugin
		// Values arrive after the factory: start with no groups (fail closed), rebuild on every change.
		const provider = self.writable<PolicyProvider>(build({}));
		self.on(members, (call) => provider.set(build(call.value)));
		self.contribute(Policy, provider);
		return {};
	});
});

function build(groupsByUser: Readonly<Record<UserId, readonly string[]>>): PolicyProvider {
	return {
		decide(request, baseline) {
			const groups = groupsByUser[request.user] ?? [];
			if (groups.includes("p3-admins")) return allow();
			// Unknown plugins: own data only, read only, until IT approves them.
			if (!APPROVED.has(request.plugin))
				return request.owner === "mine" && request.level === "read" ? baseline : deny(`${request.plugin} is not approved at Acme`);
			if (request.level === "admin") return deny("Ask #it-help: admins only.");
			// Company resources: everyone may use and bring them, only admins change them.
			if (request.owner === "instance" && request.level === "write" && request.operation !== "p3:bring")
				return deny("Company resources are read-only for you.");
			// One specific rule: names an operation, as an AWS policy names s3:PutObject.
			if (request.operation === "@pi/mcp:configure" && !groups.includes("engineering"))
				return deny("Only engineering adds MCP servers.");
			return baseline;
		},
	};
}
```

## Prior art

| System | Extension author declares | Policy author writes | Unknown extension by default | Groups | What went wrong / lesson for p3 |
| --- | --- | --- | --- | --- | --- |
| Kubernetes RBAC + CRDs [1][2] | resource types; ships ClusterRoles labelled `aggregate-to-view/edit/admin` | Roles over (apiGroup, resource, verb), bound to users/groups | no access unless its author aggregated into the default roles | from the authenticator; bindings name them | wildcards grant "all object types which are created in the future"; verbs understate effects (create pod ⇒ read secrets). **Copy the three default levels; level = worst effect.** |
| AWS IAM [3] | per service: actions, resource ARNs, condition keys, an access level per action (List, Read, Write, Permissions management, Tagging) | JSON policies over actions, ARNs, conditions; `s3:Get*` wildcards | covered by `*`/prefix wildcards and AWS-managed policies that AWS extends | IAM groups, roles | wildcards and managed policies silently widen with new actions; thousands of names nobody can review. **Copy `plugin:action` names and the access-level idea; no wildcards.** |
| Cedar [4] | schema: entity types, actions with `appliesTo`, action groups | `permit`/`forbid` over principal, action, resource; default deny, forbid wins | must appear in the schema to validate | entity hierarchy (`User in Group`) | strong but a language plus a schema to merge. **A company policy plugin may use Cedar inside `decide`; p3 need not.** |
| Zanzibar / OpenFGA / SpiceDB [5] | a type with relations and permissions (`permission view = reader + writer`) | relation tuples; the model | needs its types merged into the one model (OpenFGA added modular models for this) | `group#member` tuples synced from the directory | sync of directory into tuples, one shared schema. **p3 has one relation (owner) plus session lists; not worth a graph.** |
| Android [6] | `<uses-permission>`; custom permissions with protection level normal/dangerous/signature | Device Policy: auto-grant/deny per permission | normal granted at install, dangerous asked at runtime | none | consent fatigue; level chosen by the defining app. **No per-user prompts; the admin installs, users bring.** |
| OAuth scopes [7] | the resource server defines opaque scope strings | consent per client and scope | whatever the user consents to | none | scopes either too coarse or an explosion. **Levels coarse, names for exceptions.** |
| Chrome extensions + `ExtensionSettings` [8] | `permissions`, `host_permissions` in the manifest | per-id or `"*"`: `installation_mode`, `blocked_permissions`, `runtime_blocked_hosts` | allowed unless `"*"` blocks; blocked permissions refuse install | OU in the admin console | a permission increase in an update disables the extension until approved. **Copy the `"*"` default plus allowlist by plugin name.** |
| VS Code workspace trust [9] | `capabilities.untrustedWorkspaces: true / false / "limited"` | user or org decides trust per folder | an extension with code and no declaration is disabled in Restricted Mode | none | coarse, but the default-closed declaration works. **Every method must declare a level (type error otherwise).** |
| Slack / Atlassian Forge [10] | scopes (`chat:write`, `read:jira-work`) in the manifest | admin approves the app and its scopes | needs admin approval; new scopes need re-approval (Forge: a major version) | workspace roles | Slack's classic `bot` scope was all-or-nothing and was replaced by granular scopes. **Levels per method, not per app.** |
| Backstage permissions [11] | `createPermission({ name, attributes: { action }, resourceType })` in a `-common` package | one `PermissionPolicy.handle(request, user)`; ALLOW, DENY or CONDITIONAL with plugin-exported rules | the policy sees `attributes.action`; the default is allow-all | ownership entity refs from the catalog | policy authors must learn names; conditional decisions are the hard part. **Copy the split; drop conditions and async.** |
| Grafana plugin RBAC [12] | `roles` in `plugin.json`: actions `plugin-id.thing:read`, and `grants: ["Viewer" / "Editor" / "Admin"]` | admins reassign roles to users and teams | its own default `grants` to basic roles apply | teams | works because defaults map onto three basic roles. **Same: levels map onto the baseline.** |

## Sources (fetched 2026-11-13)

1. Kubernetes RBAC, aggregated ClusterRoles: https://kubernetes.io/docs/reference/access-authn-authz/rbac/
2. Kubernetes RBAC good practices (wildcards, workload creation): https://kubernetes.io/docs/concepts/security/rbac-good-practices/
3. AWS IAM `Action` element: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_action.html ;
   access levels: https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_understand-policy-summary-access-level-summaries.html ;
   Service Authorization Reference: https://docs.aws.amazon.com/service-authorization/latest/reference/reference.html
4. Cedar schema and terminology: https://docs.cedarpolicy.com/schema/schema.html , https://docs.cedarpolicy.com/overview/terminology.html
5. Zanzibar: https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/ ; SpiceDB schema:
   https://authzed.com/docs/spicedb/concepts/schema ; OpenFGA modular models: https://openfga.dev/docs/modeling/modular-models
6. Android permissions: https://developer.android.com/guide/topics/permissions/overview , https://developer.android.com/guide/topics/permissions/defining
7. OAuth 2.0 scopes, RFC 6749 §3.3: https://www.rfc-editor.org/rfc/rfc6749#section-3.3
8. Chrome `ExtensionSettings`: https://support.google.com/chrome/a/answer/9867568
9. VS Code workspace trust: https://code.visualstudio.com/api/extension-guides/workspace-trust
10. Slack scopes and granular-permission migration: https://api.slack.com/scopes , https://api.slack.com/authentication/migration ;
    Forge permissions: https://developer.atlassian.com/platform/forge/manifest-reference/permissions/ (both render with
    JavaScript; their rows rest on the published docs as known, not on fetched text)
11. Backstage: https://backstage.io/docs/permissions/overview , https://backstage.io/docs/permissions/plugin-authors/02-adding-a-basic-permission-check ,
    https://backstage.io/docs/permissions/writing-a-policy
12. Grafana app plugin RBAC: https://grafana.com/developers/plugin-tools/how-to-guides/app-plugins/implement-rbac-in-app-plugins

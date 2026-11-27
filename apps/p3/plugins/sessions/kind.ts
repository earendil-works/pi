// The sessions plugin's kinds: the session kind (`SessionKind`, a workspace kind: a session is a session workspace,
// decision 13) and the session defaults kind (`SessionDefaultsKind`, what a new session starts with where it is the
// nearest). Their objects and hooks are served on the server (`session.ts`, `defaults.ts`).

import { method, nul, obj, opt, union } from "@earendil-works/p3/v1";
import { MAKE_ANY } from "../things/contract.ts";
import { defineThing, defineWorkspace } from "../things/kind.ts";
import { Location, ModelChoice, SessionDefaults, SessionRow } from "./contract.ts";
import { messages } from "./messages.ts";

/**
 * A session workspace (decision 13): a leaf (things and people, never workspaces), made with `Workspace.make` in its
 * parent (`@make:sessions.session`; the maker gets every tick, items 88, 90). Its own ticks (decision 76: the
 * transcript is no thing, the session's ticks are its rights): Read, Send and Stop are flags the worker's objects
 * follow (`followSession`); Manage gives the changes of the session itself (R20): archive, restore, its model (its
 * name is changed with Configure in its parent, decision 80). Its row is for everyone let in.
 * The agents get `MAKE_ANY` (R6: the makers ceiling leaves them the content kinds); a share's guests read (100). The
 * `everyone` default is the session defaults thing's (`shared`, decision 93): the create hook answers it.
 */
export const SessionKind = defineWorkspace("sessions.session", {
	version: 1,
	leaf: true,
	makers: "anyone",
	state: { row: SessionRow },
	methods: {
		archive: method(),
		restore: method(),
		/** Sets the session's model (`null`: the agent's default). */
		setModel: method(obj({ model: union([ModelChoice, nul()]) })),
	},
	ticks: {
		read: { label: messages.message("tickRead") },
		send: { label: messages.message("tickSend"), for: "people" },
		stop: { label: messages.message("tickStop"), for: "people" },
		manage: {
			label: messages.message("tickManage"),
			for: "people",
			gives: ["archive", "restore", "setModel"],
		},
	},
	defaultGrants: { agents: [MAKE_ANY], everyone: ["read", "send"], guests: ["read"] },
	create: { input: obj({ location: opt(Location) }) },
});

/** One session held as itself (`{ workspace: id, thing: id }`): `SessionKind`'s contract. */
export const SessionObject = SessionKind.contract;

/**
 * Session defaults as a thing (09: model, shared or private, opens with): the nearest one a new session sees applies
 * (`stacking: "nearest"`); people make them, Configure sets them; everyone here sees them (they open them with no
 * ticks); the agents' Use is a flag. The plugin seeds one in Pi.
 */
export const SessionDefaultsKind = defineThing("sessions.defaults", {
	version: 1,
	makers: "people",
	stacking: "nearest",
	state: { defaults: SessionDefaults },
	ticks: { use: { label: messages.message("tickUseDefaults"), for: "agents" } },
	defaultGrants: { agents: ["use"], everyone: [] },
	settings: ["defaults"],
});

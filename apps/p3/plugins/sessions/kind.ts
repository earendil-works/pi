// The sessions plugin's kinds: the session kind (`SessionKind`, a workspace kind: a session is a session workspace,
// decision 13) and the session defaults kind (`SessionDefaultsKind`, what a new session starts with where it is the
// nearest). Their objects and hooks are served on the server (`session.ts`, `defaults.ts`).

import { method, nul, obj, opt, union } from "@earendil-works/p3/v1";
import { MAKE_ANY } from "../things/contract.ts";
import { defineThing, defineWorkspace } from "../things/kind.ts";
import { ConversationLocation, Location, ModelChoice, SessionDefaults, SessionDetail, SessionRow } from "./contract.ts";
import { messages } from "./messages.ts";

/**
 * A session workspace (decision 13): a leaf (things and people, never workspaces), made with `Workspace.make` in its
 * parent (`@make:sessions.session`; the maker gets every tick, items 88, 90). Its own ticks (decision 76: the
 * transcript is no thing, the session's ticks are its rights): Read, Send and Stop are flags the worker's objects
 * follow (`followSession`); Manage gives the changes of the session itself (R20): its detail (where its moved
 * conversations work), archive, restore, its model, moving a conversation (decision 24; its name is changed with
 * Configure in its parent, decision 80). Its row is for everyone let in.
 * The agents get `MAKE_ANY` (R6: the makers ceiling leaves them the content kinds); a share's guests read (100). The
 * `everyone` default is the session defaults thing's (`shared`, decision 93): the create hook answers it.
 */
export const SessionKind = defineWorkspace("sessions.session", {
	version: 2,
	leaf: true,
	makers: "anyone",
	state: { row: SessionRow, detail: SessionDetail },
	methods: {
		archive: method(),
		restore: method(),
		/** Sets the session's model (`null`: the agent's default). */
		setModel: method(obj({ model: union([ModelChoice, nul()]) })),
		/**
		 * Moves one conversation (`SessionHarness`' id) to a location of its own: refused unless the agents have Work on
		 * its machine here and the caller is let in there too. Its next tool call works there.
		 */
		moveLocation: method(ConversationLocation),
	},
	ticks: {
		read: { label: messages.message("tickRead") },
		send: { label: messages.message("tickSend"), for: "people" },
		stop: { label: messages.message("tickStop"), for: "people" },
		manage: {
			label: messages.message("tickManage"),
			for: "people",
			gives: ["detail", "archive", "restore", "setModel", "moveLocation"],
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

// The things plugin's tests' kinds: a board with the prototype's four ticks (read, write, draw, moderate: for everyone,
// so any grant the random tests write is accepted), a tick only for agents (`bash`) and one only for people (`look`);
// and its plugin's facet, which serves it with `serveThing` (the object members as the ticks give them; hooks that
// record what they were called with).

import { constant, defineFacet, method, obj, type P3Principal, type PluginFacet, str } from "@earendil-works/p3/v1";
import type { CreateAnswer } from "../contract.server.ts";
import { MAKE_ANY } from "../contract.ts";
import { defineThing, defineWorkspace } from "../kind.ts";
import { serveThing } from "../serve.ts";

/** What the test kind's hooks were called with, in order. */
export const HOOKS: string[] = [];

/** The callers the test kind's object was built for, in order (a rebuild adds one). */
export const BUILDS: string[] = [];

/** Whether the test kind's `create` hook throws. */
export const FAIL = { create: false };

const label = (key: string) => ({ namespace: "test", key, params: [] });

/** The test kind: one member per tick, and a plain one. */
export const Board = defineThing("test.board", {
	version: 1,
	makers: "anyone",
	// `notes` is given by Moderate: a grantable state member (its type must stay nameable when exported).
	state: { title: str(), notes: obj({ text: str() }) },
	methods: {
		read: method(undefined, str()),
		write: method(),
		draw: method(),
		moderate: method(),
		bash: method(),
		look: method(),
	},
	ticks: {
		read: { label: label("read"), gives: ["read"] },
		write: { label: label("write"), gives: ["write"] },
		draw: { label: label("draw"), gives: ["draw"] },
		moderate: { label: label("moderate"), gives: ["moderate", "notes"] },
		bash: { label: label("bash"), for: "agents", gives: ["bash"] },
		look: { label: label("look"), for: "people", gives: ["look"] },
	},
	defaultGrants: { everyone: ["read"], agents: ["read"] },
});

/** The test kind's plugin name: the source of its default grants. */
export const BOARD_PLUGIN = "p3-test-board";

/** The test kind's plugin: `Board` served, its members answering their names. */
export const boardFacet = defineFacet((host) => {
	serveThing(host, Board, {
		implement: ({ thing }, { caller }) => {
			BUILDS.push(caller.kind === "person" ? caller.person : caller.kind === "agent" ? caller.session : "server");
			return {
				title: constant(thing),
				notes: () => constant({ text: "" }),
				read: async () => `${caller.kind}`,
				write: async () => null,
				draw: async () => null,
				moderate: async () => null,
				bash: async () => null,
				look: async () => null,
			};
		},
		create: async (thing) => {
			HOOKS.push(`create ${thing}`);
			if (FAIL.create) throw new Error("the board could not be made");
		},
		delete: async (thing) => void HOOKS.push(`delete ${thing}`),
	});
});

/** The test kind's plugin as a host loads it. */
export const BOARD: PluginFacet<P3Principal> = { name: BOARD_PLUGIN, facet: boardFacet };

/** What the test session kind's `create` hook answers (a private session: `CreateAnswer`), and was called with. */
export const SESSION = { answer: undefined as CreateAnswer | undefined, made: [] as string[], gone: [] as string[] };

/**
 * A leaf workspace kind like the session kind (ERNDL-704): Read and Send, the agents `MAKE_ANY` in it (R6), everyone
 * Read; made by anyone.
 */
export const TestSession = defineWorkspace("test.session", {
	version: 1,
	leaf: true,
	makers: "anyone",
	state: { title: str() },
	ticks: {
		read: { label: label("sessionRead") },
		send: { label: label("sessionSend"), for: "people" },
	},
	defaultGrants: { agents: [MAKE_ANY], everyone: ["read", "send"] },
});

/** A kind only people make (a login): Use, for agents. */
export const Login = defineThing("test.login", {
	version: 1,
	makers: "people",
	ticks: { use: { label: label("use"), for: "agents" } },
	defaultGrants: { agents: ["use"] },
});

/** A kind that stacks `nearest` (session defaults, decision 75): Use. */
export const Defaults = defineThing("test.defaults", {
	version: 1,
	makers: "anyone",
	stacking: "nearest",
	ticks: { use: { label: label("use") } },
	defaultGrants: { everyone: ["use"], agents: ["use"] },
});

/** The plugin of the workspace tests' kinds. */
export const SPACES_PLUGIN = "p3-test-spaces";

/** The workspace tests' kinds served: the session kind with hooks that record, the login, the defaults. */
export const spacesFacet = defineFacet((host) => {
	serveThing(host, TestSession, {
		implement: ({ thing }) => ({ title: constant(thing) }),
		create: async (thing) => {
			SESSION.made.push(thing);
			return SESSION.answer;
		},
		workspaceGone: async (workspace) => void SESSION.gone.push(workspace),
	});
	serveThing(host, Login, { implement: () => ({}) });
	serveThing(host, Defaults, { implement: () => ({}) });
});

/** The workspace tests' kinds' plugin as a host loads it. */
export const SPACES: PluginFacet<P3Principal> = { name: SPACES_PLUGIN, facet: spacesFacet };

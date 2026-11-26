// The things plugin's tests' kinds: a board with the prototype's four ticks (read, write, draw, moderate: for everyone,
// so any grant the random tests write is accepted), a tick only for agents (`bash`) and one only for people (`look`);
// and its plugin's facet, which serves it with `serveThing` (the object members as the ticks give them; hooks that
// record what they were called with).

import { constant, defineFacet, method, obj, type P3Principal, type PluginFacet, str } from "@earendil-works/p3/v1";
import { defineThing } from "../kind.ts";
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

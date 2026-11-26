// What the sessions plugin's plugin-tier tests load beside it: the real server facets of the plugins its store reads
// (people, environments, apps, the coding app, sign-in) and the tools plugin (the Pi's coding tools, "in all my
// sessions"); a test kind of thing whose entry a test changes live (`setNotes`: its version, its migration), as a
// reload of its plugin would; a kind of content served with `serveThing` (`Boards`: hooks recorded in `HOOKS`, an
// object admitted by `admitThing`); and a kind a person makes (`Logins`: input, hooks).

import {
	bool,
	constant,
	contribute,
	defineFacet,
	defineMessages,
	defineThing,
	type JsonValue,
	obj,
	type P3Principal,
	type PluginFacet,
	remote,
	Server,
	str,
	thingAdmission,
	type Writable,
} from "@earendil-works/p3/v1";
import { serveThing, type ThingKindEntry, ThingKinds } from "@earendil-works/p3/v1/server";
import appsServer from "../../apps/server.ts";
import codingServer from "../../coding/server.ts";
import environmentsServer from "../../environments/server.ts";
import peopleServer from "../../people/server.ts";
import signInServer from "../../sign-in/server.ts";
import toolsServer from "../../tools/server.ts";

/** The test's kind of thing: notes in a colour. */
export const Notes = defineThing("test.notes", {
	version: 1,
	options: obj({ color: str() }),
	initial: { color: "red" },
});

/** The entry of `Notes` the stub contributes now; set by `setNotes`. */
let notes: Writable<ThingKindEntry> | undefined;

/** Contributes `entry` as the test kind's entry from now on (its plugin reloaded with another version). */
export function setNotes(entry: ThingKindEntry): void {
	notes!.set(entry);
}

/** The entry of `Notes` (version 1) with the title "Notes". */
export const NOTES: ThingKindEntry = { kind: Notes as ThingKindEntry["kind"], title: "Notes" };

/** The test kind's plugin: its entry in `ThingKinds`, a writable so a test changes it. */
const testKindServer = defineFacet((host) => {
	contribute(host, "test.notes", (self) => {
		notes = self.writable(NOTES);
		self.contribute(ThingKinds, notes);
	});
});

/** A kind of content, boards, served with `serveThing`: options `{ draw }`, and hooks that say so. */
export const Boards = defineThing("test.boards", {
	version: 1,
	options: obj({ draw: bool() }),
	initial: { draw: true },
});

/** The boards' messages, as a plugin's `messages.ts` holds them: the `draw` flag's label. */
const boardMessages = defineMessages("test.boards", { en: { flagDraw: "Draws on the board" } });

/** One board of a session as `admitThing` admits its caller: a viewer, or a drawer (writes, and `draw`: granted). */
export const Board = remote("test.board", {
	version: 1,
	params: { session: str(), thing: str() },
	hostAddress: () => Server(),
	admission: thingAdmission(Boards),
	state: { thing: str() },
	flags: { draw: boardMessages.message("flagDraw") },
});

/** What the boards' hooks were called with, in order (`create` with the thing and its input; `delete` with its id). */
export const HOOKS: (
	| {
			readonly hook: "create";
			readonly id: string;
			readonly name: string;
			readonly owner: string;
			readonly input: JsonValue | undefined;
	  }
	| { readonly hook: "delete"; readonly id: string }
)[] = [];

/** The boards' plugin: `serveThing` with both hooks and `Board`; boards are content. */
const boardsServer = defineFacet((host) => {
	serveThing(host, Boards, {
		title: "Board",
		creation: "content",
		create: async ({ id, name, owner }, input) => {
			HOOKS.push({ hook: "create", id, name, owner: owner.kind, input });
		},
		delete: async (id) => {
			HOOKS.push({ hook: "delete", id });
		},
		object: {
			contract: Board,
			grants: ({ access, options }) => (access === "write" && options.draw ? ["draw"] : []),
			factory: ({ thing }) => ({ thing: constant(thing) }),
		},
	});
});

/** A kind a person makes (a login): an input `{ secret }` its creation view collects (`"fail"` fails the create). */
export const Logins = defineThing("test.logins", { version: 1, options: obj({}), initial: {} });

/** The logins' plugin: `creation: "person"`, the input, and both hooks. */
const loginsServer = defineFacet((host) => {
	serveThing(host, Logins, {
		title: "Login",
		creation: "person",
		input: obj({ secret: str() }),
		create: async ({ id, name, owner }, input) => {
			HOOKS.push({ hook: "create", id, name, owner: owner.kind, input });
			if ((input as { secret?: string } | undefined)?.secret === "fail") throw new Error("no login today");
		},
		delete: async (id) => {
			HOOKS.push({ hook: "delete", id });
		},
	});
});

/** The facets the sessions plugin is tested beside. */
export const STUBS: readonly PluginFacet<P3Principal>[] = [
	{ name: "@earendil-works/p3-apps", facet: appsServer },
	{ name: "@earendil-works/p3-coding", facet: codingServer },
	{ name: "@earendil-works/p3-environments", facet: environmentsServer },
	{ name: "@earendil-works/p3-people", facet: peopleServer },
	{ name: "@earendil-works/p3-sign-in", facet: signInServer },
	{ name: "@earendil-works/p3-tools", facet: toolsServer },
	{ name: "p3-test-kind", facet: testKindServer },
	{ name: "p3-test-boards", facet: boardsServer },
	{ name: "p3-test-logins", facet: loginsServer },
];

/** A version of `NOTES` at `version`, with `migrate` (none: no migration). */
export function notesAt(
	version: number,
	migrate?: (options: JsonValue, from: number) => { color: string } | undefined,
): ThingKindEntry {
	return { ...NOTES, kind: { ...NOTES.kind, version, ...(migrate === undefined ? {} : { migrate }) } };
}

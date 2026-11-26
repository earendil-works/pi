// The notes plugin's tests' server: the notes plugin's server facet beside the things plugin's (`testPlugin`), with
// what the cases set up there: people put into a workspace, workspaces with a session's agent, notebooks, ticks given
// or withheld, and a notebook held as a caller.

import { fileURLToPath } from "node:url";
import { type Ctx, BACKGROUND_CONTEXT as context, type P3Principal, type Reference } from "@earendil-works/p3/v1";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import { ThingsStore } from "../../things/contract.server.ts";
import type { Party, Source } from "../../things/contract.ts";
import thingsServer from "../../things/server.ts";
import { Notes, NotesKind } from "../contract.ts";

/** A person's principal. */
export type Person = Extract<P3Principal, { kind: "person" }>;

/** Who sets things up in the tests. */
export const BY: Source = { kind: "plugin", plugin: "test" };

/** The notes plugin and the things plugin on a server, and what the cases set up there. */
export type Notebooks = {
	readonly t: TestedPlugin<P3Principal>;
	readonly things: Reference<typeof ThingsStore>;
	/** The Pi's workspace, the root. */
	readonly pi: string;
	person(name: string, workspace?: string): Promise<Person>;
	workspace(session: string): Promise<string>;
	notebookIn(where: string, name?: string): Promise<string>;
	write(where: string, thing: string, party: Party, gives: boolean): Promise<unknown>;
	holding<T>(
		principal: P3Principal,
		where: string,
		thing: string,
		fn: (notes: Reference<typeof Notes>, ctx: Ctx<P3Principal>) => Promise<T>,
	): Promise<T>;
	close(): Promise<void>;
};

/** Starts the notes plugin's server facet beside the things plugin's; `close` ends it. */
export async function notebooks(): Promise<Notebooks> {
	const t: TestedPlugin<P3Principal> = await testPlugin(
		fileURLToPath(new URL("../", import.meta.url)),
		{ kind: "server", stubs: [{ name: "@earendil-works/p3-things", facet: thingsServer }] },
		context,
	);
	const things = await t.host.get(ThingsStore, {}, context);
	const pi = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;

	/** Makes person `name`, put into `workspace` (Pi by default); their principal. */
	const person = async (name: string, workspace = pi): Promise<Person> => {
		const id = await things.createPerson({ name, madeBy: BY }, context);
		await things.putParty({ workspace, party: { kind: "person", person: id }, source: BY }, context);
		return { kind: "person", id, name };
	};

	/** A workspace under Pi with session `session`'s agent put in (as a session's will be). */
	const workspace = async (session: string): Promise<string> => {
		const id = await things.createWorkspace({ kind: "things.workspace", name: session, parent: pi, by: BY }, context);
		await things.putParty({ workspace: id, party: { kind: "agent", session }, source: BY }, context);
		return id;
	};

	/** Makes a notebook named `name` in `where`, by the test (no maker's grant). */
	const notebookIn = (where: string, name = "") =>
		things.create({ kind: NotesKind.name, name, workspace: where, by: BY }, context);

	/** Gives (`gives: true`) or withholds Write from `party` on `thing` in `where`. */
	const write = (where: string, thing: string, party: Party, gives: boolean) =>
		things.setGrants({ source: BY, grants: [{ workspace: where, thing, party, tick: "write", gives }] }, context);

	/** Runs `fn` with `principal`'s notebook `thing` held in `where`. */
	const holding = <T>(
		principal: P3Principal,
		where: string,
		thing: string,
		fn: (notes: Reference<typeof Notes>, ctx: Ctx<P3Principal>) => Promise<T>,
	) =>
		t.root(
			async (ctx) => fn(await ctx.get(Notes, { workspace: where, thing }, { readyTimeout: 500 }), ctx),
			context,
			{ principal },
		);

	return { t, things, pi, person, workspace, notebookIn, write, holding, close: () => t.close(context) };
}

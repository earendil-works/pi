// A kind's tests' server: the kind's plugin's server facet beside the things plugin's (`testPlugin` of the kind's
// plugin root, the things plugin as its stub), with what a kind's cases set up there: people put into a workspace,
// workspaces with a session's agent, things of the kind, ticks given or withheld, a thing held as a caller, and the
// kind's harness part (from its worker facet, loaded as a session's worker loads it) given the things an agent holds.

import {
	BACKGROUND_CONTEXT,
	type Context,
	type Contract,
	type Ctx,
	type P3Principal,
	type ParamsOf,
	type Reference,
} from "@earendil-works/p3/v1";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import type { Extension } from "@earendil-works/p3/v1/worker";
import { ThingsStore } from "../contract.server.ts";
import type { Party, Source } from "../contract.ts";
import { type HarnessSession, type HeldThing, ThingHarnessParts } from "../contract.worker.ts";
import type { ThingKind } from "../kind.ts";
import thingsServer from "../server.ts";

/** A person's principal. */
export type Person = Extract<P3Principal, { kind: "person" }>;

/** Who sets things up in a kind's tests. */
export const BY: Source = { kind: "plugin", plugin: "test" };

/** A kind's plugin and the things plugin on a server, and what a kind's cases set up there. */
export type KindServer<C extends Contract> = {
	readonly t: TestedPlugin<P3Principal>;
	readonly things: Reference<typeof ThingsStore>;
	/** Pi's workspace, the root. */
	readonly pi: string;
	/** Makes person `name`, put into `workspace` (Pi by default); their principal. */
	person(name: string, workspace?: string): Promise<Person>;
	/** A workspace under Pi with session `session`'s agent put in (as a session's will be). */
	workspace(session: string): Promise<string>;
	/** Makes a thing of the kind named `name` in `where`, by the test (no maker's grant); its id. */
	thingIn(where: string, name?: string): Promise<string>;
	/** Gives (`gives: true`) or withholds tick `tick` from `party` on `thing` in `where`. */
	tick(where: string, thing: string, party: Party, tick: string, gives: boolean): Promise<unknown>;
	/** Runs `fn` with `principal`'s thing `thing` held in `where`. */
	holding<T>(
		principal: P3Principal,
		where: string,
		thing: string,
		fn: (ref: Reference<C>, ctx: Ctx<P3Principal>) => Promise<T>,
	): Promise<T>;
	/**
	 * Runs `fn` with session `session`'s agent holding `things` in `workspace`: the extension the kind's harness part
	 * (contributed by `worker`, the kind's worker facet) gives for them, and the held things.
	 */
	giving<T>(
		worker: TestedPlugin<P3Principal>,
		at: { readonly session: string; readonly workspace: string },
		things: readonly string[],
		fn: (extension: Extension, ctx: Ctx<P3Principal>, held: readonly HeldThing<C>[]) => Promise<T>,
	): Promise<T>;
	close(): Promise<void>;
};

/** Starts the server facet of the plugin at `root`, the plugin of `Kind`, beside the things plugin's. */
export async function kindServer<C extends Contract>(
	root: string,
	Kind: ThingKind<C>,
	context: Context,
): Promise<KindServer<C>> {
	const t = await testPlugin(
		root,
		{ kind: "server", stubs: [{ name: "@earendil-works/p3-things", facet: thingsServer }] },
		context,
	);
	const things = await t.host.get(ThingsStore, {}, context);
	const pi = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
	return {
		t,
		things,
		pi,
		person: async (name, workspace = pi) => {
			const id = await things.createPerson({ name, madeBy: BY }, context);
			await things.putParty({ workspace, party: { kind: "person", person: id }, source: BY }, context);
			return { kind: "person", id, name };
		},
		workspace: async (session) => {
			const id = await things.createWorkspace(
				{ kind: "things.workspace", name: session, parent: pi, by: BY },
				context,
			);
			await things.putParty({ workspace: id, party: { kind: "agent", session }, source: BY }, context);
			return id;
		},
		thingIn: (where, name = "") => things.create({ kind: Kind.name, name, workspace: where, by: BY }, context),
		tick: (where, thing, party, tick, gives) =>
			things.setGrants({ source: BY, grants: [{ workspace: where, thing, party, tick, gives }] }, context),
		holding: (principal, where, thing, fn) =>
			t.root(
				// A kind's contract has the things plugin's params, which a generic contract's type cannot say.
				async (ctx) =>
					fn(await ctx.get(Kind.contract, { workspace: where, thing } as ParamsOf<C>, { readyTimeout: 500 }), ctx),
				context,
				{ principal },
			),
		giving: (worker, { session, workspace }, ids, fn) => {
			const principal: P3Principal = { kind: "worker", session };
			const harness: HarnessSession = { session, workspace, call: (call, ctx) => t.root(call, ctx, { principal }) };
			return t.root(
				async (ctx) => {
					const held: HeldThing<C>[] = [];
					for (const thing of ids) {
						// As in `holding`: a kind's contract has the things plugin's params.
						const ref = await ctx.get(Kind.contract, { workspace, thing } as ParamsOf<C>);
						held.push({ thing, workspace, ref });
					}
					const [part] = worker.contributions(ThingHarnessParts);
					// The registry's part takes any kind's held things; these are its kind's.
					const { extension } = part!.value.part(held as unknown as readonly HeldThing[], harness);
					if (extension === undefined) throw new Error(`${Kind.name}: the harness part gave no extension`);
					return fn(extension, ctx, held);
				},
				context,
				{ principal },
			);
		},
		close: () => t.close(context),
	};
}

/** Runs tool `name` of `extension` with `args`; its output's text. */
export async function runTool(extension: Extension, name: string, args: object): Promise<string> {
	const tool = extension.tools?.find((each) => each.name === name);
	if (tool === undefined) throw new Error(`no tool ${name}`);
	// Kinds' tools use neither Durable's execution API nor arguments beyond their schema's.
	const result = await tool.execute(args as never, {} as never, BACKGROUND_CONTEXT);
	// A park has no output: kinds' tools never park.
	return (result.output ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** The names of `extension`'s tools, sorted. */
export function toolNames(extension: Extension): readonly string[] | undefined {
	return extension.tools?.map((tool) => tool.name).toSorted();
}

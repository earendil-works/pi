// A kind's tests' server: the kind's server facet beside the things plugin's on the things plugin's test host (`world`:
// a SQLite store, counted work), with what a kind's cases set up there: people put into a workspace, workspaces with a
// session's agent, things of the kind, ticks given or withheld, a thing held by one caller or several at once, the
// counted work, a reload of the kind's facet, and the kind's harness part (its worker facet, built as a session's
// worker builds it) given the things an agent holds.

import assert from "node:assert/strict";
import {
	type Context,
	type Contract,
	type Ctx,
	type Facet,
	isChordError,
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
import { type World, world } from "./world.ts";

/** A person's principal. */
export type Person = Extract<P3Principal, { kind: "person" }>;

/** Who sets things up in a kind's tests. */
export const BY: Source = { kind: "plugin", plugin: "test" };

/** The kind's plugin: its name, its root (for its worker facet), and its server facet. */
export type KindPlugin = { readonly name: string; readonly root: string; readonly server: Facet<P3Principal> };

/** Several callers holding one thing at once, until `release`. */
export type Holders<C extends Contract> = {
	readonly held: readonly { readonly ref: Reference<C>; readonly ctx: Ctx<P3Principal> }[];
	release(): Promise<void>;
};

/** A kind's plugin and the things plugin on a test host, and what a kind's cases set up there. */
export type KindServer<C extends Contract> = {
	readonly host: World["host"];
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
	/** The members and flags `principal` is granted on `thing` in `where`, sorted. */
	granted(principal: P3Principal, where: string, thing: string): Promise<string[]>;
	/** Holds `thing` in `where` as each of `principals` at once, in order, until `release`. */
	holders(principals: readonly P3Principal[], where: string, thing: string): Promise<Holders<C>>;
	/** The sum of metric `name` so far (`chord.query.runs`, ...). */
	count(name: string): number;
	/** Renews the kind's server facet, as after an edit: its objects restart. */
	reload(): Promise<void>;
	/**
	 * Runs `fn` with session `session`'s agent holding `things` in `workspace`: the extension the kind's harness part
	 * gives for them, and the held things.
	 */
	giving<T>(
		at: { readonly session: string; readonly workspace: string },
		things: readonly string[],
		fn: (extension: Extension, ctx: Ctx<P3Principal>, held: readonly HeldThing<C>[]) => Promise<T>,
	): Promise<T>;
	/** The kind's worker facet, built for session `session`'s worker as it builds it (once per session). */
	worker(session: string): Promise<TestedPlugin<P3Principal>>;
	close(): Promise<void>;
};

/** Starts `plugin`'s server facet, the plugin of `Kind`, beside the things plugin's. */
export async function kindServer<C extends Contract>(
	plugin: KindPlugin,
	Kind: ThingKind<C>,
	context: Context,
): Promise<KindServer<C>> {
	const w = await world(context, [{ name: plugin.name, facet: plugin.server }]);
	const { host } = w;
	const things = await host.get(ThingsStore, {}, context);
	const pi = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
	// A kind's contract has the things plugin's params, which a generic contract's type cannot say.
	const get = (ctx: Ctx<P3Principal>, workspace: string, thing: string) =>
		ctx.get(Kind.contract, { workspace, thing } as ParamsOf<C>, { readyTimeout: 500 });
	const workers = new Map<string, Promise<TestedPlugin<P3Principal>>>();
	const worker = (session: string) => {
		const built = workers.get(session) ?? testPlugin(plugin.root, { kind: "worker", session }, context);
		workers.set(session, built);
		return built;
	};
	return {
		host,
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
			host.root(async (ctx) => fn(await get(ctx, where, thing), ctx), context, { principal }),
		granted: (principal, where, thing) =>
			host.root(
				async (ctx) => {
					// A kind's contract is remote (`defineThing`'s), so its reference has `granted`; a generic one's type
					// cannot say which member it is.
					const ref = (await get(ctx, where, thing)) as unknown as { readonly granted: ReadonlySet<string> };
					return [...ref.granted].sort();
				},
				context,
				{ principal },
			),
		holders: (principals, where, thing) => holdAll(host, principals, (ctx) => get(ctx, where, thing), context),
		count: (name) => w.count(name),
		reload: () => w.reload(plugin.name, context),
		giving: async ({ session, workspace }, ids, fn) => {
			const contributed = (await worker(session)).contributions(ThingHarnessParts);
			const entry = contributed.find(({ value }) => value.kind.name === Kind.name);
			if (entry === undefined) throw new Error(`${Kind.name}: the worker facet contributes no harness part`);
			const principal: P3Principal = { kind: "worker", session };
			const harness: HarnessSession = {
				session,
				workspace,
				call: (call, ctx) => host.root(call, ctx, { principal }),
			};
			return host.root(
				async (ctx) => {
					const held: HeldThing<C>[] = [];
					for (const thing of ids) held.push({ thing, workspace, ref: await get(ctx, workspace, thing) });
					// The registry's part takes any kind's held things; these are its kind's.
					const { extension } = entry.value.part(held as unknown as readonly HeldThing[], harness);
					if (extension === undefined) throw new Error(`${Kind.name}: the harness part gave no extension`);
					return fn(extension, ctx, held);
				},
				context,
				{ principal },
			);
		},
		worker,
		close: async () => {
			// Every worker that was built, and always the host: a failed build closes nothing else's.
			try {
				const built = await Promise.allSettled(workers.values());
				await Promise.allSettled(
					built.map((each) => (each.status === "fulfilled" ? each.value.close(context) : null)),
				);
			} finally {
				await w.close(context);
			}
		},
	};
}

/** Holds one reference per principal, each in a root of its own, until `release`. */
async function holdAll<C extends Contract>(
	host: World["host"],
	principals: readonly P3Principal[],
	get: (ctx: Ctx<P3Principal>) => Promise<Reference<C>>,
	context: Context,
): Promise<Holders<C>> {
	const released = Promise.withResolvers<void>();
	const held: { ref: Reference<C>; ctx: Ctx<P3Principal> }[] = [];
	const roots: Promise<void>[] = [];
	const release = async () => {
		released.resolve();
		await Promise.all(roots);
	};
	try {
		for (const principal of principals) {
			const ready = Promise.withResolvers<void>();
			const root = host.root(
				async (ctx) => {
					held.push({ ref: await get(ctx), ctx });
					ready.resolve();
					await released.promise;
				},
				context,
				{ principal },
			);
			roots.push(root);
			await Promise.race([ready.promise, root]);
		}
	} catch (error) {
		// A hold refused: the earlier ones end before the refusal reaches the test.
		released.resolve();
		await Promise.allSettled(roots);
		throw error;
	}
	return { held, release };
}

/**
 * Asserts that `promise` rejects with a ChordError of `code`, and, with `key`, that the refusal carries the message of
 * that key (`details.message.key`) for the person who caused it.
 */
export async function refused(promise: Promise<unknown>, code = "forbidden", key?: string): Promise<void> {
	await assert.rejects(promise, (error: unknown) => {
		if (!isChordError(error) || error.code !== code) return false;
		if (key === undefined) return true;
		// The details are the refusal's own: `{ message }` as the plugin built it (a message as data).
		const details = error.details as { readonly message?: { readonly key?: string } } | undefined;
		return details?.message?.key === key;
	});
}

/** Runs tool `name` of `extension` with `args` under `context`; its output's text. */
export async function runTool(extension: Extension, name: string, args: object, context: Context): Promise<string> {
	const tool = extension.tools?.find((each) => each.name === name);
	if (tool === undefined) throw new Error(`no tool ${name}`);
	// Kinds' tools use neither Durable's execution API nor arguments beyond their schema's.
	const result = await tool.execute(args as never, {} as never, context);
	// A park has no output: kinds' tools never park.
	return (result.output ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** The names of `extension`'s tools, sorted. */
export function toolNames(extension: Extension): readonly string[] | undefined {
	return extension.tools?.map((tool) => tool.name).toSorted();
}

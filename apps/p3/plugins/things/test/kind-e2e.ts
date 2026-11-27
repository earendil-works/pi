// A kind's end-to-end tests' server: p3's real server (`testServer`) on a copy of the built-in plugins, so a test can
// edit a kind's facet and apply it as `p3 apply` does; people put into Pi, things of a kind made there, ticks given or
// withheld, clients signed in as those people, and `reload`, a real edit of a kind's facet (its server facet by default)
// and its rollout.

import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Context, type Host, type P3Principal, until } from "@earendil-works/p3/v1";
import type { RolloutResult } from "@earendil-works/p3/v1/server";
import { type TestServer, testServer } from "@earendil-works/p3/v1/testing";
import { within } from "../../../test/until.ts";
import { ThingsStore } from "../contract.server.ts";
import type { Party } from "../contract.ts";
import { BY, type Person } from "./kind-server.ts";

/** p3's real server on a copy of the built-in plugins, and what a kind's end-to-end cases do there. */
export type KindE2E = {
	readonly t: TestServer;
	/** Pi's workspace, the root. */
	readonly pi: string;
	/** Makes person `name`, put into Pi; their principal. */
	person(name: string): Promise<Person>;
	/** Makes a thing of `kind` named `name` in Pi, by the test; its id. */
	thingIn(kind: string, name: string): Promise<string>;
	/** Gives (`gives: true`) or withholds `ticks` from `party` on `thing` in Pi. */
	ticks(thing: string, party: Party, ticks: readonly string[], gives: boolean): Promise<unknown>;
	/** A client signed in as `principal`. */
	client(principal: P3Principal): Promise<Host<P3Principal>>;
	/**
	 * Edits a facet of the plugin in folder `folder` (named `plugin`), its server facet unless `facet` names another
	 * (`web.tsx`), so its built script changes, and applies it: what the apply did. A comment alone would build the same
	 * script, which reloads nothing.
	 */
	reload(folder: string, plugin: string, facet?: string): Promise<RolloutResult>;

	close(): Promise<void>;
};

/** The built-in plugins' folder. */
const PLUGINS = fileURLToPath(new URL("../../", import.meta.url));

/** Starts p3's real server on a copy of the built-in plugins. */
export async function kindE2E(context: Context): Promise<KindE2E> {
	const dir = await mkdtemp(join(tmpdir(), "p3-kind-e2e-"));
	const root = join(dir, "built-in");
	await cp(PLUGINS, root, { recursive: true });
	const t = await testServer({ builtIn: root }, context).catch(async (error: unknown) => {
		await rm(dir, { recursive: true, force: true });
		throw error;
	});
	const things = await t.host.get(ThingsStore, {}, context);
	const pi = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
	let edits = 0;
	return {
		t,
		pi,
		person: async (name) => {
			const id = await things.createPerson({ name, madeBy: BY }, context);
			await things.putParty({ workspace: pi, party: { kind: "person", person: id }, source: BY }, context);
			return { kind: "person", id, name };
		},
		thingIn: (kind, name) => things.create({ kind, name, workspace: pi, by: BY }, context),
		ticks: (thing, party, ticks, gives) =>
			things.setGrants(
				{ source: BY, grants: ticks.map((tick) => ({ workspace: pi, thing, party, tick, gives })) },
				context,
			),
		client: (principal) => t.client(context, principal),
		reload: async (folder, plugin, facet = "server.ts") => {
			const file = join(root, folder, facet);
			// A new export each time: a second one of the same name would not build.
			edits += 1;
			await writeFile(file, `${await readFile(file, "utf8")}\nexport const RELOADED_${edits} = ${edits};\n`);
			await until(
				t.plugins,
				(marks) => marks.dirty.includes(plugin),
				within("the watcher's marks", context, 10_000),
			);
			return t.apply(context);
		},
		close: async () => {
			await t.close(context);
			await rm(dir, { recursive: true, force: true });
		},
	};
}

/** What the server's step of `applied` reloaded: the changed plugins, and how many objects of `type` restarted. */
export function restarted(applied: RolloutResult, type: string): { changed: readonly string[]; restarted: number } {
	const [host] = applied.steps.find(({ name }) => name === "server")?.hosts ?? [];
	if (host?.kind !== "reloaded") return { changed: [], restarted: 0 };
	const { plugins, objects } = host.report;
	const count = objects.filter(({ object, kind }) => kind === "restarted" && object.startsWith(`${type}(`)).length;
	return { changed: plugins.changed, restarted: count };
}

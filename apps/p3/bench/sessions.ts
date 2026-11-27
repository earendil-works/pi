// A new session's commit (ERNDL-704: "a new session's commit under 30 ms"): `Workspace.make` of the session kind in a
// workspace, by a person with Make of sessions there, as the page's add dialog calls it, until it answers the id:
// the create hook (the nearest defaults, the row), the things store's commit (the workspace, its grants, its maker
// and agent put in). A server host in one process with the things, sessions and environments plugins; medians of 50
// after 5 warm-up makes, min and max beside them; with no other session, and with 500 sessions made before.
// Run from apps/p3 with Node 26:
//   node --conditions=source --disable-warning=ExperimentalWarning bench/sessions.ts

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { defineFacet, type P3Principal, withGranted } from "@earendil-works/p3/v1";
import { type ServerRuntime, ServerRuntime as ServerRuntimeRegistry } from "@earendil-works/p3/v1/server";
import environmentsServer from "../plugins/environments/server.ts";
import { SessionKind } from "../plugins/sessions/kind.ts";
import sessionsServer from "../plugins/sessions/server.ts";
import { ThingsStore } from "../plugins/things/contract.server.ts";
import { makeTick, type Source } from "../plugins/things/contract.ts";
import { world } from "../plugins/things/test/world.ts";
import { Workspace } from "../plugins/things/workspace.ts";
import { WorkspaceKind } from "../plugins/things/workspaces.ts";

const BY: Source = { kind: "plugin", plugin: "bench" };

const dataDir = await mkdtemp(join(tmpdir(), "p3-bench-sessions-"));
const runtime = { dataDir, machine: { user: "bench", hostname: "bench" } } as ServerRuntime;
const w = await world(context, [
	{ name: "p3.server", facet: defineFacet((host) => host.serve(ServerRuntimeRegistry, { compose: () => runtime })) },
	{ name: "@earendil-works/p3-environments", facet: environmentsServer },
	{ name: "@earendil-works/p3-sessions", facet: sessionsServer },
]);
const store = await w.host.get(ThingsStore, {}, context);
const pi = (await store.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
const family = await store.createWorkspace({ kind: WorkspaceKind.name, name: "Family", parent: pi, by: BY }, context);
const leo: P3Principal = {
	kind: "person",
	id: await store.createPerson({ name: "Leo", madeBy: BY }, context),
	name: "Leo",
};
const party = { kind: "person", person: leo.id } as const;
await store.putParty({ workspace: family, party, source: BY }, context);
const grant = { workspace: family, thing: family, party, tick: makeTick(SessionKind), gives: true };
await store.setGrants({ source: BY, grants: [grant] }, context);

/** The time of `n` makes after `warm` unmeasured ones, in ms each. */
async function makes(n: number, warm: number): Promise<number[]> {
	return w.host.root(
		async (ctx) => {
			const workspace = withGranted(await ctx.get(Workspace, { workspace: family }), "make")!;
			const times: number[] = [];
			for (let i = 0; i < warm + n; i++) {
				const started = performance.now();
				await workspace.make({ kind: SessionKind.name, name: `s${i}`, input: {} }, ctx);
				if (i >= warm) times.push(performance.now() - started);
			}
			return times;
		},
		context,
		{ principal: leo },
	);
}

/** The median, min and max of `xs`, in ms. */
function stats(xs: readonly number[]): string {
	const sorted = xs.toSorted((a, b) => a - b);
	const ms = (x: number) => x.toFixed(2);
	return `${ms(sorted[Math.floor(sorted.length / 2)]!)} ms (${ms(sorted[0]!)} to ${ms(sorted.at(-1)!)})`;
}

console.log(`a new session's commit, few sessions: ${stats(await makes(50, 5))}`);
await makes(500, 0);
console.log(`a new session's commit, 555 sessions made before: ${stats(await makes(50, 0))}`);
await w.close(context);
await rm(dataDir, { recursive: true, force: true });

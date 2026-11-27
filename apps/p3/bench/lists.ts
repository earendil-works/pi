// What one commit costs while pages hold the workspace lists (slice 2, ERNDL-1143; Fable's measurement, round 1):
// 0, 10 and 50 persons each hold Roots, Children (Pi), Contents (Family) and People (Family); medians of 20 commits of
// three kinds: a rename elsewhere (no list shows it), a grant elsewhere, a board made in Family (every Contents list
// there changes). The lists are probes over the access index, asked again inside the store's queue only after a commit
// that can change them; the index's reads per commit count their reads (names, children, member rows).
// Run from apps/p3 with Node 26:
//   node --conditions=source --disable-warning=ExperimentalWarning bench/lists.ts

import { BACKGROUND_CONTEXT as context, type P3Principal } from "@earendil-works/p3/v1";
import { ThingsStore } from "../plugins/things/contract.server.ts";
import { Board } from "../plugins/things/test/kinds.ts";
import { world } from "../plugins/things/test/world.ts";
import { Roots, WorkspaceChildren, WorkspaceContents, WorkspacePeople } from "../plugins/things/workspace.ts";
import { WorkspaceKind } from "../plugins/things/workspaces.ts";

const BY = { kind: "plugin", plugin: "bench" } as const;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

for (const pages of [0, 10, 50]) {
	{
		const w = await world(context);
		const store = await w.host.get(ThingsStore, {}, context);
		const pi = (await store.workspaces.children.page({ parent: "" }, 10, context)).items[0]!.workspace;
		const fam = await store.createWorkspace(
			{ kind: WorkspaceKind.name, name: "Family", parent: pi, by: BY },
			context,
		);
		const other = await store.createWorkspace(
			{ kind: WorkspaceKind.name, name: "Other", parent: pi, by: BY },
			context,
		);
		for (let i = 0; i < 20; i++)
			await store.create({ kind: Board.name, name: `b${i}`, workspace: fam, by: BY }, context);
		const elsewhere = await store.create({ kind: Board.name, name: "x", workspace: other, by: BY }, context);
		const releases: (() => void)[] = [];
		const roots: Promise<void>[] = [];
		for (let i = 0; i < pages; i++) {
			const id = await store.createPerson({ name: `p${i}`, madeBy: BY }, context);
			await store.putParty({ workspace: pi, party: { kind: "person", person: id }, source: BY }, context);
			const principal: P3Principal = { kind: "person", id, name: `p${i}` };
			const ready = Promise.withResolvers<void>();
			const done = Promise.withResolvers<void>();
			releases.push(done.resolve);
			roots.push(
				w.host.root(
					async (ctx) => {
						await ctx.get(Roots, { view: "v" });
						await ctx.get(WorkspaceChildren, { workspace: pi, view: "v" });
						await ctx.get(WorkspaceContents, { workspace: fam, view: "v" });
						await ctx.get(WorkspacePeople, { workspace: fam, view: "v" });
						ready.resolve();
						await done.promise;
					},
					context,
					{ principal },
				),
			);
			await ready.promise;
		}
		const run = async (what: string, fn: (i: number) => Promise<unknown>) => {
			const times: number[] = [];
			const reads = w.count("things.access.reads");
			const runs = w.count("chord.query.runs");
			for (let i = 0; i < 20; i++) {
				const t = performance.now();
				await fn(i);
				times.push(performance.now() - t);
			}
			console.log(
				`pages=${pages} ${what}: median ${median(times).toFixed(2)} ms, index reads/commit ${(w.count("things.access.reads") - reads) / 20}, query runs/commit ${(w.count("chord.query.runs") - runs) / 20}`,
			);
		};
		await run("rename a thing in another workspace", (i) =>
			store.rename({ thing: elsewhere, name: `x${i}` }, context),
		);
		await run("a grant in another workspace", (i) =>
			store.setTick(
				{
					workspace: other,
					thing: elsewhere,
					party: { kind: "everyone" },
					tick: "write",
					gives: i % 2 === 0,
					source: BY,
				},
				context,
			),
		);
		await run("make a board in Family", (i) =>
			store.create({ kind: Board.name, name: `n${i}`, workspace: fam, by: BY }, context),
		);
		for (const release of releases) release();
		await Promise.all(roots);
		await w.close(context);
	}
}

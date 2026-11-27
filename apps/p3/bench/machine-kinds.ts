// The machine kinds' numbers (ERNDL-1172, ERNDL-1173, ERNDL-1174): the heap per held thing of a machine, Files and
// Terminals, against the things plugin's test kind (a board with one constant state member: the things admission and
// Chord's own cost, nothing of a kind's), each held by 200 persons put into Pi, each hold a root scope of its own on the
// server's host (the plugin tier: `testPlugin` of the terminals plugin beside the things, environments and files
// plugins and a stand-in machine whose programs are fakes, with one terminal open). Measured after GC, the
// median of 5 rounds per kind after a first round apart, the kinds alternated. Run from apps/p3 with Node 26:
// node --expose-gc --conditions=source --disable-warning=ExperimentalWarning bench/machine-kinds.ts

import { fileURLToPath } from "node:url";
import { type Ctx, BACKGROUND_CONTEXT as context, type P3Principal } from "@earendil-works/p3/v1";
import { testPlugin } from "@earendil-works/p3/v1/testing";
import { MACHINE_KIND } from "../plugins/environments/contract.ts";
import { Machine } from "../plugins/environments/kind.ts";
import environmentsServer from "../plugins/environments/server.ts";
import { fakeMachine, fakeType } from "../plugins/environments/test/fake-machine.ts";
import { seeded } from "../plugins/environments/test/seeded.ts";
import { Files, FilesKind } from "../plugins/files/kind.ts";
import filesServer from "../plugins/files/server.ts";
import { Terminals, TerminalsKind } from "../plugins/terminals/kind.ts";
import { OneThing, ThingsStore } from "../plugins/things/contract.server.ts";
import thingsServer from "../plugins/things/server.ts";
import { BOARD, Board } from "../plugins/things/test/kinds.ts";

/** How many persons hold each kind. */
const HOLDERS = 200;

/** How many rounds per kind. */
const ROUNDS = 5;

const gc = (globalThis as { gc?: () => void }).gc;
if (gc === undefined) throw new Error("run with --expose-gc");

const device = fakeMachine();
const t = await testPlugin(
	fileURLToPath(new URL("../plugins/terminals/", import.meta.url)),
	{
		kind: "server",
		stubs: [
			{ name: "@earendil-works/p3-a-fake-machine", facet: fakeType(() => device.host) },
			{ name: "@earendil-works/p3-things", facet: thingsServer },
			{ name: "@earendil-works/p3-environments", facet: environmentsServer },
			{ name: "@earendil-works/p3-files", facet: filesServer },
			BOARD,
		],
	},
	context,
);
try {
	const things = await t.host.get(ThingsStore, {}, context);
	const pi = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
	const by = { kind: "plugin", plugin: "bench" } as const;
	const one = async (kind: string) => await seeded(await t.host.get(OneThing, { kind }, context), context);
	const machine = await one(MACHINE_KIND);
	const board = await things.create({ kind: Board.name, name: "b", workspace: pi, by }, context);
	const files = await one(FilesKind.name);
	const terminals = await one(TerminalsKind.name);
	/** Each kind's hold in Pi, of the thing made for it. */
	const kinds: Record<string, (ctx: Ctx<P3Principal>) => Promise<unknown>> = {
		board: (ctx) => ctx.get(Board.contract, { workspace: pi, thing: board }),
		machine: (ctx) => ctx.get(Machine, { workspace: pi, thing: machine }),
		files: (ctx) => ctx.get(Files, { workspace: pi, thing: files }),
		terminals: (ctx) => ctx.get(Terminals, { workspace: pi, thing: terminals }),
	};
	// Who may gives everyone in Pi Browse and Watch, as the owner would: the kinds give people nothing (decision 126).
	const everyone = { kind: "everyone" } as const;
	const grants = [
		{ workspace: pi, thing: files, party: everyone, tick: "browse", gives: true },
		{ workspace: pi, thing: terminals, party: everyone, tick: "watch", gives: true },
	];
	await things.setGrants({ source: by, grants }, context);
	const persons: P3Principal[] = [];
	for (let i = 0; i < HOLDERS; i++) {
		const id = await things.createPerson({ name: `p${i}`, madeBy: by }, context);
		await things.putParty({ workspace: pi, party: { kind: "person", person: id }, source: by }, context);
		persons.push({ kind: "person", id, name: `p${i}` });
	}
	// One terminal open, so every Terminals lists a row.
	await things.putParty({ workspace: pi, party: { kind: "agent", session: "s1" }, source: by }, context);
	await t.root(
		async (ctx) => {
			const terms = await ctx.get(Terminals, { workspace: pi, thing: terminals });
			await terms.open!({ machine, folder: "/tmp", columns: 80, rows: 24 }, ctx);
		},
		context,
		{ principal: { kind: "worker", session: "s1" } },
	);
	/** The heap after the objects released meanwhile closed and garbage was collected. */
	const heap = async () => {
		await new Promise((resolve) => setTimeout(resolve, 100));
		gc();
		gc();
		return process.memoryUsage().heapUsed;
	};
	/** The heap per hold of `name`'s thing by every person, in bytes. */
	const perHold = async (name: string): Promise<number> => {
		const hold = kinds[name]!;
		const release = Promise.withResolvers<void>();
		const live: Promise<void>[] = [];
		const before = await heap();
		const ready = persons.map(
			(principal) =>
				new Promise<void>((resolve, reject) => {
					live.push(
						t
							.root(
								async (ctx) => {
									await hold(ctx);
									resolve();
									await release.promise;
								},
								context,
								{ principal },
							)
							.catch(reject),
					);
				}),
		);
		await Promise.all(ready);
		const after = await heap();
		release.resolve();
		await Promise.all(live);
		return (after - before) / HOLDERS;
	};
	const results: Record<string, number[]> = { board: [], machine: [], files: [], terminals: [] };
	// A first round apart (warming the code and the index), then the measured ones.
	for (let round = -1; round < ROUNDS; round++) {
		for (const name of Object.keys(kinds)) {
			const bytes = await perHold(name);
			if (round >= 0) results[name]!.push(bytes);
		}
	}
	const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
	const baseline = median(results.board!);
	for (const [name, values] of Object.entries(results)) {
		const kib = median(values) / 1024;
		const over = name === "board" ? "" : `, ${((median(values) - baseline) / 1024).toFixed(2)} KiB over the board`;
		console.log(`${name}: ${kib.toFixed(2)} KiB per held thing${over}`);
	}
} finally {
	await t.close(context);
}

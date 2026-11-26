// The things plugin's numbers (ERNDL-1142) at the access bench's scenario S2 (RESULTS-6.md): Pi > Org > 5 teams > 20
// projects > 2,000 sessions; 30 things in Pi, 3 per team, 2 per project, 3 per session; 50 persons, 10 groups, two put
// into each team; each session's agent put into it. 100 sessions run: each agent holds every thing its session gives
// it; 30 persons hold 15 things each. Every hold goes over an in-memory link from a client host of its own, as a
// worker's and a page's do. Three variants, each in a process of its own, alternated:
// - `plain`: the thing's object with no admission;
// - `baseline`: the bench's variant 0: admitted by a derive over one shared local object per thing (Chord's
//   admission, a reference and a derive per hold, no access model);
// - `things`: the things admission (`admitThing` over `Gives` and the index).
// After the seed the things plugin is reloaded, so the holds start cold: its index has nothing loaded. Measured:
// - the heap per held thing (after GC; server and clients together, one process; in `things` the index's loads too);
// - the index's reads while the holds start (every workspace and person they need, read once);
// - one session's worker starting: its first question, cold for its workspace, and its holds started together;
// - in `things`, a change at the root (a tick given to the agents on one of Pi's things, then taken back): the write
//   as its caller waits for it, its wait in the queue (`things.store.wait`), its transaction (`things.store.commit`),
//   the index's work after it (`things.access.adopt`), and the last of its holders rebound; the same at a leaf; a new
//   session; a workspace made by a person (slice 2: its maker's ticks and membership in the same commit) and a
//   removal's first commit (the line cut).
// Run from apps/p3 with Node 26:
//   node --expose-gc --conditions=source --disable-warning=ExperimentalWarning bench/things.ts

import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import {
	allow,
	constant,
	createHost,
	defineFacet,
	type Host,
	local,
	memoryLinkPair,
	method,
	openStore,
	type P3Principal,
	type Reference,
	remote,
	Server,
	sqliteBackend,
	str,
	until,
} from "@earendil-works/p3/v1";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { Gives, type GrantInput, ThingsStore } from "../plugins/things/contract.server.ts";
import { type Source, THING_PARAMS } from "../plugins/things/contract.ts";
import { defineThing } from "../plugins/things/kind.ts";
import thingsServer from "../plugins/things/server.ts";
import { BOARD, Board } from "../plugins/things/test/kinds.ts";
import { RUNTIME } from "../plugins/things/test/world.ts";

/** A tick's label in the bench. */
const LABEL = { namespace: "bench", key: "tick", params: [] };

const VARIANTS = ["plain", "baseline", "things"] as const;
type Variant = (typeof VARIANTS)[number];

/** Runs each variant three times, alternated, in processes of their own, and prints the medians. */
function drive(): void {
	const runs = new Map<Variant, Record<string, number>[]>();
	for (let round = 0; round < 3; round++) {
		for (const each of VARIANTS) {
			const child = spawnSync(process.execPath, [...process.execArgv, import.meta.filename, "--variant", each], {
				encoding: "utf8",
			});
			if (child.status !== 0) throw new Error(`${each}: ${child.stderr}`);
			const line = child.stdout.trim().split("\n").at(-1)!;
			runs.set(each, [...(runs.get(each) ?? []), JSON.parse(line) as Record<string, number>]);
		}
	}
	const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!;
	const of = (each: Variant, key: string) => median(runs.get(each)!.map((run) => run[key]!));
	console.log(`Node ${process.versions.node}, medians of 3 runs, holds: ${of("things", "holds")}`);
	for (const each of VARIANTS) console.log(`${each}: heap per held thing ${of(each, "perHold").toFixed(2)} KiB`);
	console.log(
		`things over baseline: ${(of("things", "perHold") - of("baseline", "perHold")).toFixed(2)} KiB per hold`,
	);
	console.log(`things over plain: ${(of("things", "perHold") - of("plain", "perHold")).toFixed(2)} KiB per hold`);
	for (const key of Object.keys(runs.get("things")![0]!).filter((k) => !["perHold", "holds"].includes(k))) {
		console.log(`things: ${key}: ${of("things", key).toFixed(2)}`);
	}
}

/** The test kind's members, as declared. */
const MEMBERS = {
	state: { title: str() },
	methods: {
		read: method(undefined, str()),
		write: method(),
		draw: method(),
		moderate: method(),
		bash: method(),
		look: method(),
	},
};

/** The thing's object served plainly: the test kind's members, no admission. */
const Plain = remote("bench.plain", { version: 1, params: THING_PARAMS, hostAddress: () => Server(), ...MEMBERS });

/** The test kind under another name, for the baseline: the same members and ticks. */
const Baseline = defineThing("bench.baseline", {
	version: 1,
	...MEMBERS,
	ticks: {
		read: { label: LABEL, gives: ["read"] },
		write: { label: LABEL, gives: ["write"] },
		draw: { label: LABEL, gives: ["draw"] },
		moderate: { label: LABEL, gives: ["moderate"] },
		bash: { label: LABEL, gives: ["bash"] },
		look: { label: LABEL, gives: ["look"] },
	},
});

/** The baseline's shared object per thing. */
const Shared = local("bench.shared", { version: 1, params: { thing: str() }, members: { title: str() } });

/** The test kind's members for any caller. */
const members = (thing: string) => ({
	title: constant(thing),
	read: async () => "",
	write: async () => null,
	draw: async () => null,
	moderate: async () => null,
	bash: async () => null,
	look: async () => null,
});

/** The decision the baseline admits every caller with: every name of the kind. */
const ALL = allow({ granted: [...Baseline.all], caller: { kind: "server" } });

/**
 * The plain object, and the baseline: admitted by a derive over one shared object per thing (the bench's variant 0).
 */
const benchFacet = defineFacet((host) => {
	host.serve(Plain, ({ thing }, _principal, _self) => members(thing));
	host.serve(Shared, ({ thing }, _self) => ({ title: constant(thing) }));
	host.serve(Baseline.contract, ({ thing }, _principal, _admitted, _self) => members(thing), {
		admit: ({ thing }, _principal, self) => self.derive([self.get(Shared, { thing }).title], () => ALL),
	});
});

/** One variant's run: S2 seeded, the holds made, the heap measured; in `things` also the changes. */
async function measure(which: Variant): Promise<void> {
	const gc = (globalThis as { gc?: () => void }).gc;
	if (gc === undefined) throw new Error("run with --expose-gc");
	const heap = async () => {
		for (let i = 0; i < 6; i++) {
			gc();
			await new Promise((resolve) => setImmediate(resolve));
		}
		return process.memoryUsage().heapUsed / 1024;
	};
	const telemetry = new InMemoryTelemetryContext();
	const counted = (name: string) =>
		telemetry
			.getMetrics()
			.filter((metric) => metric.name === name)
			.reduce((sum, metric) => sum + metric.value, 0);
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
	const server = createHost<P3Principal>({
		address: Server(),
		principal: { kind: "server" },
		store,
		telemetry,
		readyTimeout: 60_000,
		onError: (error) => console.error(error),
	});
	const plugins = [
		RUNTIME,
		{ name: "@earendil-works/p3-things", facet: thingsServer },
		BOARD,
		{ name: "bench", facet: benchFacet },
	];
	await server.load(plugins, context);
	const { holders, piThings, sessions } = await seed(server, await server.get(ThingsStore, {}, context));
	// The things plugin's next object: its index starts with nothing loaded (the seed loaded what the agents hold).
	const report = await server.reload(
		plugins.map((plugin) =>
			plugin.name === "@earendil-works/p3-things" ? { ...plugin, facet: { ...plugin.facet } } : plugin,
		),
		context,
	);
	if (report.failed.length > 0) throw new Error("the reload failed", { cause: report.failed[0]!.error });
	const things = await server.get(ThingsStore, {}, context);
	const clients: Host<P3Principal>[] = [];
	for (const { principal } of holders) {
		const [toServer, fromClient] = memoryLinkPair();
		const client = createHost<P3Principal>({ readyTimeout: 60_000, onError: (error) => console.error(error) });
		server.accept(fromClient, { principal }, context);
		client.connect(toServer, { principal: { kind: "server" } }, context);
		await client.load([], context);
		clients.push(client);
	}
	const before = await heap();
	const reads = counted("things.access.reads");
	const start = performance.now();
	const held: { principal: P3Principal; thing: string; ref: Reference<typeof Board.contract> }[] = [];
	// The three contracts have the same members; the references are read alike.
	const Type = (
		which === "plain" ? Plain : which === "baseline" ? Baseline.contract : Board.contract
	) as typeof Board.contract;
	for (const [i, { principal, workspace, things: mine }] of holders.entries()) {
		for (const thing of mine)
			held.push({ principal, thing, ref: clients[i]!.hold(Type, { workspace, thing }, context) });
	}
	for (const { ref } of held) await until(ref.state, (state) => state.kind === "live", context);
	const holdMs = performance.now() - start;
	const perHold = ((await heap()) - before) / held.length;
	const result: Record<string, number> = { holds: held.length, perHold, holdMs };
	Object.assign(result, await oneWorker(server, Type, sessions, which, telemetry));
	if (which === "things") {
		result.coldReads = counted("things.access.reads") - reads;
		result.queryRuns = counted("chord.query.runs");
		Object.assign(result, await changes(things, telemetry, held, piThings, sessions));
	}
	for (const { ref } of held) ref.release();
	for (const client of clients) await client.close(context);
	await server.close(context);
	await store.close(context);
	console.log(JSON.stringify(result));
}

/**
 * One session's worker starting, as a worker does: for 10 sessions nobody held yet, its first question (`Gives` on
 * its workspace, cold there: the session's own entries, its ancestors already loaded; `things` only), then every
 * thing it is given held at once over a link of its own, until all are live. Medians.
 */
async function oneWorker(
	server: Host<P3Principal>,
	Type: typeof Board.contract,
	sessions: readonly { id: string; things: string[] }[],
	which: Variant,
	telemetry: InMemoryTelemetryContext,
): Promise<Record<string, number>> {
	const questions: number[] = [];
	const starts: number[] = [];
	const reads: number[] = [];
	const sizes: number[] = [];
	const counted = () =>
		telemetry
			.getMetrics()
			.filter((metric) => metric.name === "things.access.reads")
			.reduce((sum, metric) => sum + metric.value, 0);
	for (const session of sessions.filter((_, i) => i % 20 === 10).slice(0, 10)) {
		const before = counted();
		const t0 = performance.now();
		const gives = await server.get(Gives, { workspace: session.id, caller: `worker:${session.id}` }, context);
		questions.push(performance.now() - t0);
		reads.push(counted() - before);
		const mine = boardsOf(gives.answers.value);
		sizes.push(mine.length);
		gives.release();
		const [toServer, fromClient] = memoryLinkPair();
		const client = createHost<P3Principal>({ readyTimeout: 60_000, onError: (error) => console.error(error) });
		server.accept(fromClient, { principal: { kind: "worker", session: session.id } }, context);
		client.connect(toServer, { principal: { kind: "server" } }, context);
		await client.load([], context);
		const t1 = performance.now();
		const refs = mine.map((thing) => client.hold(Type, { workspace: session.id, thing }, context));
		for (const ref of refs) await until(ref.state, (state) => state.kind === "live", context);
		starts.push(performance.now() - t1);
		for (const ref of refs) ref.release();
		await client.close(context);
	}
	const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!;
	return {
		workerHolds: median(sizes),
		workerStartMs: median(starts),
		...(which === "things" ? { coldQuestionMs: median(questions), coldQuestionReads: median(reads) } : {}),
	};
}

/** The boards among `answers` (a workspace's own answer is of its workspace kind). */
function boardsOf(answers: Readonly<Record<string, { readonly kind: string }>>): string[] {
	return Object.entries(answers)
		.filter(([, answer]) => answer.kind === Board.name)
		.map(([thing]) => thing);
}

/** S2, written through the store; who holds what. */
async function seed(server: Host<P3Principal>, things: Reference<typeof ThingsStore>) {
	const by: Source = { kind: "plugin", plugin: "bench" };
	const pi = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
	const space = (name: string, parent: string) =>
		things.createWorkspace({ kind: "things.workspace", name, parent, by }, context);
	const make = (workspace: string) => things.create({ kind: Board.name, name: "t", workspace, by }, context);
	const piThings: string[] = [];
	for (let i = 0; i < 30; i++) piThings.push(await make(pi));
	const persons: string[] = [];
	for (let i = 0; i < 50; i++) persons.push(await things.createPerson({ name: `p${i}`, madeBy: by }, context));
	const groups: string[] = [];
	for (let i = 0; i < 10; i++) {
		const group = await things.makeGroup({ name: `g${i}`, managedBy: { kind: "people" }, outside: false }, context);
		groups.push(group);
		for (let j = 0; j < 10; j++)
			await things.addToGroup({ group, person: persons[(i * 5 + j) % 50]!, source: by }, context);
	}
	const org = await space("Org", pi);
	const sessions: { id: string; team: number; things: string[] }[] = [];
	for (let team = 0; team < 5; team++) {
		const t = await space(`team${team}`, org);
		for (let i = 0; i < 3; i++) await make(t);
		for (const group of [groups[2 * team]!, groups[2 * team + 1]!]) {
			await things.putParty({ workspace: t, party: { kind: "group", group }, source: by }, context);
		}
		for (let project = 0; project < 4; project++) {
			const p = await space(`project${project}`, t);
			for (let i = 0; i < 2; i++) await make(p);
			for (let s = 0; s < 100; s++) {
				const id = await space(`s${s}`, p);
				await things.putParty({ workspace: id, party: { kind: "agent", session: id }, source: by }, context);
				sessions.push({ id, team, things: [await make(id), await make(id), await make(id)] });
			}
		}
	}
	const holders: { principal: P3Principal; workspace: string; things: string[] }[] = [];
	for (const session of sessions.filter((_, i) => i % 20 === 0)) {
		const gives = await server.get(Gives, { workspace: session.id, caller: `worker:${session.id}` }, context);
		holders.push({
			principal: { kind: "worker", session: session.id },
			workspace: session.id,
			// The boards it is given (the workspace's own answer is no board: slice 2).
			things: boardsOf(gives.answers.value),
		});
		gives.release();
	}
	for (let i = 0; i < 30; i++) {
		const session = sessions[(i * 67) % sessions.length]!;
		const person = persons[(session.team * 10 + (i % 10)) % 50]!;
		holders.push({
			principal: { kind: "person", id: person, name: "p" },
			workspace: session.id,
			things: [...piThings.slice(0, 12), ...session.things],
		});
	}
	return { holders, piThings, sessions };
}

/**
 * The changes, timed: at the root (one of Pi's things, the agents' Draw given and taken back), a leaf, a new session.
 */
async function changes(
	things: Reference<typeof ThingsStore>,
	telemetry: InMemoryTelemetryContext,
	held: readonly { principal: P3Principal; thing: string; ref: Reference<typeof Board.contract> }[],
	piThings: readonly string[],
	sessions: readonly { id: string; things: string[] }[],
): Promise<Record<string, number>> {
	const plugin: Source = { kind: "plugin", plugin: "p3-test-board" };
	const bench: Source = { kind: "plugin", plugin: "bench" };
	const pi = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
	/** The last value histogram `name` recorded since the write that began at measurement `since`. */
	const recorded = (name: string, since: number) =>
		telemetry
			.getMetrics()
			.slice(since)
			.filter((metric) => metric.name === name)
			.at(-1)!.value;
	/** One write of `grant` by `source`, timed, then `holders` waited for until `done` says each rebound. */
	const timed = async (
		source: Source,
		grant: GrantInput,
		holders: readonly Reference<typeof Board.contract>[],
		done: (ref: Reference<typeof Board.contract>) => boolean,
	) => {
		const since = telemetry.getMetrics().length;
		const t0 = performance.now();
		await things.setGrants({ source, grants: [grant] }, context);
		const write = performance.now() - t0;
		for (const ref of holders) await until(ref.state, (state) => state.kind === "live" && done(ref), context);
		const last = performance.now() - t0;
		// After the clock stopped: reading the metrics copies every measurement so far.
		return {
			write,
			wait: recorded("things.store.wait", since),
			commit: recorded("things.store.commit", since),
			adopt: recorded("things.access.adopt", since),
			last,
		};
	};
	const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!;
	/** The medians of `runs`, each key prefixed by `prefix`. */
	const medians = (prefix: string, runs: readonly Record<string, number>[]) =>
		Object.fromEntries(
			Object.keys(runs[0]!).map((key) => [
				`${prefix}${key[0]!.toUpperCase()}${key.slice(1)}Ms`,
				median(runs.map((run) => run[key]!)),
			]),
		);
	const target = piThings[0]!;
	const affected = held.filter(({ principal, thing }) => principal.kind === "worker" && thing === target);
	const roots: Record<string, number>[] = [];
	for (let round = 0; round < 10; round++) {
		// The kind's row of Draw for the agents written, then removed.
		const wanted = round % 2 === 0;
		const grant = {
			workspace: pi,
			thing: target,
			party: { kind: "agents" } as const,
			tick: "draw",
			...(wanted ? { gives: true } : {}),
		};
		roots.push(
			await timed(
				plugin,
				grant,
				affected.map(({ ref }) => ref),
				(ref) => (ref.draw !== undefined) === wanted,
			),
		);
	}
	const leaf = sessions[0]!;
	const leafHolder = held.find(
		({ principal, thing }) =>
			principal.kind === "worker" && principal.session === leaf.id && thing === leaf.things[0],
	);
	const leaves: Record<string, number>[] = [];
	for (let round = 0; round < 10; round++) {
		// The kind's Read withheld from the agents by the bench (they stay in, with no tick), then the row removed.
		const wanted = round % 2 === 1;
		const grant = {
			workspace: leaf.id,
			thing: leaf.things[0]!,
			party: { kind: "agents" } as const,
			tick: "read",
			...(wanted ? {} : { gives: false }),
		};
		leaves.push(
			await timed(
				bench,
				grant,
				leafHolder === undefined ? [] : [leafHolder.ref],
				(ref) => (ref.read !== undefined) === wanted,
			),
		);
	}
	const project = (await things.workspaces.one.page({ workspace: leaf.id }, 1, context)).items[0]!.parent;
	const news: number[] = [];
	for (let round = 0; round < 10; round++) {
		const t0 = performance.now();
		const id = await things.createWorkspace(
			{ kind: "things.workspace", name: "new", parent: project, by: bench },
			context,
		);
		await things.putParty({ workspace: id, party: { kind: "agent", session: id }, source: bench }, context);
		for (let i = 0; i < 3; i++)
			await things.create({ kind: Board.name, name: "t", workspace: id, by: bench }, context);
		news.push(performance.now() - t0);
	}
	// Slice 2: a workspace made by a person under a project (one commit: its line and path, the maker's every tick and
	// Make any kind, the maker put in), and a removal's first commit (the line cut; the rest runs in the background).
	const maker = await things.createPerson({ name: "maker", madeBy: bench }, context);
	const made: number[] = [];
	const cuts: number[] = [];
	for (let round = 0; round < 20; round++) {
		const t0 = performance.now();
		const id = await things.createWorkspace(
			{ kind: "things.workspace", name: "made", parent: project, by: { kind: "person", person: maker } },
			context,
		);
		made.push(performance.now() - t0);
		const t1 = performance.now();
		await things.removeWorkspace({ workspace: id }, context);
		cuts.push(performance.now() - t1);
	}
	return {
		rootHolders: affected.length,
		...medians("root", roots),
		...medians("leaf", leaves),
		newSessionMs: median(news),
		newWorkspaceMs: median(made),
		newWorkspaceMaxMs: Math.max(...made),
		removeCutMs: median(cuts),
		removeCutMaxMs: Math.max(...cuts),
	};
}

// The entry, last: the declarations above are made before it runs.
const { variant } = parseArgs({ options: { variant: { type: "string" } } }).values;
if (variant === undefined) drive();
else await measure(variant as Variant);

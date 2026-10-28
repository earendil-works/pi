// Light benchmarks of links and relays (slice 4a): commit-to-frame and wire bytes through a relay (tab ↔ server ↔
// worker) over memory links, a real IPC link to a forked worker and a loopback WebSocket to the tab; hold-to-live
// through a relay including the `resolve` of a worker; a tab throttled to 64 KiB/s with stalls of 1, 10 and 60 s
// receiving a streamed reply into a 500 KB view, directly and through a relay (the worker folds either way: its window
// is per origin), in virtual time; 10,000 calls from one tab with another tab's latency through the relay.
// Run by hand from packages/chord (not in CI):
//   node --conditions=source --experimental-strip-types --expose-gc --no-flush-bytecode test/next/bench/relay.ts
// (`--no-flush-bytecode`: V8 otherwise drops the bytecode of functions idle during a stall, which reads as freed heap.)
// The same file is the forked worker when its first argument is `worker`.
import { type ChildProcess, fork } from "node:child_process";
import type { AddressInfo } from "node:net";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { arr, hostKind, int, local, method, obj, remote, str } from "../../../src/next/contracts/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet, type Host } from "../../../src/next/host/index.ts";
import { type IpcPort, ipcLink, type Link, memoryLinkPair, webSocketLink } from "../../../src/next/link/index.ts";

type P = { kind: "owner" } | { kind: "server" } | { kind: "worker"; session: string };

const Server = hostKind("server");
const Session = hostKind("session", { id: str() });

const Entry = obj({ id: int(), text: str(), author: str(), at: int() });
const Shape = obj({ entries: arr(Entry) });

type Entry = { id: number; text: string; author: string; at: number };

/** A worker's own store: one document of entries, and the write the benchmark makes (a streamed token). */
const Store = local("bench.store", {
	version: 1,
	params: {},
	members: { doc: Shape, stream: method(str()) },
});

/** What a tab holds: its session's store as it is, placed on the session's worker, and a small call. */
const View = remote("bench.view", {
	version: 1,
	params: { session: str() },
	placement: ({ session }) => Session({ id: session }),
	variants: { owner: { state: { doc: Shape }, methods: { stream: method(str()), ping: method(int(), int()) } } },
});

/** The start data a worker gets in its start message: its session and the payload its store begins with. */
type Start = { readonly id: string; readonly entries: "notes" | "document" };

function entry(id: number, length: number): Entry {
	return { id, text: "x".repeat(length), author: "mario", at: 1_700_000_000_000 + id };
}

/** The notes list (1,000 entries of 80 characters, 134 KiB) or a 500 KB conversation document (500 of 960). */
function entriesOf(kind: Start["entries"]): Entry[] {
	return kind === "notes"
		? Array.from({ length: 1_000 }, (_, id) => entry(id, 80))
		: Array.from({ length: 500 }, (_, id) => entry(id, 960));
}

/** A worker's facet: its store starts with the start message's entries (the §18 core facet pattern). */
function workerFacet(start: Start) {
	const Doc = defineState("doc", {
		schema: Shape,
		version: 1,
		initial: () => ({ entries: entriesOf(start.entries) }),
	});
	return defineFacet<P>((host) => {
		host.serve(Store, (_, self) => {
			const doc = self.state(Doc);
			return {
				doc,
				stream: (token, ctx) =>
					doc
						.change((draft) => {
							draft.entries[draft.entries.length - 1]!.text += token;
						}, ctx)
						.then(() => null),
			};
		});
		host.serve(View, (_params, _principal, self) => {
			const store = self.get(Store, {});
			return {
				variant: "owner",
				members: { doc: store.doc, stream: (token, ctx) => store.stream(token, ctx), ping: async (n) => n + 1 },
			};
		});
	});
}

/** A worker host for `start`, not loaded yet. */
function workerHost(start: Start): Host<P> {
	return createHost<P>({
		address: Session({ id: start.id }),
		principal: { kind: "worker", session: start.id },
		onError: console.error,
	});
}

/** A worker on `link`, its parent link: connect first, then load (W6). */
function startWorker(start: Start, link: Link): Host<P> {
	const worker = workerHost(start);
	worker.connect(link, { principal: { kind: "server" }, trusted: true }, context);
	void worker.load([{ name: "@bench/worker", facet: workerFacet(start) }], context);
	return worker;
}

/** A link end counting the bytes it sends and receives. */
type Counted = Link & { readonly sent: number; readonly received: number };

function counted(link: Link): Counted {
	let sent = 0;
	let received = 0;
	return {
		get sent() {
			return sent;
		},
		get received() {
			return received;
		},
		send(message) {
			sent += message.byteLength;
			link.send(message);
		},
		onMessage: (listener) =>
			link.onMessage((message) => {
				received += message.byteLength;
				listener(message);
			}),
		close: () => link.close(),
		onClose: (listener) => link.onClose(listener),
	};
}

/** A link end timing how long its host handles each received message. */
type Timed = Link & { longest: number };

function timed(link: Link): Timed {
	const timing: Timed = {
		longest: 0,
		send: (message) => link.send(message),
		onMessage: (listener) =>
			link.onMessage((message) => {
				const start = performance.now();
				listener(message);
				timing.longest = Math.max(timing.longest, performance.now() - start);
			}),
		close: () => link.close(),
		onClose: (listener) => link.onClose(listener),
	};
	return timing;
}

/** How a server reaches its workers: in this process, or forked over IPC. */
type WorkerKind = "memory" | "ipc";

/** The children forked in this run, ended with it. */
const children: ChildProcess[] = [];

/** A server routing `Session` to workers of `kind` whose stores start with `entries`. */
async function server(kind: WorkerKind, entries: Start["entries"]) {
	const host = createHost<P>({ address: Server(), principal: { kind: "server" }, onError: console.error });
	/** Each worker link's server end, counted; the in-process workers and their ends, timed. */
	const workerLinks: Counted[] = [];
	const workers: { readonly host: Host<P>; readonly link: Timed }[] = [];
	host.route(
		Session,
		{
			authorize: () => true,
			resolve: async (address) => {
				const start = { id: address.params.id, entries };
				const principal = { kind: "worker", session: start.id } as const;
				if (kind === "memory") {
					const [a, b] = memoryLinkPair();
					const end = timed(b);
					workers.push({ host: startWorker(start, end), link: end });
					const link = counted(a);
					workerLinks.push(link);
					return { link, principal, trusted: true };
				}
				const child = fork(fileURLToPath(import.meta.url), ["worker"], {
					serialization: "advanced",
					execArgv: ["--conditions=source", "--experimental-strip-types", "--no-warnings"],
				});
				children.push(child);
				const link = counted(ipcLink(child));
				// The app's own start message; the link skips it.
				child.send(start);
				workerLinks.push(link);
				return { link, principal, trusted: true };
			},
		},
		context,
	);
	await host.load([], context);
	return { host, workerLinks, workers };
}

/** A tab: a client host connected to `link`. */
async function tab(link: Link): Promise<Host<P>> {
	const host = createHost<P>({ onError: console.error });
	host.connect(link, { principal: { kind: "server" } }, context);
	await host.load([], context);
	return host;
}

/** A tab on `on` over a memory link, the server's end counted. */
async function memoryTab(on: Host<P>): Promise<{ readonly tab: Host<P>; readonly link: Counted }> {
	const [a, b] = memoryLinkPair();
	const link = counted(a);
	on.accept(link, { principal: { kind: "owner" } }, context);
	return { tab: await tab(b), link };
}

/** A tab on `on` over a loopback WebSocket (`ws` serving, Node's own `WebSocket` in the tab), the server's end counted. */
async function webSocketTab(on: Host<P>) {
	const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await new Promise((resolve) => wss.once("listening", resolve));
	const accepted = Promise.withResolvers<Counted>();
	wss.on("connection", (socket) => {
		const link = counted(webSocketLink(socket));
		on.accept(link, { principal: { kind: "owner" } }, context);
		accepted.resolve(link);
	});
	const { port } = wss.address() as AddressInfo;
	const host = await tab(webSocketLink(new WebSocket(`ws://127.0.0.1:${port}`)));
	const close = () => new Promise((resolve) => wss.close(resolve));
	return { tab: host, link: await accepted.promise, close };
}

/** A worker with `entries` served directly to a tab over one memory link (no relay), the worker's end counted. */
async function direct(entries: Start["entries"], wrap: (link: Link) => Link = (link) => link) {
	const worker = workerHost({ id: "D", entries });
	await worker.load([{ name: "@bench/worker", facet: workerFacet({ id: "D", entries }) }], context);
	const [a, b] = memoryLinkPair();
	const link = counted(a);
	const end = timed(link);
	worker.accept(end, { principal: { kind: "owner" } }, context);
	return { worker, link, end, tab: await tab(wrap(b)) };
}

const ms = (value: number) => `${value.toFixed(3)} ms`;
const kb = (value: number) => `${(value / 1024).toFixed(1)} KiB`;
const b = (value: number) => (value >= 10_240 ? kb(value) : `${value.toFixed(0)} B`);
const s = (value: number) => `${value.toFixed(2)} s`;
const gc = (globalThis as { gc?: () => void }).gc!;

/** Prints a markdown table. */
function print(title: string, head: readonly string[], rows: readonly (readonly string[])[]): void {
	console.log(`\n${title}\n`);
	console.log(`| ${head.join(" | ")} |`);
	console.log(`| ${head.map(() => "---").join(" | ")} |`);
	for (const row of rows) console.log(`| ${row.join(" | ")} |`);
}

/**
 * Commits as a tab sees them: the tab calls `stream` on its view 1,000 times, each one commit on the worker; the time
 * from the call to the tab's watch frame (the call's hops down, the frame's up), and the bytes per commit on the tab
 * link (sent to the tab) and the worker link (received from the worker).
 */
async function commits(holder: Host<P>, session: string, tabLink: Counted, workerLinks: readonly Counted[]) {
	const view = await holder.get(View, { session }, context);
	// Made by the route's `resolve` for the first hold (none without a relay).
	const workerLink = workerLinks[0];
	const watch = await view.doc.watch(context);
	let frame: () => void = () => {};
	watch.start(async () => frame());
	// Warm-up.
	for (let i = 0; i < 100; i++) await view.stream(" w", context);
	const runs = 1_000;
	const tab0 = tabLink.sent;
	const worker0 = workerLink?.received ?? 0;
	let total = 0;
	for (let i = 0; i < runs; i++) {
		const arrived = new Promise<void>((resolve) => {
			frame = resolve;
		});
		const start = performance.now();
		await Promise.all([view.stream(" tok", context), arrived]);
		total += performance.now() - start;
	}
	await watch.stop();
	view.release();
	const workerBytes = workerLink === undefined ? "-" : b((workerLink.received - worker0) / runs);
	return [ms(total / runs), `${b((tabLink.sent - tab0) / runs)} / ${workerBytes}`];
}

/** Commit-to-frame through a relay over each transport, and directly (one memory link, no relay) as the baseline. */
async function transports(): Promise<void> {
	const rows: string[][] = [];
	{
		const { host, workerLinks } = await server("memory", "notes");
		const { tab: t, link } = await memoryTab(host);
		rows.push(["memory tab, in-process worker (memory)", ...(await commits(t, "C", link, workerLinks))]);
		await t.close(context);
		await host.close(context);
	}
	{
		const { host, workerLinks } = await server("ipc", "notes");
		const { tab: t, link } = await memoryTab(host);
		const start = performance.now();
		(await t.get(View, { session: "C" }, context)).release();
		const first = performance.now() - start;
		rows.push(["memory tab, forked worker (IPC)", ...(await commits(t, "C", link, workerLinks))]);
		rows.push(["  first hold to live, the fork included (one sample)", ms(first), "-"]);
		await t.close(context);
		await host.close(context);
	}
	{
		const { host, workerLinks } = await server("ipc", "notes");
		const { tab: t, link, close } = await webSocketTab(host);
		rows.push(["loopback WebSocket tab, forked worker (IPC)", ...(await commits(t, "C", link, workerLinks))]);
		await t.close(context);
		await host.close(context);
		await close();
	}
	{
		const { worker, link, tab: t } = await direct("notes");
		rows.push(["no relay: memory tab on the worker (baseline)", ...(await commits(t, "D", link, []))]);
		await t.close(context);
		await worker.close(context);
	}
	print(
		"Commits through a relay (1,000 streamed tokens into the 1,000-item notes list view)",
		["Topology", "call to frame", "bytes per commit: to the tab / from the worker"],
		rows,
	);
}

/**
 * Hold to live through a relay: a first hold of each of 20 sessions (the route's `resolve` starts an in-process worker,
 * which loads and activates the view: one hop more than a later hold), then 100 holds of a resolved session, each
 * released; and the same 100 holds directly on a worker.
 */
async function holds(): Promise<void> {
	const rows: string[][] = [];
	const { host } = await server("memory", "notes");
	const { tab: t } = await memoryTab(host);
	let start = performance.now();
	for (let i = 0; i < 20; i++) await t.get(View, { session: `H${i}` }, context);
	rows.push([
		"first hold, `resolve` of an in-process worker included (mean of 20)",
		ms((performance.now() - start) / 20),
	]);
	start = performance.now();
	for (let i = 0; i < 100; i++) (await t.get(View, { session: "H0" }, context)).release();
	rows.push([
		"hold of a resolved session through the relay (four hops, mean of 100)",
		ms((performance.now() - start) / 100),
	]);
	await t.close(context);
	await host.close(context);
	const { worker, tab: d } = await direct("notes");
	await d.get(View, { session: "D" }, context);
	start = performance.now();
	for (let i = 0; i < 100; i++) (await d.get(View, { session: "D" }, context)).release();
	rows.push(["no relay: hold on the worker (two hops, mean of 100, baseline)", ms((performance.now() - start) / 100)]);
	await d.close(context);
	await worker.close(context);
	print("Hold to live, the 1,000-item notes list view (133.7 KiB snapshot)", ["Case", "time"], rows);
}

/**
 * A tab's end of a link that delivers what arrives at `rate` bytes per virtual second, whole messages in order, and
 * nothing while stalled; virtual time advances by `step`. Idle time banks no budget.
 */
class Throttled implements Link {
	stalled = false;
	delivered = 0;
	readonly #link: Link;
	readonly #rate: number;
	readonly #queue: Uint8Array[] = [];
	#budget = 0;
	#listener: (message: Uint8Array) => void = () => {};

	constructor(link: Link, rate: number) {
		this.#link = link;
		this.#rate = rate;
		link.onMessage((message) => this.#queue.push(message));
	}

	send(message: Uint8Array): void {
		this.#link.send(message);
	}

	onMessage(listener: (message: Uint8Array) => void): void {
		this.#listener = listener;
	}

	close(): void {
		this.#link.close();
	}

	onClose(listener: () => void): void {
		this.#link.onClose(listener);
	}

	/** `milliseconds` of virtual time pass. */
	step(milliseconds: number): void {
		if (this.stalled) return;
		const budget = (this.#rate * milliseconds) / 1000;
		this.#budget += budget;
		while (this.#queue.length > 0 && this.#queue[0]!.byteLength <= this.#budget) {
			const message = this.#queue.shift()!;
			this.#budget -= message.byteLength;
			this.delivered += message.byteLength;
			this.#listener(message);
		}
		if (this.#queue.length === 0) this.#budget = Math.min(this.#budget, budget);
	}
}

/** The heap in use once queued work ran and garbage was collected, repeatedly. */
async function settledHeap(): Promise<number> {
	for (let i = 0; i < 5; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		gc();
	}
	return process.memoryUsage().heapUsed;
}

/** Lets every host handle what the last step delivered (memory links deliver in microtasks). */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const STEP = 10;

/** Tokens per virtual second: a fast model's streamed reply. */
const TOKENS = 100;

/**
 * A pause of the throttled tab: a stall (it receives nothing and so acknowledges nothing), or the same time without one
 * (the control: what the streaming alone costs).
 */
type Pause = { readonly kind: "stall" | "control"; readonly seconds: number };

/**
 * A tab throttled to 64 KiB/s holding the 500 KB document view of a worker that streams a reply at 100 tokens/s, in
 * virtual time (10 ms steps): 2 s of streaming, the pause, 10 s more of streaming, then until the tab caught up.
 * `relayed`: through a server (it forwards at once, the worker folds the tab origin's ops); `direct`: on the worker (it
 * folds the ops in its pending queues).
 */
async function throttled(topology: "direct" | "relayed", pause: Pause): Promise<string[]> {
	const relayed = topology === "relayed";
	let throttle: Throttled | undefined;
	const throttling = (link: Link) => {
		throttle = new Throttled(link, 64 * 1024);
		return throttle;
	};
	let t: Host<P>;
	let producer: () => { readonly host: Host<P>; readonly end: Timed };
	let close: () => Promise<void>;
	if (relayed) {
		const { host, workers } = await server("memory", "document");
		const [a, b] = memoryLinkPair();
		host.accept(a, { principal: { kind: "owner" } }, context);
		t = await tab(throttling(b));
		producer = () => ({ host: workers[0]!.host, end: workers[0]!.link });
		close = async () => {
			await t.close(context);
			await host.close(context);
		};
	} else {
		const made = await direct("document", throttling);
		t = made.tab;
		producer = () => ({ host: made.worker, end: made.end });
		close = async () => {
			await t.close(context);
			await made.worker.close(context);
		};
	}
	// The first snapshot crosses the throttle in virtual time too.
	const getting = t.get(View, { session: relayed ? "T" : "D" }, context);
	let bound = false;
	void getting.then(() => {
		bound = true;
	});
	while (!bound) {
		throttle!.step(STEP);
		await settle();
	}
	const view = await getting;
	const { host: worker, end: providerEnd } = producer();
	const store = await worker.get(Store, {}, context);
	const last = (value: { readonly entries: readonly Entry[] }) => value.entries.at(-1)!.text.length;
	const caughtUp = () => last(view.doc.value) === last(store.doc.value);
	let clock = 0;
	const commitTimes = { outside: 0, outsideCount: 0, during: 0, duringCount: 0 };
	/** One virtual step: a token when streaming (its commit timed), delivery, the hosts' turn. */
	const step = async (streaming: boolean, phase: "outside" | "during") => {
		clock += STEP;
		if (streaming && clock % (1000 / TOKENS) === 0) {
			const start = performance.now();
			await store.stream(" tok", context);
			commitTimes[phase] += performance.now() - start;
			commitTimes[phase === "outside" ? "outsideCount" : "duringCount"]++;
		}
		throttle!.step(STEP);
		await settle();
	};
	for (let i = 0; i < 2000 / STEP; i++) await step(true, "outside");
	while (!caughtUp()) await step(false, "outside");
	const heap0 = await settledHeap();
	throttle!.stalled = pause.kind === "stall";
	for (let i = 0; i < (pause.seconds * 1000) / STEP; i++) await step(true, "during");
	const heap = (await settledHeap()) - heap0;
	throttle!.stalled = false;
	const stallEnd = clock;
	const delivered0 = throttle!.delivered;
	providerEnd.longest = 0;
	let recovered: number | undefined;
	for (let i = 0; recovered === undefined && i < 120_000 / STEP; i++) {
		await step(clock - stallEnd < 10_000, "outside");
		if (caughtUp()) recovered = clock - stallEnd;
	}
	const row = [
		pause.kind === "stall"
			? `${topology}, ${pause.seconds} s stall`
			: `${topology}, ${pause.seconds} s without a stall (control)`,
		recovered === undefined ? "> 120 s" : s(recovered / 1000),
		b(throttle!.delivered - delivered0),
		kb(heap),
		`${ms(commitTimes.outside / commitTimes.outsideCount)} / ${ms(commitTimes.during / commitTimes.duringCount)}`,
		ms(providerEnd.longest),
	];
	store.release();
	view.release();
	await close();
	return row;
}

async function slowTabs(): Promise<void> {
	const rows: string[][] = [];
	for (const topology of ["direct", "relayed"] as const) {
		for (const seconds of [1, 10, 60]) rows.push(await throttled(topology, { kind: "stall", seconds }));
		rows.push(await throttled(topology, { kind: "control", seconds: 60 }));
	}
	print(
		"A tab throttled to 64 KiB/s, a reply streamed at 100 tokens/s into the 500 KB view (virtual time)",
		[
			"Case",
			"caught up after the stall",
			"bytes to the tab until then",
			"heap growth during the stall",
			"commit at the worker, outside / during the pause",
			"longest message handling at the provider after the stall",
		],
		rows,
	);
}

/** 10,000 calls from tab A through the relay at once, and tab B's sequential calls meanwhile; B alone as the baseline. */
async function calls(): Promise<void> {
	const { host } = await server("memory", "notes");
	const a = await memoryTab(host);
	const bTab = await memoryTab(host);
	const viewA = await a.tab.get(View, { session: "K" }, context);
	const viewB = await bTab.tab.get(View, { session: "K" }, context);
	const latencies = async (until: () => boolean, max: number) => {
		const times: number[] = [];
		while (!until() && times.length < max) {
			const start = performance.now();
			await viewB.ping(times.length, context);
			times.push(performance.now() - start);
		}
		return times.sort((x, y) => x - y);
	};
	const percentile = (times: readonly number[], p: number) =>
		times[Math.min(times.length - 1, Math.floor(times.length * p))]!;
	for (let i = 0; i < 1_000; i++) await viewB.ping(i, context);
	const alone = await latencies(() => false, 1_000);
	let done = false;
	const start = performance.now();
	const burst = Promise.all(Array.from({ length: 10_000 }, (_, i) => viewA.ping(i, context))).then(() => {
		done = true;
	});
	const during = await latencies(() => done, 100_000);
	await burst;
	const total = performance.now() - start;
	print(
		"Calls through the relay (in-process worker, memory links, N = 256 per link)",
		["Case", "p50", "p95", "max", "calls"],
		[
			["tab B alone", ms(percentile(alone, 0.5)), ms(percentile(alone, 0.95)), ms(alone.at(-1)!), `${alone.length}`],
			[
				"tab B while tab A has 10,000 calls in flight or queued",
				ms(percentile(during, 0.5)),
				ms(percentile(during, 0.95)),
				ms(during.at(-1)!),
				`${during.length}`,
			],
			["tab A: 10,000 calls at once, until the last result", ms(total), "-", "-", "10000"],
		],
	);
	await a.tab.close(context);
	await bTab.tab.close(context);
	await host.close(context);
}

// The forked worker: its link first (it queues what arrives before the start message), then the start message.
if (process.argv[2] === "worker") {
	// A forked child's `process` is an IPC port.
	const link = ipcLink(process as unknown as IpcPort);
	const start = await new Promise<Start>((resolve) => {
		const listener = (message: unknown) => {
			if (message instanceof Uint8Array) return;
			process.off("message", listener);
			// The app's own message, sent by `resolve` above.
			resolve(message as Start);
		};
		process.on("message", listener);
	});
	startWorker(start, link);
	link.onClose(() => process.exit(0));
} else {
	await transports();
	await holds();
	await slowTabs();
	await calls();
	for (const child of children) child.kill();
}

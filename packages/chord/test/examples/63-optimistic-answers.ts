// A call's answer follows its state (decision of 2026-11-05), and the optimistic value a terminal UI shows while a
// call is pending (`TuiScope.optimistic`, React's `useOptimistic`). A session's worker renames its session and pushes
// the new title to the server's index inside the method, as an app's worker should. A slow terminal client holds the
// index (served by the server) and calls `rename` (relayed by the server to the worker). The server's window for the
// client is full, so its index change waits; before the server forwards the worker's answer it sends that waiting
// state, so when the call settles in the client the index already has the new title: the optimistic title is replaced
// by the real one and the old one never shows again.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/63-optimistic-answers.ts
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { hostKind, local, map, method, obj, remote, str } from "../../src/contracts/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { createHost, defineFacet, type Host } from "../../src/host/index.ts";
import { binaryCodec, describeMessage, type Link, memoryLinkPair } from "../../src/link/index.ts";
import { TuiScope } from "../../src/tui/scope.ts";

const context = BACKGROUND_CONTEXT;

type P = { kind: "owner" } | { kind: "server" } | { kind: "worker"; session: string };

const Server = hostKind("server");
const Session = hostKind("session", { id: str() });

const Report = obj({ id: str(), title: str() });

/** The server's index of session titles: one store, whoever views it. */
const SessionIndex = local("example.session-index", {
	version: 1,
	params: {},
	members: { titles: map(str()), report: method(Report) },
});

/** The index as clients and workers hold it. */
const Sessions = remote("example.sessions", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { all: { state: { titles: map(str()) }, methods: { report: method(Report) } } },
});

/** A session, on its worker: its title, and the method that changes it. */
const SessionTitle = remote("example.session-title", {
	version: 1,
	params: { id: str() },
	hostAddress: ({ id }) => Session({ id }),
	variants: { owner: { state: { title: str() }, methods: { rename: method(str()) } } },
});

const IndexDoc = defineState("index", {
	schema: obj({ titles: map(str()) }),
	version: 1,
	initial: () => ({ titles: {} }),
});

const TitleDoc = defineState("title", { schema: obj({ title: str() }), version: 1, initial: () => ({ title: "" }) });

const serverFacet = defineFacet<P>((host) => {
	host.serve(SessionIndex, (_, self) => {
		const doc = self.state(IndexDoc);
		return {
			titles: self.derive([doc], ([index]) => index.titles),
			report: async ({ id, title }, ctx) => {
				await doc.change((draft) => {
					draft.titles[id] = title;
				}, ctx);
				return null;
			},
		};
	});
	host.serve(Sessions, (_params, _principal, self) => {
		const index = self.get(SessionIndex, {});
		return { variant: "all", members: { titles: index.titles, report: (report, ctx) => index.report(report, ctx) } };
	});
});

const workerFacet = defineFacet<P>((host) => {
	host.serve(SessionTitle, ({ id }, _principal, self) => {
		const doc = self.state(TitleDoc);
		const sessions = self.get(Sessions, {});
		return {
			variant: "owner",
			members: {
				title: self.derive([doc], ([current]) => current.title),
				// The rule for a method that should feel instant: it awaits its own changes, the push to the server included.
				rename: async (title, ctx) => {
					await doc.change((draft) => {
						draft.title = title;
					}, ctx);
					await sessions.report({ id, title }, ctx);
					return null;
				},
			},
		};
	});
});

/** The client's end of its link: while paused, what arrives waits (so it acknowledges nothing); logs what it gets. */
class SlowLink implements Link {
	paused = false;
	readonly #link: Link;
	readonly #waiting: Uint8Array[] = [];
	#listener: (message: Uint8Array) => void = () => {};

	constructor(link: Link) {
		this.#link = link;
		link.onMessage((message) => {
			if (this.paused) this.#waiting.push(message);
			else this.#deliver(message);
		});
	}

	/** Delivers what waited one message per task, as a socket does: what a message settles runs before the next. */
	async resume(): Promise<void> {
		for (let message = this.#waiting.shift(); message !== undefined; message = this.#waiting.shift()) {
			this.#deliver(message);
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		this.paused = false;
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

	#deliver(message: Uint8Array): void {
		const decoded = binaryCodec.decode(message);
		if (decoded.kind === "state" || decoded.kind === "result") {
			console.log("  client ←", describeMessage(decoded).slice(0, 100));
		}
		this.#listener(message);
	}
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

// 1. A server routing sessions to workers (in memory here), and a terminal client on a link that can stall.
const server = createHost<P>({ address: Server(), principal: { kind: "server" }, onError: console.error });
const workers: Host<P>[] = [];
server.route(
	Session,
	{
		authorize: () => true,
		resolve: async (address) => {
			const [a, b] = memoryLinkPair();
			const principal = { kind: "worker", session: address.params.id } as const;
			const worker = createHost<P>({ address, principal, onError: console.error });
			worker.connect(b, { principal: { kind: "server" }, trusted: true }, context);
			void worker.load([{ name: "@example/worker", facet: workerFacet }], context);
			workers.push(worker);
			return { link: a, principal, trusted: true };
		},
	},
	context,
);
await server.load([{ name: "@example/server", facet: serverFacet }], context);
const [up, down] = memoryLinkPair();
server.accept(up, { principal: { kind: "owner" } }, context);
const slow = new SlowLink(down);
const client = createHost<P>({ onError: console.error });
client.connect(slow, { principal: { kind: "server" } }, context);
await client.load([], context);

// 2. A component's scope: it holds the index and the session, and shows the session's title from the index, with an
// optimistic value while a rename is pending. Each redraw records what it shows.
const drawn: (string | undefined)[] = [];
const scope = new TuiScope(client, () => drawn.push(title()));
const sessions = scope.hold(Sessions, {});
const session = scope.hold(SessionTitle, { id: "S1" });
const titles = scope.watch(sessions.titles);
const [title, show] = scope.optimistic(() => titles()?.S1);
await session.rename("Draft", context);
await settle();
console.log("the index shows:", title());

// 3. The client stalls (it acknowledges nothing). Other sessions report to the index: two `state` messages fill the
// server's window for this client, the third change waits there.
slow.paused = true;
const index = await server.get(SessionIndex, {}, context);
for (const id of ["S2", "S3", "S4"]) await index.report({ id, title: `session ${id}` }, context);

// 4. The user renames S1. The title shows the new name at once; the worker renames, pushes the title to the index
// (whose change waits in the server's window too) and answers. The server sends its waiting state before it forwards
// the answer, past its window.
drawn.length = 0;
const renamed = show("Renamed", session.rename("Renamed", context));
await settle();
console.log("while the call is pending, the title shows:", title());

// 5. The client catches up, one message per task: the states, then the answer. When the call settles the index has the
// new title, so the title never shows "Draft" again (an answer that overtook the waiting state showed it once more).
console.log("the client resumes:");
await slow.resume();
await renamed;
await settle();
console.log("the redraws showed:", drawn);
console.log("the index shows:", title());

scope.dispose();
await client.close(context);
await server.close(context);
for (const worker of workers) await worker.close(context);

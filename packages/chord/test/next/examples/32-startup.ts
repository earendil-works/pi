// Startup (dependency model §6, slice 7a): `load` publishes every facet's declarations in one batch first, then starts
// the host-lifetime objects; requests made here and holds arriving on links wait only for that publication, never for
// the start barrier. Two hosts whose objects need each other's types (an acyclic graph) used to deadlock: the server's
// eager `Bootstrap` needs the worker's `Agent`, the `Agent` needs the server's `Catalog`, and the worker's hold for
// `Catalog` waited for the server's whole `load`, which waited for `Bootstrap`. Now it starts at once, no timeout.
// `load` resolves when each host-lifetime object had its first outcome: live, failed by its own cause, or parked with
// no blocker here still without one (a wait on another host ends the first pass).
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/32-startup.ts
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { hostKind, int, local, remote, str } from "../../../src/next/contracts/index.ts";
import { createHost, defineFacet } from "../../../src/next/host/index.ts";
import { memoryLinkPair } from "../../../src/next/link/index.ts";
import { constant } from "../../../src/next/state/index.ts";

const context = BACKGROUND_CONTEXT;
const started = Date.now();
const at = (): string => `${Date.now() - started} ms`;

type Principal = { readonly kind: "server" } | { readonly kind: "worker"; readonly session: string };

const Server = hostKind("server");
const Session = hostKind("session", { id: str() });

/** On the server, a host-lifetime object (local, empty params): it starts at `load`. */
const Bootstrap = local("example.bootstrap", { version: 1, params: {}, members: { agents: int() } });

/** On the session's worker. */
const Agent = remote("example.agent", {
	version: 1,
	params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }),
	variants: { v: { state: { models: int() } } },
});

/** On the server. */
const Catalog = remote("example.catalog", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { v: { state: { models: int() } } },
});

/** The worker of a session, started by the server's route; it connects first, then loads (W6). */
function startWorker(id: string) {
	const [up, down] = memoryLinkPair();
	const worker = createHost<Principal>({
		address: Session({ id }),
		principal: { kind: "worker", session: id },
		onError: (error) => console.log(`${at()}: worker reported ${error.kind}`),
	});
	worker.connect(down, { principal: { kind: "server" }, trusted: true }, context);
	const agents = defineFacet<Principal>((host) =>
		host.serve(Agent, (_params, _principal, self) => {
			console.log(`${at()}: worker: Agent declares the server's Catalog`);
			return { variant: "v", members: { models: self.get(Catalog, {}).models } };
		}),
	);
	void worker
		.load([{ name: "@example/agents", facet: agents }], context)
		.then(() => console.log(`${at()}: worker loaded`));
	return { worker, link: up };
}

const workers: ReturnType<typeof startWorker>[] = [];
const server = createHost<Principal>({
	address: Server(),
	principal: { kind: "server" },
	// No readyTimeout is needed to break anything: a long one shows nothing waits for it.
	readyTimeout: 600_000,
	onError: (error) => console.log(`${at()}: server reported ${error.kind}`),
});
server.route(
	Session,
	{
		authorize: () => true,
		resolve: async (address) => {
			const started = startWorker(address.params.id);
			workers.push(started);
			return { link: started.link, principal: { kind: "worker", session: address.params.id }, trusted: true };
		},
	},
	context,
);
const core = defineFacet<Principal>((host) => {
	host.serve(Catalog, () => ({ variant: "v", members: { models: constant(3) } }));
	host.serve(Bootstrap, (_, self) => {
		console.log(`${at()}: server: Bootstrap declares the worker's Agent`);
		return { agents: self.get(Agent, { session: "S1" }).models };
	});
});

// 1. The server's load: publication (Catalog served), then Bootstrap starts and parks on the worker's Agent. A wait on
// another host is a first outcome, so `load` resolves without waiting for the worker.
await server.load([{ name: "@example/core", facet: core }], context);
console.log(`${at()}: server loaded; Bootstrap is ${server.hold(Bootstrap, {}, context).state.value.kind}`);

// 2. The worker's hold for Catalog bound on the published server; Agent went live, then Bootstrap.
const bootstrap = await server.get(Bootstrap, {}, context);
console.log(`${at()}: Bootstrap live, it sees ${bootstrap.agents.value} models through the worker`);

bootstrap.release();
await server.close(context);
for (const { worker } of workers) await worker.close(context);

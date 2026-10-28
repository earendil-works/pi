// A relay over real transports: a tab on a loopback WebSocket, a server that relays, and a worker per session forked
// over IPC. The worker gets its start data from its start message and serves it as `SessionInfo` through its core
// facet (§18); the server routes by address and parses no part.
// Run from packages/chord (the same file is the worker when its first argument is `worker`):
//   node --conditions=source --experimental-strip-types test/next/examples/13-relay.ts
import { fork } from "node:child_process";
import type { AddressInfo } from "node:net";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { arr, hostKind, int, local, method, obj, remote, str } from "../../../src/next/contracts/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet } from "../../../src/next/host/index.ts";
import { type IpcPort, ipcLink, webSocketLink } from "../../../src/next/link/index.ts";
import { constant } from "../../../src/next/state/index.ts";

const context = BACKGROUND_CONTEXT;

type P = { kind: "owner" } | { kind: "server" } | { kind: "worker"; session: string };

const Server = hostKind("server");
const Session = hostKind("session", { id: str() });

const Init = obj({ id: str(), title: str(), pid: int() });

/** Start data: a local object with empty params (host lifetime) and constant state, served by the core facet. */
const SessionInfo = local("example.session-info", { version: 1, params: {}, members: { init: Init } });

const Notes = remote("example.notes", {
	version: 1,
	params: { session: str() },
	placement: ({ session }) => Session({ id: session }),
	variants: {
		owner: { state: { info: Init, notes: arr(str()) }, methods: { add: method(obj({ text: str() }), int()) } },
	},
});

/** What the server sends a worker it forked: the app's own message, not the link's. */
type Start = { readonly id: string; readonly title: string };

/** The worker's core facet, made from its start message (base code, loaded under a fixed name). */
const coreWorkerFacet = (init: { id: string; title: string; pid: number }) =>
	defineFacet<P>((host) => {
		host.serve(SessionInfo, () => ({ init: constant(init) }));
	});

const NotesDoc = defineState("notes", { schema: obj({ list: arr(str()) }), version: 1, initial: () => ({ list: [] }) });

/** A plugin's facet on the worker: its notes, and the start data read through a reference. */
const notesFacet = defineFacet<P>((host) => {
	host.serve(Notes, (_, _principal, self) => {
		const doc = self.state(NotesDoc);
		const info = self.get(SessionInfo, {});
		return {
			variant: "owner",
			members: {
				info: info.init,
				notes: self.derive([doc], ([d]) => d.list),
				add: async ({ text }, ctx) => {
					await doc.change((draft) => void draft.list.push(text), ctx);
					return doc.value.list.length;
				},
			},
		};
	});
});

if (process.argv[2] === "worker") {
	// The worker. 1. Its link first: it queues the link's messages until the host listens, and skips the app's own.
	const link = ipcLink(process as unknown as IpcPort);
	const start = await new Promise<Start>((resolve) => {
		const listener = (message: unknown) => {
			if (message instanceof Uint8Array) return;
			process.off("message", listener);
			// The start message the server's `resolve` sent: the app's own shape.
			resolve(message as Start);
		};
		process.on("message", listener);
	});
	// 2. Its host at its address: connect first (W6), then load the core facet with the start data, then the plugins.
	const worker = createHost<P>({
		address: Session({ id: start.id }),
		principal: { kind: "worker", session: start.id },
		onError: console.error,
	});
	worker.connect(link, { principal: { kind: "server" }, trusted: true }, context);
	await worker.load(
		[
			{ name: "@example/core", facet: coreWorkerFacet({ ...start, pid: process.pid }) },
			{ name: "@example/notes", facet: notesFacet },
		],
		context,
	);
	// The server closing the link ends the worker.
	link.onClose(() => process.exit(0));
} else {
	// The server. 3. A route forks a worker per session, sends it its start message and returns the IPC link at once.
	const server = createHost<P>({ address: Server(), principal: { kind: "server" }, onError: console.error });
	server.route(
		Session,
		{
			authorize: (principal) => principal.kind === "owner",
			// No `signal` for the fork: the context is aborted when the host closes, which would kill the worker (and emit
			// `error` on the child); a link Chord closes, at `host.close` or because it arrived after it, ends the worker.
			resolve: async (address) => {
				const child = fork(fileURLToPath(import.meta.url), ["worker"], {
					serialization: "advanced",
					execArgv: ["--conditions=source", "--experimental-strip-types", "--no-warnings"],
				});
				child.send({ id: address.params.id, title: `Session ${address.params.id}` } satisfies Start);
				console.log(`server: forked pid ${child.pid} for ${address.key}`);
				return { link: ipcLink(child), principal: { kind: "worker", session: address.params.id }, trusted: true };
			},
		},
		context,
	);
	await server.load([], context);

	// 4. Tabs reach the server over a WebSocket; its entry point stamps each as the owner here.
	const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await new Promise((resolve) => wss.once("listening", resolve));
	wss.on("connection", (socket) => server.accept(webSocketLink(socket), { principal: { kind: "owner" } }, context));
	const { port } = wss.address() as AddressInfo;

	// 5. A tab: Node's own WebSocket, as a browser's. Its holds go tab → server (relay) → worker.
	const tab = createHost<P>({ onError: console.error });
	tab.connect(webSocketLink(new WebSocket(`ws://127.0.0.1:${port}`)), { principal: { kind: "server" } }, context);
	await tab.load([], context);
	const s1 = await tab.get(Notes, { session: "S1" }, context);
	console.log("tab: S1 info", s1.info.value, "server pid", process.pid);
	await s1.add({ text: "milk" }, context);
	await s1.add({ text: "bread" }, context);
	await new Promise((resolve) => setTimeout(resolve, 10));
	console.log("tab: S1 notes", s1.notes.value);

	// 6. Another session is another worker process.
	const s2 = await tab.get(Notes, { session: "S2" }, context);
	console.log("tab: S2 info", s2.info.value, "notes", s2.notes.value);

	// 7. Closing the server closes its route links; each worker exits when its link closes.
	await tab.close(context);
	await server.close(context);
	await new Promise((resolve) => wss.close(resolve));
	console.log("closed");
}

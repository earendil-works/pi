// The stall test's server (slice 15 §4), run in a forked child so its event loop blocks alone: a host with the
// heartbeat its parent gives (`serve <socket path> <ping> <close>`) serving `Counter` (one value for every id),
// accepting socket links on a Unix socket. Its parent steers it over IPC: `{ kind: "stall", stall: ms, value }` blocks
// the loop for `ms` (as a long commit step does), then sets the value and answers `{ stalled: true }`; `{ kind: "set",
// set }` sets it; `{ kind: "report" }` answers `{ closed }`, the links its own heartbeat closed so far.
import { createServer } from "node:net";
import process from "node:process";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { hostKind, int, local, method, remote, str } from "../../../src/contracts/index.ts";
import { createHost, defineFacet, type HostError } from "../../../src/host/index.ts";
import { socketLink } from "./socket-link.ts";

export const StallServer = hostKind("server");

/** One counter per id; every one shows the server's one value. */
export const Counter = remote("stall.counter", {
	version: 1,
	params: { id: str() },
	hostAddress: () => StallServer(),
	state: { value: int() },
});

/** The server's one value, which every counter shows. */
const Shared = local("stall.shared", { version: 1, params: {}, members: { value: int(), set: method(int()) } });

type Command =
	| { readonly kind: "stall"; readonly stall: number; readonly value: number }
	| { readonly kind: "set"; readonly set: number }
	| { readonly kind: "report" };

if (process.argv[2] === "serve") {
	const [, , , path, ping, close] = process.argv;
	const heartbeat = { ping: Number(ping), close: Number(close) };
	let closed = 0;
	const onError = (error: HostError): void => {
		if (error.kind === "link_closed") closed++;
	};
	const host = createHost({ address: StallServer(), principal: { kind: "server" }, heartbeat, onError });
	const facet = defineFacet((h) => {
		h.serve(Shared, (_params, self) => {
			const value = self.writable(0);
			return {
				value: self.derive([value], ([current]) => current),
				set: async (next) => {
					value.set(next);
					return null;
				},
			};
		});
		h.serve(Counter, (_params, _principal, self) => ({ value: self.get(Shared, {}).value }));
	});
	await host.load([{ name: "stall", facet }], context);
	const shared = await host.get(Shared, {}, context);
	// A local call: it runs in the turns right after the one that makes it.
	const set = (next: number): void => void shared.set(next, context);
	const server = createServer((socket) => host.accept(socketLink(socket), { principal: { kind: "person" } }, context));
	server.listen(path!, () => process.send!({ ready: true }));
	process.on("message", (command: Command) => {
		switch (command.kind) {
			case "set":
				set(command.set);
				return;
			case "report":
				process.send!({ closed });
				return;
			case "stall": {
				const until = Date.now() + command.stall;
				while (Date.now() < until) {
					// The loop is blocked: no timer, no I/O.
				}
				set(command.value);
				process.send!({ stalled: true });
			}
		}
	});
	process.on("disconnect", () => process.exit(0));
}

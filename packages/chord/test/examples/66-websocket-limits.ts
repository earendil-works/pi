// WebSocket frame limits: an oversized frame receives close code 1009 instead of an abrupt disconnect.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/66-websocket-limits.ts

import { WebSocket } from "ws";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { createHost, defineFacet } from "../../src/host/index.ts";
import { Authenticators, createHttp } from "../../src/node/http/index.ts";

type Principal = { kind: "server" } | { kind: "owner" };

const host = createHost<Principal>({ principal: { kind: "server" }, onError: console.error });
const http = createHttp(
	host,
	{ listen: { host: "127.0.0.1", port: 0 }, links: { path: "/chord" }, onError: console.error },
	context,
);

try {
	// 1. The links endpoint requires authentication; this local example admits its client as the owner.
	await host.load(
		[
			{ name: "chord.http", facet: http.facet },
			{
				name: "example.auth",
				facet: defineFacet<Principal>((_host, self) => self.contribute(Authenticators, () => ({ kind: "owner" }))),
			},
		],
		context,
	);
	const { port } = await http.listening(context);

	// 2. The default frame limit is 1 MiB. Listen before sending so the close cannot race the observer.
	const socket = new WebSocket(`ws://127.0.0.1:${port}/chord`);
	const closed = new Promise<number>((resolve, reject) => {
		socket.once("error", reject);
		socket.once("close", resolve);
	});
	socket.once("open", () => socket.send(Buffer.alloc(1024 * 1024 + 1)));
	console.log("Oversized frame close code:", await closed);
} finally {
	await http.close(context);
	await host.close(context);
}

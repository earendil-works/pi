// A plugin socket (slice 10): a plugin contributes a WebSocket endpoint for its own protocol (a terminal, voice). The
// server checks the origin and authenticates first: without a principal the upgrade is refused before plugin code.
// Here the app's authenticator reads a principal from a header (a real app: a signed cookie, `readCookie`).
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/45-plugin-socket/main.ts
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { BACKGROUND_CONTEXT as context } from "../../../../src/context/index.ts";
import { createHost, defineFacet } from "../../../../src/next/host/index.ts";
import * as chordNext from "../../../../src/next/index.ts";
import * as chordHttp from "../../../../src/next-node/http/index.ts";
import { createPlugins } from "../../../../src/next-node/plugins/index.ts";

type Principal = { readonly kind: "server" } | { readonly kind: "user"; readonly name: string };
const server = createHost<Principal>({ principal: { kind: "server" }, onError: console.error });
const http = chordHttp.createHttp(server, { listen: { host: "127.0.0.1", port: 0 }, onError: console.error }, context);
// The app's core facet: who someone is.
const app = defineFacet<Principal>((_host, self) => {
	self.contribute(chordHttp.Authenticators, (request) => {
		const name = request.headers.get("x-user");
		return name === null ? undefined : { kind: "user", name };
	});
});
const modules = { "@earendil-works/chord/next": chordNext, "@earendil-works/chord/next/http": chordHttp };
const plugins = createPlugins(
	{
		roots: [fileURLToPath(new URL("./plugins/", import.meta.url))],
		kinds: { server: { platform: "node", hostPackages: Object.keys(modules) } },
		onError: console.error,
	},
	context,
);
const core = [
	{ name: "chord.http", facet: http.facet },
	{ name: "@example/app", facet: app },
];
await plugins.load(server, { kind: "server", core, modules }, context);
const { port } = await http.listening(context);

// 1. Without a principal: refused (403), the plugin never sees it.
const refused = new WebSocket(`ws://127.0.0.1:${port}/echo/lobby`);
const [, response] = await once(refused, "unexpected-response");
console.log(`1. anonymous: refused ${response.statusCode}`);

// 2. As ada: the plugin's handler greets, then echoes.
const socket = new WebSocket(`ws://127.0.0.1:${port}/echo/lobby`, { headers: { "x-user": "ada" } });
const messages: string[] = [];
socket.on("message", (data) => messages.push(String(data)));
await once(socket, "open");
socket.send("hello");
// The greeting and the echo.
while (messages.length < 2) {
	await new Promise((resolve) => setTimeout(resolve, 10));
}
for (const message of messages) console.log(`2. ${message}`);

// 3. Closing the component closes its sockets (1001, going away); then the host.
const closed = once(socket, "close");
await http.close(context);
await server.close(context);
const [code] = await closed;
console.log(`3. closed with ${code}`);
plugins.close();

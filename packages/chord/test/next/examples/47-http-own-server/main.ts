// Your own server (slice 10): the HTTP component is a Web-standard `fetch` handler, so an app with a server of its own
// mounts it instead of Chord's listener. Here a plain Node server converts every request with `nodeRequest` (the
// listener's checks: a malformed target refused, a second `Host` kept for admission to refuse; and the connection:
// loopback requests count as local only with it), passes it to `http.fetch`, and every upgrade to `http.upgrade`.
// With Hono the same is one line: `app.all("/*", (c) => http.fetch(c.req.raw, connection))`.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/47-http-own-server/main.ts
import { createServer, request } from "node:http";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "../../../../src/context/index.ts";
import { createHost } from "../../../../src/next/host/index.ts";
import * as chordNext from "../../../../src/next/index.ts";
import * as chordHttp from "../../../../src/next-node/http/index.ts";
import { createPlugins } from "../../../../src/next-node/plugins/index.ts";

// 1. The component, without a listener: no `listen` setting.
const server = createHost({ principal: { kind: "server" }, onError: console.error });
const http = chordHttp.createHttp(server, { onError: console.error }, context);
const modules = { "@earendil-works/chord/next": chordNext, "@earendil-works/chord/next/http": chordHttp };
const plugins = createPlugins(
	{
		roots: [fileURLToPath(new URL("./plugins/", import.meta.url))],
		kinds: { server: { platform: "node", hostPackages: Object.keys(modules) } },
		onError: console.error,
	},
	context,
);
await plugins.load(server, { kind: "server", core: [{ name: "chord.http", facet: http.facet }], modules }, context);

// 2. The app's own server: a Web `Request` in, a Web `Response` out (each header line kept: several `Set-Cookie`). A
//    real app adds its own routes around it.
const own = createServer(async (message, res) => {
	const converted = chordHttp.nodeRequest(message, res);
	if (converted.kind === "refused") return void res.writeHead(converted.status).end();
	const response = await http.fetch(converted.request, converted.connection);
	for (const [name, value] of response.headers) res.appendHeader(name, value);
	res.writeHead(response.status).end(Buffer.from(await response.arrayBuffer()));
});
own.on("upgrade", http.upgrade);
await new Promise<void>((resolve) => own.listen(0, "127.0.0.1", resolve));
const address = own.address();
const port = typeof address === "object" && address !== null ? address.port : 0;

// 3. Requests through the app's server get the same routes, checks and headers.
for (const path of ["/notes", "/nowhere"]) {
	const response = await fetch(`http://127.0.0.1:${port}${path}`);
	console.log(`GET ${path} -> ${response.status} ${await response.text()}`);
	console.log(`   x-content-type-options: ${response.headers.get("x-content-type-options")}`);
}

// 4. What a Web `Request` cannot carry is refused at the conversion, as Chord's listener refuses it; the app's server
//    lives on (`TRACE`: 501; a `Host` with userinfo: 403).
for (const [method, host] of [
	["TRACE", `127.0.0.1:${port}`],
	["GET", `attacker@127.0.0.1:${port}`],
] as const) {
	const status = await new Promise<number | undefined>((resolve) => {
		request({ host: "127.0.0.1", port, method, path: "/notes", headers: { host } }, (response) => {
			response.resume();
			resolve(response.statusCode);
		}).end();
	});
	console.log(`${method} /notes (Host: ${host}) -> ${status}`);
}

// 5. The app closes its server and the component (it refuses, then waits for running requests), then the host.
await new Promise((resolve) => own.close(resolve));
await http.close(context);
await server.close(context);
plugins.close();

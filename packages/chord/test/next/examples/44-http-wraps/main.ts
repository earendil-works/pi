// Wraps (slice 10): plugins wrap routes, their own or everyone's, in phases (`observe`, `headers`, `transform`,
// outermost first). Here the notes plugin wraps its own route to add a header, and an audit plugin wraps every route
// to log it; the audit plugin needs no route of its own.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/44-http-wraps/main.ts
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "../../../../src/context/index.ts";
import { createHost } from "../../../../src/next/host/index.ts";
import * as chordNext from "../../../../src/next/index.ts";
import * as chordHttp from "../../../../src/next-node/http/index.ts";
import { createPlugins } from "../../../../src/next-node/plugins/index.ts";

const server = createHost({ principal: { kind: "server" }, onError: console.error });
const http = chordHttp.createHttp(server, { listen: { host: "127.0.0.1", port: 0 }, onError: console.error }, context);
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
const { port } = await http.listening(context);

for (const path of ["/notes", "/missing"]) {
	console.log(`GET ${path}`);
	const response = await fetch(`http://127.0.0.1:${port}${path}`);
	console.log(`   -> ${response.status}, Cache-Control: ${response.headers.get("cache-control")}`);
}
// The 404 has no route, so no wrap ran for it: the audit log shows only /notes, and it keeps the default
// `Cache-Control: no-store` that the notes wrap replaced on its own route.

await http.close(context);
await server.close(context);
plugins.close();

// HTTP (slice 10): a server answers HTTP requests with routes that plugins contribute. The notes plugin (`plugins/`)
// contributes a page, a JSON route and a file download; the server's own code only builds the component, says where
// Chord's own listener listens, and loads the plugins. Every answer carries the security baseline's headers.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/40-http/main.ts
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "../../../../src/context/index.ts";
import { createHost } from "../../../../src/next/host/index.ts";
import * as chordNext from "../../../../src/next/index.ts";
import * as chordHttp from "../../../../src/next-node/http/index.ts";
import { createPlugins } from "../../../../src/next-node/plugins/index.ts";

// 1. A server host and its HTTP component; its settings are arguments: Chord's own listener listens on a free
//    loopback port. Nobody signs in here: no authenticator, every request is anonymous.
const server = createHost({ principal: { kind: "server" }, onError: console.error });
const http = chordHttp.createHttp(server, { listen: { host: "127.0.0.1", port: 0 }, onError: console.error }, context);

// 2. The plugins: the component's facet (its registries and the listener) goes first, then every plugin's server
//    facet. The listener opens once they are published.
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

// 3. Some requests, printed like curl would.
async function curl(path: string, headers: Record<string, string> = {}): Promise<void> {
	const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
	const range = headers.Range === undefined ? "" : ` (Range: ${headers.Range})`;
	console.log(`GET ${path}${range} -> ${response.status} ${response.headers.get("content-type")}`);
	const download = response.headers.get("content-disposition");
	if (download !== null) console.log(`   ${download}`);
	console.log(`   ${JSON.stringify((await response.text()).replace(/nonce="[^"]+"/, 'nonce="…"'))}`);
}

await curl("/");
await curl("/notes/hello");
await curl("/notes/hello/download", { Range: "bytes=0-6" });
await curl("/notes/nope/download");
await curl("/nowhere");
const baseline = await fetch(`http://127.0.0.1:${port}/notes/hello`);
for (const name of ["cache-control", "x-content-type-options", "x-frame-options"]) {
	console.log(`   ${name}: ${baseline.headers.get(name)}`);
}

// 4. Close the component first: it refuses new requests and waits for running ones (the host's close would seal them
//    at once). Then the host.
await http.close(context);
await server.close(context);
plugins.close();

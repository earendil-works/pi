// Allowed hosts (slice 10): the server answers only requests on loopback or through a host a plugin contributes. A
// plugin can allow a host at runtime, a tunnel naming its public host, and take it back; links and sockets through a
// host no longer allowed are terminated at once.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/46-allowed-hosts/main.ts
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "../../../../src/context/index.ts";
import { local, method, str } from "../../../../src/next/contracts/index.ts";
import { createHost } from "../../../../src/next/host/index.ts";
import * as chordNext from "../../../../src/next/index.ts";
import * as chordHttp from "../../../../src/next-node/http/index.ts";
import { createPlugins } from "../../../../src/next-node/plugins/index.ts";

/** The tunnel plugin's object, as the app's code declares it (the same contract). */
const Tunnel = local("example.tunnel", { version: 1, params: {}, members: { open: method(str()), close: method() } });

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

/** GET /hello through `host` (as a tunnel would forward it), printed. */
async function hello(host: string): Promise<void> {
	const answer = await new Promise<string>((resolve) => {
		const req = request({ host: "127.0.0.1", port, path: "/hello", headers: { host } }, (res) => {
			let body = "";
			res.on("data", (chunk) => {
				body += chunk;
			});
			res.on("end", () => resolve(`${res.statusCode} ${body}`));
		});
		req.end();
	});
	console.log(`   GET /hello via ${host} -> ${answer}`);
}

const tunnel = await server.get(Tunnel, {}, context);
console.log("1. no tunnel yet");
await hello(`localhost:${port}`);
await hello("notes.example.net");
console.log("2. the tunnel opens");
await tunnel.open("notes.example.net", context);
await hello("notes.example.net");
console.log("3. the tunnel closes");
await tunnel.close(context);
await hello("notes.example.net");

tunnel.release();
await http.close(context);
await server.close(context);
plugins.close();

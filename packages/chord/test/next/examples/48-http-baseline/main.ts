// The security baseline (slice 10): on by default, the app decides only who someone is. Here the app signs people in
// with a signed cookie (`cookie`, `readCookie`) and the notes plugin contributes a page, routes and a webhook. Requests
// another site's page makes in a browser (Fetch Metadata says so) are never authenticated, a foreign `Origin` is
// refused, but a link to a page still opens it signed in, and a cross-site webhook runs anonymous.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/48-http-baseline/main.ts
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "../../../../src/context/index.ts";
import { createHost, defineFacet } from "../../../../src/next/host/index.ts";
import * as chordNext from "../../../../src/next/index.ts";
import * as chordHttp from "../../../../src/next-node/http/index.ts";
import { createPlugins } from "../../../../src/next-node/plugins/index.ts";

type Principal = { readonly kind: "server" } | { readonly kind: "user"; readonly name: string };
const secret = "a long random secret";
const server = createHost<Principal>({ principal: { kind: "server" }, onError: console.error });
const http = chordHttp.createHttp(server, { listen: { host: "127.0.0.1", port: 0 }, onError: console.error }, context);

// 1. The app's core facet: a sign-in route setting the cookie, and an authenticator reading it back.
const app = defineFacet<Principal>((_host, self) => {
	self.contribute(chordHttp.Http, {
		routes: {
			"POST /sign-in": async (request) => {
				const set = chordHttp.cookie("user", String(await request.json()), { secret, request, sameSite: "Lax" });
				return { kind: "json", value: "signed in", headers: { "Set-Cookie": set } };
			},
		},
	});
	self.contribute(chordHttp.Authenticators, (request) => {
		const name = chordHttp.readCookie(request, "user", secret);
		return name === undefined ? undefined : { kind: "user", name };
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
const base = `http://127.0.0.1:${port}`;

// 2. Ada signs in; her browser keeps the cookie.
const signIn = await fetch(`${base}/sign-in`, { method: "POST", body: '"ada"' });
const cookie = signIn.headers.get("set-cookie")!.split(";")[0]!;
console.log(`1. signed in: ${cookie.slice(0, 12)}…`);

/** A request from Ada's browser: her cookie, and what Fetch Metadata says about who made it (`fetch` sets its own). */
async function browser(label: string, method: string, path: string, headers: Record<string, string> = {}, body = "") {
	const answer = await new Promise<string>((resolve) => {
		const sent = request({ host: "127.0.0.1", port, method, path, headers: { cookie, ...headers } }, (response) => {
			let text = "";
			response.on("data", (chunk) => {
				text += chunk;
			});
			response.on("end", () => resolve(`${response.statusCode} ${text}`));
		});
		sent.end(body);
	});
	console.log(`${label}: ${answer}`);
}

const ours = { "sec-fetch-site": "same-origin", origin: base };
const evil = { "sec-fetch-site": "cross-site", origin: "https://evil.example" };
await browser("2. our page reads the notes", "GET", "/notes", ours);
await browser("3. our page adds a note", "POST", "/notes", ours, '"call mom"');
await browser("4. evil.example posts a note", "POST", "/notes", evil, '"pwned"');
await browser("5. evil.example reads the notes", "GET", "/notes", { "sec-fetch-site": "cross-site" });
const link = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
await browser("6. a link on evil.example to the page", "GET", "/", link);
await browser("7. a build server's webhook", "POST", "/hooks/build", { origin: "https://ci.example" });

await http.close(context);
await server.close(context);
plugins.close();

// MCP OAuth sign-ins (plugins/mcp/sign-in.ts, routes.ts, probe.ts) on a bare server host, against a fake authorization
// server whose MCP server takes only the tokens it issued: a 401 waits for a sign-in, the loopback flow (the owner
// view's `signIn` and the device owner's sign-in route), the callback route of relayed and public owners with the probe
// page and the probe, pasting, refusals (wrong state, guests, nobody), refreshing without a browser, signing out.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { constant, type P2Principal } from "@p2/app/v1";
import { findRoute, Hosts, type RequestAccess, Routes, Server } from "@p2/app/v1/server";
import { EnvService } from "../../plugins/envs/contract.ts";
import { type Instance, Mcp, McpManager } from "../../plugins/mcp/contract.ts";
import { mcpServerFacet } from "../../plugins/mcp/server.ts";
import { Catalog, type Session, SessionLocks } from "../../plugins/sessions/contract.ts";
import { ChildStore } from "../../plugins/subagents/contract.ts";
import { APP, holdIn, TEST, testHost, until } from "./helpers.ts";

const OWNER: P2Principal = { kind: "owner", access: "local" };
const RELAY_OWNER: P2Principal = { kind: "owner", access: "relay" };
const GUEST: P2Principal = {
	kind: "guest",
	id: "g1",
	name: "Guest",
	home: "s1",
	sessions: { s1: "full" },
	revision: 1,
};
/** The session whose worker leases the servers. */
const SESSION: Session = {
	id: "s1",
	env: null,
	cwd: "/",
	title: "s1",
	createdAt: 0,
	updatedAt: 0,
	archivedAt: null,
	pinned: false,
	model: { provider: "faux", modelId: "faux-1" },
	thinkingLevel: "off",
	main: 1,
	branches: [],
};
/** The origin a relayed owner reaches p2 through (never contacted: the test brings the browser's redirect back). */
const BRAIN = "https://brain.example";

const UNUSED = (): never => {
	throw new Error("unused in these tests");
};

/**
 * An authorization server with an MCP server at `/mcp` that answers only requests with a token it issued and has not
 * revoked: discovery, dynamic client registration, PKCE, rotating refresh tokens.
 */
async function authorizationServer(t: { after(fn: () => unknown): void }) {
	const registrations: Record<string, unknown>[] = [];
	const authorizations: URLSearchParams[] = [];
	const grants: string[] = [];
	const challenges = new Map<string, string>();
	const accessTokens = new Set<string>();
	const refreshTokens = new Set<string>();
	let issued = 0;
	const issue = () => {
		issued++;
		accessTokens.add(`access-${issued}`);
		refreshTokens.add(`refresh-${issued}`);
		return { access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, token_type: "Bearer" };
	};
	const json = (response: ServerResponse, status: number, body: unknown) =>
		response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", origin);
		const body = await read(request);
		switch (url.pathname) {
			case "/.well-known/oauth-protected-resource/mcp":
				return json(response, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
			case "/.well-known/oauth-authorization-server":
				return json(response, 200, {
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					registration_endpoint: `${origin}/register`,
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["none"],
				});
			case "/register": {
				const metadata = JSON.parse(body) as Record<string, unknown>;
				registrations.push(metadata);
				return json(response, 201, { ...metadata, client_id: `client-${registrations.length}` });
			}
			case "/authorize": {
				authorizations.push(url.searchParams);
				const code = `code-${authorizations.length}`;
				challenges.set(code, url.searchParams.get("code_challenge") ?? "");
				const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
				redirect.searchParams.set("code", code);
				redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
				return response.writeHead(302, { location: redirect.href }).end();
			}
			case "/token": {
				const params = new URLSearchParams(body);
				grants.push(params.get("grant_type") ?? "");
				if (params.get("grant_type") === "authorization_code") {
					const code = params.get("code") ?? "";
					const verifier = createHash("sha256")
						.update(params.get("code_verifier") ?? "")
						.digest("base64url");
					if (challenges.get(code) !== verifier) return json(response, 400, { error: "invalid_grant" });
					challenges.delete(code);
					return json(response, 200, issue());
				}
				if (!refreshTokens.delete(params.get("refresh_token") ?? ""))
					return json(response, 400, { error: "invalid_grant" });
				return json(response, 200, issue());
			}
			case "/mcp": {
				const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
				if (!accessTokens.has(token))
					return response
						.writeHead(401, {
							"www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
						})
						.end();
				if (request.method !== "POST") return response.writeHead(405).end();
				const message = JSON.parse(body) as { id?: number; method: string };
				if (message.id === undefined) return response.writeHead(202).end();
				const result =
					message.method === "initialize"
						? {
								protocolVersion: "2025-06-18",
								capabilities: { tools: {} },
								serverInfo: { name: "oauth-fixture", version: "1.0.0" },
							}
						: message.method === "tools/list"
							? { tools: [{ name: "whoami", inputSchema: { type: "object" } }] }
							: { content: [{ type: "text", text: token }] };
				return json(response, 200, { jsonrpc: "2.0", id: message.id, result });
			}
			default:
				return response.writeHead(404).end();
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		url: `${origin}/mcp`,
		registrations,
		authorizations,
		/** Grant types of token requests. */
		grants,
		/** Revokes every access token issued so far (refresh tokens stay valid). */
		expireAccessTokens: () => accessTokens.clear(),
	};
}

async function read(request: IncomingMessage): Promise<string> {
	let body = "";
	for await (const chunk of request) body += String(chunk);
	return body;
}

/** Follows `url` like a browser up to the redirect it answers with, and returns where it redirects. */
async function redirectOf(url: string): Promise<URL> {
	const response = await fetch(url, { redirect: "manual" });
	const location = response.headers.get("location");
	assert.ok(location, `${url} answered ${response.status} without a redirect`);
	return new URL(location, url);
}

/**
 * A server host with the MCP plugin and `mcp.json` holding the fake server as `docs`, plus `http`: requests to its
 * routes as `access` (any principal and origin) through a local HTTP server.
 */
async function signInHost(
	t: { after(fn: () => unknown): void },
	oauth: Awaited<ReturnType<typeof authorizationServer>>,
) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "p2-mcp-sign-in-")));
	const dataDir = join(root, "data");
	mkdirSync(dataDir);
	writeFileSync(join(dataDir, "mcp.json"), JSON.stringify({ mcpServers: { docs: { url: oauth.url } } }));
	const fixture = await testHost({
		facets: [mcpServerFacet(150, () => UNUSED)],
		stubs: [
			[
				EnvService,
				{ configs: constant({}), tests: constant({}), failure: constant(null), test: UNUSED, reload: UNUSED },
			],
			[Catalog, { sessions: constant([SESSION]), get: UNUSED, create: UNUSED, activity: UNUSED, update: UNUSED }],
			[ChildStore, { children: constant({}), report: UNUSED }],
			[SessionLocks, { locks: constant({}), set: UNUSED }],
			[
				Server,
				{
					info: constant({ app: APP, dataDir, fake: true, allowedHosts: [], port: 0 }),
					revokeOwners: () => {},
					revokeGuests: () => {},
					revokeFrames: () => {},
				},
			],
			[Hosts, { workers: constant({ s1: { running: true, generation: 1 } }), stop: () => {} }],
		],
	});
	const manager = await fixture.host.get(McpManager, {}, TEST);
	// Session s1's worker leases the servers (shared ones start with their first lease).
	const worker = await holdIn(fixture.client({ kind: "worker", session: "s1", generation: 1 }), Mcp, {}, "worker");
	await worker.setLocations({ locations: [{ env: null, cwd: root }] }, TEST);
	const routes = (await fixture.host.registry(Routes, TEST)).value;
	let access: RequestAccess = {
		principal: OWNER,
		origin: { origin: "http://127.0.0.1:8788", remote: false, port: 8788 },
	};
	const server = createServer((request, response) => {
		const route = findRoute(routes, request.method ?? "GET", new URL(request.url ?? "/", "http://x").pathname);
		if (route === undefined) return void response.writeHead(404).end();
		void fixture.root((ctx) => route(request, response, access, ctx));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	t.after(async () => {
		worker.release();
		await until(manager.leases, (leases) => leases.length === 0);
		await new Promise((resolve) => server.close(resolve));
		await fixture.close();
		rmSync(root, { recursive: true, force: true });
	});
	return {
		dataDir,
		worker,
		owner: () => holdIn(fixture.client(OWNER), Mcp, {}, "owner"),
		/** A request to the routes as `principal` reaching p2 through `origin` (loopback by default). */
		http: (path: string, principal: P2Principal | undefined, origin = "http://127.0.0.1:8788", headers = {}) => {
			access = {
				principal,
				origin: { origin, remote: !origin.startsWith("http://127.0.0.1"), port: 8788 },
			};
			return fetch(base + path, { redirect: "manual", headers });
		},
	};
}

const docs = (instances: readonly Instance[]) => instances.find((instance) => instance.server === "docs");

test("a 401 waits for a sign-in; the owner view's loopback sign-in connects with the tokens", async (t) => {
	const oauth = await authorizationServer(t);
	const host = await signInHost(t, oauth);
	const owner = await host.owner();
	const waiting = docs(await until(owner.instances, (list) => docs(list)?.status === "sign-in"));
	assert.equal(waiting?.auth, "oauth");
	const start = await owner.signIn({ server: "docs" }, TEST);
	assert.equal(start.kind, "redirect");
	// The answer follows its state: the flow is listed when the call resolves.
	const [flow] = owner.signIns.value;
	assert.equal(flow?.via, "loopback");
	assert.equal(flow?.status, "waiting");
	// The browser goes to the authorization server, which redirects to the loopback callback on this machine.
	const back = await redirectOf(start.kind === "redirect" ? start.url : "");
	assert.equal(back.hostname, "127.0.0.1");
	assert.equal(back.pathname, "/callback");
	const page = await fetch(back);
	assert.equal(page.status, 200);
	assert.match(await page.text(), /Signed in to docs/);
	const connected = docs(await until(owner.instances, (list) => docs(list)?.status === "connected"));
	assert.deepEqual(
		connected?.tools.map((tool) => tool.name),
		["whoami"],
	);
	assert.deepEqual(await until(owner.signIns, (list) => list.length === 0), []);
	// The credentials are private to the owner of the data directory.
	assert.equal(statSync(join(host.dataDir, "mcp-auth.json")).mode & 0o777, 0o600);
	assert.match(readFileSync(join(host.dataDir, "mcp-auth.json"), "utf8"), /access-1/);
});

test("the sign-in route: loopback for the device owner; the probe page, the probe and the callback route for a relayed owner", async (t) => {
	const oauth = await authorizationServer(t);
	const host = await signInHost(t, oauth);
	const owner = await host.owner();
	await until(owner.instances, (list) => docs(list)?.status === "sign-in");
	// The device owner goes straight to the authorization server, returning to loopback.
	const local = await host.http("/mcp/sign-in/docs", OWNER);
	assert.equal(local.status, 302);
	assert.match(
		new URL(local.headers.get("location") ?? "").searchParams.get("redirect_uri") ?? "",
		/^http:\/\/127\.0\.0\.1:\d+\/callback$/,
	);
	// A relayed owner first gets the probe page, with a probe only its origin may read.
	const probePage = await host.http("/mcp/sign-in/docs", RELAY_OWNER, BRAIN);
	assert.equal(probePage.status, 200);
	const html = await probePage.text();
	const probe = /fetch\("(http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+)"/.exec(html)?.[1];
	assert.ok(probe, "the page probes the loopback listener");
	assert.match(
		probePage.headers.get("content-security-policy") ?? "",
		new RegExp(`connect-src ${new URL(probe).origin}`),
	);
	const answer = await fetch(probe, { headers: { origin: BRAIN } });
	assert.equal(answer.status, 204);
	assert.equal(answer.headers.get("access-control-allow-origin"), BRAIN);
	assert.equal((await fetch(probe, { headers: { origin: "https://elsewhere.example" } })).status, 404);
	assert.equal((await fetch(`${new URL(probe).origin}/unknown`, { headers: { origin: BRAIN } })).status, 404);
	// On another device the page continues with the callback route on the origin p2 is reached through.
	const routed = await host.http("/mcp/sign-in/docs?via=callback", RELAY_OWNER, BRAIN);
	assert.equal(routed.status, 302);
	const back = await redirectOf(routed.headers.get("location") ?? "");
	assert.equal(back.origin + back.pathname, `${BRAIN}/mcp/callback`);
	const [flow] = await until(owner.signIns, (list) => list[0]?.via === "route");
	assert.equal(flow?.status, "waiting");
	// The registration names p2 and the https callback.
	assert.deepEqual(oauth.registrations.at(-1)?.redirect_uris, [`${BRAIN}/mcp/callback`]);
	// Nobody but the owner completes it: a browser without p2's sign-in is told to paste instead.
	const anonymous = await host.http(`/mcp/callback${back.search}`, undefined, BRAIN);
	assert.equal(anonymous.status, 401);
	assert.match(await anonymous.text(), /paste it in p2/);
	const guest = await host.http(`/mcp/callback${back.search}`, GUEST, BRAIN);
	assert.equal(guest.status, 403);
	// A response of another sign-in is refused and leaves this one waiting.
	const wrong = await host.http(`/mcp/callback?code=code-9&state=other`, RELAY_OWNER, BRAIN);
	assert.equal(wrong.status, 400);
	assert.equal((await until(owner.signIns, (list) => list.length === 1))[0]?.status, "waiting");
	const done = await host.http(`/mcp/callback${back.search}`, RELAY_OWNER, BRAIN);
	assert.equal(done.status, 200);
	assert.match(await done.text(), /Signed in to docs/);
	await until(owner.instances, (list) => docs(list)?.status === "connected");
});

test("pasting the final redirect URL completes a sign-in; a URL of another sign-in is refused", async (t) => {
	const oauth = await authorizationServer(t);
	const host = await signInHost(t, oauth);
	const owner = await host.owner();
	await until(owner.instances, (list) => docs(list)?.status === "sign-in");
	const start = await owner.signIn({ server: "docs" }, TEST);
	const back = await redirectOf(start.kind === "redirect" ? start.url : "");
	const [flow] = await until(owner.signIns, (list) => list.length === 1);
	const other = new URL(back);
	other.searchParams.set("state", "someone-else");
	await assert.rejects(owner.paste({ id: flow!.id, redirectUrl: other.href }, TEST), /different sign-in/);
	assert.equal((await until(owner.signIns, (list) => list.length === 1))[0]?.status, "waiting");
	// The loopback page never loaded (the browser runs elsewhere): its address, pasted, completes the sign-in.
	await owner.paste({ id: flow!.id, redirectUrl: back.href }, TEST);
	// The finished flow is gone when the call resolves; the instance reconnects with the tokens.
	assert.deepEqual(owner.signIns.value, []);
	await until(owner.instances, (list) => docs(list)?.status === "connected");
});

test("refused tokens refresh without a browser; signing out forgets them and waits for a sign-in", async (t) => {
	const oauth = await authorizationServer(t);
	const host = await signInHost(t, oauth);
	const owner = await host.owner();
	const waiting = docs(await until(owner.instances, (list) => docs(list)?.status === "sign-in"));
	const start = await owner.signIn({ server: "docs" }, TEST);
	await fetch(await redirectOf(start.kind === "redirect" ? start.url : ""));
	await until(owner.instances, (list) => docs(list)?.status === "connected");
	oauth.expireAccessTokens();
	await owner.restart({ instance: waiting!.id }, TEST);
	// A restart shows the instance starting when the call resolves (a pending state, then its outcome).
	assert.equal(docs(owner.instances.value)?.status, "starting");
	await until(owner.instances, (list) => docs(list)?.status === "connected");
	assert.deepEqual(oauth.grants, ["authorization_code", "refresh_token"]);
	assert.equal(oauth.authorizations.length, 1);
	// A refresh token a stored sign-in still has signs in at once, without the browser.
	assert.deepEqual(await owner.signIn({ server: "docs" }, TEST), { kind: "authorized" });
	await owner.signOut({ server: "docs" }, TEST);
	assert.notEqual(docs(owner.instances.value)?.status, "connected", "signed out instances reconnect at once");
	await until(owner.instances, (list) => docs(list)?.status === "sign-in");
	assert.doesNotMatch(readFileSync(join(host.dataDir, "mcp-auth.json"), "utf8"), /access-/);
});

test("guests and anonymous visitors get no sign-in route; unknown servers fail", async (t) => {
	const oauth = await authorizationServer(t);
	const host = await signInHost(t, oauth);
	assert.equal((await host.http("/mcp/sign-in/docs", GUEST, BRAIN)).status, 403);
	assert.equal((await host.http("/mcp/sign-in/docs", undefined, BRAIN)).status, 401);
	const unknown = await host.http("/mcp/sign-in/nope", OWNER);
	assert.equal(unknown.status, 502);
	assert.match(await unknown.text(), /No MCP server &quot;nope&quot; signs in with OAuth/);
	const owner = await host.owner();
	await assert.rejects(owner.signIn({ server: "nope" }, TEST), /No MCP server "nope" signs in with OAuth/);
});

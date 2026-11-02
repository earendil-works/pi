// Tests of the HTTP component (slice 10 §2; decisions "The HTTP core is a fetch handler", "The HTTP server is a native
// object", "The HTTP component's security baseline"): `fetch` waiting for the publication, the registries resolved
// once, the listener opening after the publication (none without `listen`, a later change reported), allowed hosts from
// contributions, authenticators, foreign requests and `Origin`, pages and cross-site routes, the default headers on the
// component's own answers, throwing routes and wraps, a reload swapping a route while a request runs, `close` (also
// while authenticating), a mounted handler, and requests' scopes collected.

import { describe, expect, it, vi } from "vitest";
import { withAbortSignal } from "../../../src/context/index.ts";
import { arr, local, method, str } from "../../../src/next/contracts/index.ts";
import { ChordError } from "../../../src/next/data/index.ts";
import { type Ctx, defineFacet } from "../../../src/next/host/index.ts";
import { Authenticators, Http, type HttpContribution, HttpFailure } from "../../../src/next-node/http/index.ts";
import { expectCollected } from "../../next/support.ts";
import { context, contributing, send, served, type TestPrincipal } from "./support.ts";

/** A route answering who it runs as. */
const whoami = contributing({
	routes: { "GET /whoami": async (_request, ctx) => ({ kind: "json", value: ctx.principal ?? null }) },
});

/** A loopback request to `fetch` directly, as a mounted server would make it. */
function loopback(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Request {
	return new Request(`http://127.0.0.1:8788${path}`, {
		...init,
		headers: { host: "127.0.0.1:8788", ...init.headers },
	});
}

/** Resolves with `value` after `ms`. */
function sleepThen<T>(ms: number, value: T): Promise<T> {
	return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/** The connection of `loopback`'s requests. */
const LOOPBACK = { localAddress: "127.0.0.1", localPort: 8788 };

describe("startup", () => {
	it("fetch waits for the publication, then serves; the registries are resolved once", async () => {
		const server = await served({ "@app/who": whoami }, { load: false });
		const registry = vi.spyOn(server.host, "registry");
		const early = server.http.fetch(loopback("/whoami"), LOOPBACK);
		await new Promise((resolve) => setTimeout(resolve, 50));
		await server.load();
		expect(await (await early).text()).toBe("null");
		const calls = registry.mock.calls.length;
		for (let i = 0; i < 3; i++) await server.http.fetch(loopback("/whoami"), LOOPBACK);
		expect(registry.mock.calls.length).toBe(calls);
		await server.close();
	});

	it("answers 503 to a request waiting past the host's readyTimeout", async () => {
		const server = await served({}, { load: false, readyTimeout: 50 });
		expect((await server.http.fetch(loopback("/x"), LOOPBACK)).status).toBe(503);
		await server.load();
		expect((await server.http.fetch(loopback("/x"), LOOPBACK)).status).toBe(404);
		await server.close();
	});

	it("listens once published where its listen setting says; without it no listener", async () => {
		const server = await served({ "@app/who": whoami });
		expect(server.port).toBeGreaterThan(0);
		expect((await send(server.port, "GET", "/whoami")).status).toBe(200);
		await server.close();
		const mounted = await served({ "@app/who": whoami }, { config: { listen: undefined } });
		const listening = mounted.http.listening(context).then(
			() => "listening",
			() => "closed",
		);
		expect((await mounted.http.fetch(loopback("/whoami"), LOOPBACK)).status).toBe(200);
		await mounted.close();
		expect(await listening).toBe("closed");
	});
});

describe("Host and principals", () => {
	it("refuses a Host neither loopback nor contributed (403, with the default headers); admits a contributed one", async () => {
		const server = await served({ "@app/who": whoami, "@app/hosts": contributing({ hosts: ["Notes.Example.com"] }) });
		const refused = await send(server.port, "GET", "/whoami", { headers: { host: "evil.com" } });
		expect([refused.status, refused.headers["x-content-type-options"], refused.headers["cache-control"]]).toEqual([
			403,
			"nosniff",
			"no-store",
		]);
		const through = await send(server.port, "GET", "/whoami", { headers: { host: "notes.example.com" } });
		expect(through.status).toBe(200);
		await server.close();
	});

	it("admits hosts a writable contribution adds and removes at runtime", async () => {
		const Tunnel = local("app.tunnel", { version: 1, params: {}, members: { name: method(arr(str())) } });
		const tunnel = defineFacet<TestPrincipal>((host) =>
			host.serve(Tunnel, (_, self) => {
				const contribution = self.writable<HttpContribution>({ hosts: [] });
				self.contribute(Http, contribution);
				return {
					name: async (hosts) => {
						contribution.set({ hosts });
						return null;
					},
				};
			}),
		);
		const server = await served({ "@app/tunnel": tunnel, "@app/who": whoami });
		const status = async () =>
			(await send(server.port, "GET", "/whoami", { headers: { host: "t.example.com" } })).status;
		expect(await status()).toBe(403);
		const handle = await server.host.get(Tunnel, {}, context);
		await handle.name(["t.example.com"], context);
		expect(await status()).toBe(200);
		await handle.name([], context);
		expect(await status()).toBe(403);
		await server.close();
	});

	it("runs a request without a principal anonymous; asks the authenticators in order, skipping a throwing one", async () => {
		const server = await served({
			"@app/who": whoami,
			"@app/a-broken": defineFacet<TestPrincipal>((_host, self) =>
				self.contribute(Authenticators, () => {
					throw new Error("broken");
				}),
			),
		});
		expect((await send(server.port, "GET", "/whoami")).body.toString()).toBe("null");
		const owner = await send(server.port, "GET", "/whoami", { headers: { "x-principal": "owner" } });
		expect(owner.body.toString()).toBe('{"kind":"owner"}');
		expect(server.errors).toMatchObject([
			{ kind: "hook_failed", hook: "authenticate", plugin: "@app/a-broken" },
			{ kind: "hook_failed", hook: "authenticate", plugin: "@app/a-broken" },
		]);
		await server.close();
	});

	// Opus's security audit H1: a cross-site form posted with the owner's credentials.
	it("never authenticates a foreign request; refuses a foreign Origin and an unsafe browser request without one", async () => {
		let deleted = 0;
		const server = await served({
			"@app/notes": contributing({
				routes: {
					"POST /delete": async (_request, ctx) => {
						if (ctx.principal?.kind === "owner") deleted++;
						return { kind: "json", value: deleted };
					},
					"GET /whoami": async (_request, ctx) => ({ kind: "json", value: ctx.principal ?? null }),
				},
			}),
		});
		const owner = { "x-principal": "owner" };
		const own = `http://127.0.0.1:${server.port}`;
		const crossSite = { ...owner, "sec-fetch-site": "cross-site" };
		expect(
			(await send(server.port, "POST", "/delete", { headers: { ...crossSite, origin: "https://evil.example" } }))
				.status,
		).toBe(403);
		expect(
			(await send(server.port, "POST", "/delete", { headers: { ...owner, "sec-fetch-site": "same-origin" } }))
				.status,
		).toBe(403);
		expect((await send(server.port, "GET", "/whoami", { headers: crossSite })).body.toString()).toBe("null");
		const same = await send(server.port, "POST", "/delete", {
			headers: { ...owner, origin: own, "sec-fetch-site": "same-origin" },
		});
		expect([same.status, same.body.toString()]).toEqual([200, "1"]);
		// Without Fetch Metadata (a script, the TUI): not a browser's request.
		expect((await send(server.port, "POST", "/delete", { headers: owner })).body.toString()).toBe("2");
		await server.close();
	});

	it("authenticates a top-level navigation to a page from another site; a cross-site route runs anonymous", async () => {
		const seen: unknown[] = [];
		const server = await served({
			"@app/pages": contributing({
				routes: {
					"GET /app": {
						page: true,
						handler: async (_request, ctx) => {
							seen.push(ctx.principal ?? null);
							return { kind: "html", body: "app" };
						},
					},
					"POST /hook": {
						crossSite: true,
						handler: async (_request, ctx) => {
							seen.push(ctx.principal ?? null);
							return { kind: "json", value: 1 };
						},
					},
				},
			}),
		});
		const navigate = {
			"x-principal": "owner",
			"sec-fetch-site": "cross-site",
			"sec-fetch-mode": "navigate",
			"sec-fetch-dest": "document",
		};
		await send(server.port, "GET", "/app", { headers: navigate });
		await send(server.port, "GET", "/app", { headers: { ...navigate, "sec-fetch-dest": "iframe" } });
		const hook = await send(server.port, "POST", "/hook", {
			headers: { "x-principal": "owner", origin: "https://github.com", "sec-fetch-site": "cross-site" },
		});
		expect([hook.status, seen]).toEqual([200, [{ kind: "owner" }, null, null]]);
		await server.close();
	});
});

describe("default headers", () => {
	it("sends the baseline on every answer, a CSP with the response's own nonce and the contributed framers and sources", async () => {
		let nonce = "";
		const server = await served({
			"@app/page": contributing({
				routes: {
					"GET /page": async (request) => {
						nonce = request.nonce;
						return { kind: "html", body: `<script nonce="${request.nonce}"></script>` };
					},
				},
				framers: ["https://shell.example.com"],
				csp: { "img-src": ["https://cdn.example.com"] },
			}),
		});
		const page = await send(server.port, "GET", "/page");
		expect(page.headers).toMatchObject({
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			"referrer-policy": "no-referrer",
		});
		expect(page.headers["x-frame-options"]).toBeUndefined();
		expect(page.headers["content-security-policy"]).toBe(
			`default-src 'none'; script-src 'self' 'nonce-${nonce}'; connect-src 'self' ws://127.0.0.1:${server.port}; base-uri 'none'; form-action 'self'; frame-ancestors https://shell.example.com; img-src https://cdn.example.com`,
		);
		// Fable's recheck: a nonce read from one page must not run a script injected into another.
		const first = nonce;
		await send(server.port, "GET", "/page");
		expect(nonce).not.toBe(first);
		const missing = await send(server.port, "GET", "/nope");
		expect([missing.status, missing.headers["x-content-type-options"]]).toEqual([404, "nosniff"]);
		expect(missing.headers["content-security-policy"]).toMatch(/'nonce-[A-Za-z0-9+/]{22}=='/);
		expect(missing.headers["content-security-policy"]).not.toContain(nonce);
		await server.close();
		const plain = await served({});
		expect((await send(plain.port, "GET", "/")).headers["x-frame-options"]).toBe("DENY");
		await plain.close();
	});

	it("lets a relay's verified request through with its framer", async () => {
		const server = await served({
			"@app/who": whoami,
			"@app/relay": contributing({
				relays: [
					{
						name: "radius",
						verify: (request) =>
							request.headers.get("x-relay") === "secret"
								? { origin: "https://me.relay.example", framer: "https://relay.example" }
								: undefined,
					},
				],
			}),
		});
		const forwarded = { "x-forwarded-for": "203.0.113.9" };
		expect((await send(server.port, "GET", "/whoami", { headers: forwarded })).status).toBe(403);
		const relayed = await send(server.port, "GET", "/whoami", { headers: { ...forwarded, "x-relay": "secret" } });
		expect(relayed.status).toBe(200);
		expect(relayed.headers["content-security-policy"]).toContain("frame-ancestors https://relay.example");
		await server.close();
	});
});

describe("routes and wraps failing", () => {
	it("answers a throwing route 500 without its message, a throwing wrap 500 naming its plugin, an HttpFailure its status", async () => {
		const server = await served({
			"@app/a": contributing({
				routes: {
					"GET /throws": async () => {
						throw new Error("secret");
					},
					"GET /failure": async () => {
						throw new HttpFailure(422, "no");
					},
				},
			}),
			"@app/b": contributing({
				routes: { "GET /wrapped": async () => ({ kind: "json", value: 1 }) },
				wraps: [
					{
						name: "broken",
						phase: "headers",
						wrap: async () => {
							throw new Error("wrap");
						},
					},
				],
			}),
		});
		const thrown = await send(server.port, "GET", "/throws");
		expect([thrown.status, thrown.body.toString()]).toEqual([500, "Internal Server Error"]);
		expect((await send(server.port, "GET", "/failure")).status).toBe(422);
		expect((await send(server.port, "GET", "/wrapped")).status).toBe(500);
		expect(server.errors).toMatchObject([
			{ kind: "route_failed", pattern: "GET /throws", plugin: "@app/a", error: { message: "secret" } },
			{ kind: "wrap_failed", name: "broken", plugin: "@app/b", error: { message: "wrap" } },
		]);
		await server.close();
	});

	it("runs wraps outermost first around the route, in its request's scope", async () => {
		const order: string[] = [];
		const server = await served({
			"@app/a": contributing({
				routes: {
					"GET /r": async (_request, ctx) => {
						order.push(`route as ${ctx.principal?.kind ?? "anonymous"}`);
						return { kind: "json", value: 1 };
					},
				},
				wraps: [
					{
						name: "inner",
						phase: "transform",
						wrap: async (request, next) => {
							order.push("transform");
							return next(request);
						},
					},
					{
						name: "outer",
						phase: "observe",
						wrap: async (request, next) => {
							order.push("observe");
							const response = await next(request);
							return { ...response, headers: { "X-Observed": "1" } };
						},
					},
				],
			}),
		});
		const answer = await send(server.port, "GET", "/r", { headers: { "x-principal": "owner" } });
		expect([order, answer.headers["x-observed"]]).toEqual([["observe", "transform", "route as owner"], "1"]);
		await server.close();
	});
});

describe("reloads and close", () => {
	it("a reload swapping a route leaves a running request on the old router; the next uses the new one", async () => {
		const gate = Promise.withResolvers<void>();
		const old = contributing({
			routes: {
				"GET /v": async () => {
					await gate.promise;
					return { kind: "html", body: "old" };
				},
			},
		});
		const server = await served({ "@app/v": old });
		const running = send(server.port, "GET", "/v");
		await new Promise((resolve) => setTimeout(resolve, 50));
		const next = contributing({ routes: { "GET /v": async () => ({ kind: "html", body: "new" }) } });
		await server.host.reload(server.facets({ "@app/v": next }), context);
		expect((await send(server.port, "GET", "/v")).body.toString()).toBe("new");
		gate.resolve();
		expect((await running).body.toString()).toBe("old");
		await server.close();
	});

	it("close refuses new requests (503), waits for running ones up to closeTimeout, then seals them (503)", async () => {
		let sealed: AbortSignal | undefined;
		const server = await served(
			{
				"@app/slow": contributing({
					routes: {
						"GET /quick": async () => {
							await new Promise((resolve) => setTimeout(resolve, 30));
							return { kind: "html", body: "done" };
						},
						"GET /stuck": async (_request, ctx: Ctx) => {
							sealed = ctx.abortSignal;
							return new Promise(() => {});
						},
					},
				}),
			},
			{ config: { listen: { host: "127.0.0.1", port: 0 }, closeTimeout: 100 } },
		);
		const quick = send(server.port, "GET", "/quick");
		const stuck = send(server.port, "GET", "/stuck");
		await new Promise((resolve) => setTimeout(resolve, 10));
		const closing = server.http.close(context);
		expect((await server.http.fetch(loopback("/quick"), LOOPBACK)).status).toBe(503);
		expect((await quick).body.toString()).toBe("done");
		await closing;
		expect(sealed?.aborted).toBe(true);
		await server.host.close(context);
		expect((await stuck).status).toBe(503);
		await expect(send(server.port, "GET", "/quick")).rejects.toThrow();
	});

	// Astra's build review: a request authenticating when close began ran its route afterwards.
	it("never runs a route for a request still authenticating when close sealed it", async () => {
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		let calls = 0;
		const server = await served(
			{
				"@app/r": contributing({
					routes: {
						"GET /": async () => {
							calls++;
							return { kind: "json", value: 1 };
						},
					},
				}),
			},
			{
				config: { listen: { host: "127.0.0.1", port: 0 }, closeTimeout: 20 },
				authenticate: async () => {
					entered.resolve();
					await gate.promise;
					return { kind: "owner" };
				},
			},
		);
		const answer = server.http.fetch(loopback("/"), LOOPBACK);
		await entered.promise;
		await server.http.close(context);
		gate.resolve();
		expect([(await answer).status, calls]).toEqual([503, 0]);
		await server.close();
	});
});

describe("mounting", () => {
	it("without a connection a request is never local", async () => {
		const server = await served({ "@app/who": whoami }, { config: { listen: undefined } });
		expect((await server.http.fetch(loopback("/whoami"))).status).toBe(403);
		await server.close();
	});
});

describe("cancellation", () => {
	// Sol's second recheck C: after cancellation the chain still started the next authenticator.
	it("starts no further authenticator once close sealed the request", async () => {
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		let later = 0;
		const server = await served(
			{
				"@app/r": contributing({ routes: { "GET /": async () => ({ kind: "html", body: "ok" }) } }),
				"@app/z-later": defineFacet<TestPrincipal>((_host, self) =>
					self.contribute(Authenticators, () => {
						later++;
						return { kind: "owner" };
					}),
				),
			},
			{
				config: { listen: undefined, closeTimeout: 10 },
				authenticate: async () => {
					entered.resolve();
					await gate.promise;
					return undefined;
				},
			},
		);
		const answer = server.http.fetch(loopback("/"), LOOPBACK);
		await entered.promise;
		await server.http.close(context);
		expect((await answer).status).toBe(503);
		gate.resolve();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(later).toBe(0);
		await server.close();
	});

	it("asks no authenticator for a request aborted before it arrived", async () => {
		let calls = 0;
		const server = await served(
			{ "@app/r": contributing({ routes: { "GET /": async () => ({ kind: "html", body: "ok" }) } }) },
			{
				config: { listen: undefined },
				authenticate: () => {
					calls++;
					return undefined;
				},
			},
		);
		await server.http.fetch(loopback("/", { signal: AbortSignal.abort() }), LOOPBACK);
		expect(calls).toBe(0);
		await server.close();
	});

	// Sol's third recheck: a request aborted while its route returned the `bytes` description got a stream born sealed,
	// which never errored; the request never finished.
	it.each(["inside the route", "after the route returned"] as const)(
		"ends a request whose bytes Response was born sealed (aborted %s)",
		async (when) => {
			const abort = new AbortController();
			const entered = Promise.withResolvers<void>();
			let reads = 0;
			let bornSealed: boolean | undefined;
			const server = await served(
				{
					"@app/b": contributing({
						routes: {
							"GET /": async (_request, ctx) => {
								entered.resolve();
								if (when === "inside the route") abort.abort(new Error("client gone"));
								bornSealed = ctx.abortSignal?.aborted;
								return {
									kind: "bytes",
									mime: "application/octet-stream",
									read: async () => {
										reads++;
										return new Uint8Array([1]);
									},
								};
							},
						},
					}),
				},
				{ config: { listen: undefined, closeTimeout: 1_000 } },
			);
			const answer = server.http.fetch(loopback("/", { signal: abort.signal }), LOOPBACK);
			await entered.promise;
			if (when === "after the route returned") abort.abort(new Error("client gone"));
			await answer;
			await new Promise((resolve) => setImmediate(resolve));
			const started = Date.now();
			await server.http.close(context);
			expect([Date.now() - started < 500, reads, bornSealed]).toEqual([true, 0, when === "inside the route"]);
			await server.close();
		},
	);

	// Sol's second recheck B: an aborted `Response` nobody touched again kept its request: close waited its bound.
	it("ends a request whose bytes Response was aborted and dropped without another read", async () => {
		const server = await served(
			{
				"@app/b": contributing({
					routes: {
						"GET /": async () => ({
							kind: "bytes",
							mime: "application/octet-stream",
							read: async () => new Uint8Array([1]),
						}),
					},
				}),
			},
			{ config: { listen: undefined, closeTimeout: 1_000 } },
		);
		const abort = new AbortController();
		await server.http.fetch(loopback("/", { signal: abort.signal }), LOOPBACK);
		abort.abort(new Error("client gone"));
		await new Promise((resolve) => setImmediate(resolve));
		const started = Date.now();
		await server.http.close(context);
		expect(Date.now() - started).toBeLessThan(500);
		await server.close();
	});

	// Astra's recheck R4, Sol's N1: a close before the first resolution started a stopped watch; its throw ended the process.
	it("a close before the publication leaves nothing running: the waiting request answers 503", async () => {
		const server = await served({}, { load: false, config: { listen: undefined } });
		const waiting = server.http.fetch(loopback("/x"), LOOPBACK);
		await server.http.close(withAbortSignal(AbortSignal.abort(), context));
		await server.load();
		expect((await waiting).status).toBe(503);
		await new Promise((resolve) => setTimeout(resolve, 50));
		await server.close();
	});

	it("a close while the first request resolves the registries starts no follow", async () => {
		const server = await served({ "@app/who": whoami }, { config: { listen: undefined, closeTimeout: 10 } });
		const pending = server.http.fetch(loopback("/whoami"), LOOPBACK);
		await server.http.close(withAbortSignal(AbortSignal.timeout(20), context));
		expect([200, 503]).toContain((await pending).status);
		await new Promise((resolve) => setTimeout(resolve, 50));
		await server.close();
	});

	// Sol's recheck N9.
	it("a close whose context is aborted already does not wait", async () => {
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const server = await served(
			{
				"@app/wait": contributing({
					routes: {
						"GET /wait": async () => {
							entered.resolve();
							await gate.promise;
							return { kind: "html", body: "done" };
						},
					},
				}),
			},
			{ config: { listen: undefined, closeTimeout: 1000 } },
		);
		const answer = server.http.fetch(loopback("/wait"), LOOPBACK);
		await entered.promise;
		const started = Date.now();
		await server.http.close(withAbortSignal(AbortSignal.abort(), context));
		expect(Date.now() - started).toBeLessThan(500);
		gate.resolve();
		await answer;
		await server.close();
	});

	// Sol's recheck N5: an authenticator ignoring its signal kept fetch pending after close returned.
	it("close settles a request whose authenticator ignores its signal (503)", async () => {
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const server = await served(
			{ "@app/r": contributing({ routes: { "GET /": async () => ({ kind: "html", body: "ok" }) } }) },
			{
				config: { listen: undefined, closeTimeout: 10 },
				authenticate: async () => {
					entered.resolve();
					await gate.promise;
					return { kind: "owner" };
				},
			},
		);
		const answer = server.http.fetch(loopback("/"), LOOPBACK);
		await entered.promise;
		await server.http.close(context);
		const settled = await Promise.race([answer.then((response) => response.status), sleepThen(30, "pending")]);
		expect(settled).toBe(503);
		gate.resolve();
		await server.close();
	});

	// Astra's recheck R2, Sol's N3: a held `Response` went on calling `read` after its scope was sealed.
	it.each(["the request aborted", "the component closed"] as const)("reads no bytes after %s", async (kind) => {
		let reads = 0;
		let readAfterSeal = false;
		const abort = new AbortController();
		const server = await served(
			{
				"@app/bytes": contributing({
					routes: {
						"GET /stream": async () => ({
							kind: "bytes",
							mime: "application/octet-stream",
							read: async (_offset, _length, ctx) => {
								reads++;
								readAfterSeal ||= ctx.abortSignal?.aborted ?? false;
								return new Uint8Array([reads]);
							},
						}),
					},
				}),
			},
			{ config: { listen: undefined, closeTimeout: 10 } },
		);
		const response = await server.http.fetch(loopback("/stream", { signal: abort.signal }), LOOPBACK);
		const reader = response.body!.getReader();
		await reader.read();
		if (kind === "the request aborted") abort.abort(new Error("client gone"));
		else await server.http.close(context);
		await new Promise((resolve) => setImmediate(resolve));
		await expect(reader.read()).rejects.toThrow();
		expect({ reads, readAfterSeal }).toEqual({ reads: 1, readAfterSeal: false });
		await server.close();
	});

	// Sol's recheck N4.
	it("a body that errors after valid JSON fails the request (400); the route's side effect never runs", async () => {
		let writes = 0;
		const server = await served(
			{
				"@app/body": contributing({
					routes: {
						"POST /body": async (request) => {
							const value = await request.json();
							writes++;
							return { kind: "json", value };
						},
					},
				}),
			},
			{ config: { listen: undefined } },
		);
		let pulls = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (pulls++ === 0) controller.enqueue(new TextEncoder().encode("{}"));
				else controller.error(new Error("incoming body checksum failed"));
			},
		});
		const init = { method: "POST", body, duplex: "half" as const };
		const response = await server.http.fetch(loopback("/body", init), LOOPBACK);
		expect([response.status, writes]).toEqual([400, 0]);
		await server.close();
	});
});

describe("answers", () => {
	// Sol's recheck N8: `Response` threw on a body for these statuses.
	it.each([204, 205, 304])("answers %s without a body", async (status) => {
		const server = await served(
			{ "@app/s": contributing({ routes: { "GET /": async () => ({ kind: "json", value: null, status }) } }) },
			{ config: { listen: undefined } },
		);
		const response = await server.http.fetch(loopback("/"), LOOPBACK);
		expect([response.status, response.body, response.headers.has("content-length")]).toEqual([status, null, false]);
		await server.close();
	});

	// Fable's recheck N3: the kernel's `forbidden` reached the client as a reported 500.
	it("answers a forbidden escaping a route 403, unreported", async () => {
		const server = await served(
			{
				"@app/r": contributing({
					routes: {
						"GET /": async () => {
							throw new ChordError({ code: "forbidden", message: "no" });
						},
					},
				}),
			},
			{ config: { listen: undefined } },
		);
		expect((await server.http.fetch(loopback("/"), LOOPBACK)).status).toBe(403);
		expect(server.errors).toEqual([]);
		await server.close();
	});

	// Opus's recheck R2: one value per header name allowed one cookie per response.
	it("sends several Set-Cookie headers", async () => {
		const server = await served({
			"@app/r": contributing({
				routes: { "GET /": async () => ({ kind: "json", value: 1, headers: { "Set-Cookie": ["a=1", "b=2"] } }) },
			}),
		});
		expect((await send(server.port, "GET", "/")).headers["set-cookie"]).toEqual(["a=1", "b=2"]);
		const fetched = await server.http.fetch(
			new Request(`http://127.0.0.1:${server.port}/`, { headers: { host: `127.0.0.1:${server.port}` } }),
			{ localAddress: "127.0.0.1", localPort: server.port },
		);
		expect(fetched.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
		await server.close();
	});
});

describe("GC", () => {
	// Sol's second recheck B, her GC probe: 8 of 8 such requests kept their scopes.
	it("collects the scopes of aborted bytes Responses dropped without another read", async () => {
		const refs: WeakRef<object>[] = [];
		const server = await served(
			{
				"@app/b": contributing({
					routes: {
						"GET /": async (_request, ctx) => {
							refs.push(new WeakRef(ctx));
							return { kind: "bytes", mime: "application/octet-stream", read: async () => new Uint8Array([1]) };
						},
					},
				}),
			},
			{ config: { listen: undefined } },
		);
		for (let i = 0; i < 8; i++) {
			const abort = new AbortController();
			await server.http.fetch(loopback("/", { signal: abort.signal }), LOOPBACK);
			abort.abort(new Error("client gone"));
		}
		await expectCollected(...refs);
		await server.close();
	});

	it("collects the scopes of bytes Responses born sealed (aborted while the route returned)", async () => {
		const refs: WeakRef<object>[] = [];
		const aborts: AbortController[] = [];
		const server = await served(
			{
				"@app/b": contributing({
					routes: {
						"GET /": async (_request, ctx) => {
							refs.push(new WeakRef(ctx));
							aborts.at(-1)?.abort(new Error("client gone"));
							return { kind: "bytes", mime: "application/octet-stream", read: async () => new Uint8Array([1]) };
						},
					},
				}),
			},
			{ config: { listen: undefined } },
		);
		// In a function of its own: the test's frame keeps no last request.
		const fetchAborted = async (): Promise<void> => {
			const abort = new AbortController();
			aborts.push(abort);
			await server.http.fetch(loopback("/", { signal: abort.signal }), LOOPBACK);
		};
		for (let i = 0; i < 8; i++) await fetchAborted();
		aborts.length = 0;
		await expectCollected(...refs);
		await server.close();
	});

	it("collects requests' scopes and requests once answered", async () => {
		const refs: WeakRef<object>[] = [];
		const server = await served({
			"@app/a": contributing({
				routes: {
					"GET /r": async (request, ctx) => {
						refs.push(new WeakRef(ctx), new WeakRef(request));
						return { kind: "json", value: 1 };
					},
				},
			}),
		});
		for (let i = 0; i < 5; i++) await send(server.port, "GET", "/r");
		await expectCollected(...refs);
		await server.close();
	});
});

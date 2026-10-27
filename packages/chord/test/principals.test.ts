import assert from "node:assert/strict";
import { Type } from "typebox";
import { describe, it } from "vitest";
import {
	type Ctx,
	createHost,
	defineFacet,
	type FacetApi,
	type Host,
	hostNamed,
	local,
	memoryLinkPair,
	method,
	remote,
} from "../src/index.ts";

/** An app's principals: what TypeScript narrows on. */
type Principal =
	| { readonly kind: "owner" }
	| { readonly kind: "guest"; readonly id: string }
	| { readonly kind: "server" }
	| { readonly kind: "host" };

const principalKey = (principal: Principal): string =>
	principal.kind === "guest" ? `guest:${principal.id}` : principal.kind;

const Who = local("t.who", {
	version: 1,
	input: Type.Object({}),
	members: { who: method(undefined, Type.String()) },
});

describe("principals", () => {
	it("factories, methods and contexts see the app's principal type", async () => {
		const host = createHost<Principal>({ self: { kind: "host" }, principalKey });
		const facet = defineFacet<Principal>((api) => {
			const plain: FacetApi = api;
			void plain;
			api.serve(Who, (_input, principal, self) => {
				// Narrowing on `kind` needs no cast.
				const created = principal.kind === "guest" ? `guest ${principal.id}` : principal.kind;
				self.task(async (ctx) => {
					const kind: Principal["kind"] = ctx.principal.kind;
					void kind;
				});
				return { who: (ctx) => `${created}, called by ${ctx.principal.kind}` };
			});
		});
		await host.install({ name: "who", ...facet });
		const guest = host.hold(Who, {}, { principal: { kind: "guest", id: "g1" } });
		assert.equal(
			await host.root((ctx) => guest.who(ctx), { principal: { kind: "guest", id: "g1" } }),
			"guest g1, called by host",
		);
		// A typed host, facet API and context are usable where Chord's untyped ones are expected.
		const untyped: Host = host;
		void untyped;
		await host.root(async (ctx) => {
			const plain: Ctx = ctx;
			void plain;
		});
		// @ts-expect-error: not a principal of this app
		host.hold(Who, {}, { principal: { kind: "stranger" } });
		// @ts-expect-error: a pattern names fields of the app's principals
		void host.invalidatePrincipal({ kind: "guest", name: "g1" }).catch(() => {});
		await host.close();
	});

	it("the host's own principal is recognized by key: an equal object reaches the same objects", async () => {
		const host = createHost<Principal>({ self: { kind: "host" }, principalKey });
		let created = 0;
		host.serve(Who, () => {
			created++;
			return { who: () => "one" };
		});
		const own = host.hold(Who, {});
		const equal = host.hold(Who, {}, { principal: { kind: "host" } });
		await Promise.all([own.ready, equal.ready]);
		assert.equal(created, 1);
		// Never disposed as a matching principal: it is the host's own.
		await host.invalidatePrincipal({ kind: "host" });
		assert.equal(own.status, "live");
		await host.close();
	});

	it("a child's parent acts as the principal the child gave `connect`; relayed callers keep theirs", async () => {
		const Echo = remote("t.echo", {
			version: 1,
			input: Type.Object({}),
			host: hostNamed("worker"),
			variants: { main: { methods: { who: method(undefined, Type.String()) } } },
		});
		const server = createHost<Principal>({ name: "server", self: { kind: "host" }, principalKey });
		const [down, up] = memoryLinkPair();
		server.accept(down, { kind: "host", name: "worker", principal: { kind: "host" } });
		const worker = createHost<Principal>({
			name: "worker",
			self: { kind: "host" },
			principalKey,
			upstream: { link: up, principal: { kind: "server" } },
		});
		worker.serve(Echo, (_input, principal) => ({ variant: "main", who: () => principalKey(principal) }));
		const [browserDown, browserUp] = memoryLinkPair();
		server.accept(browserDown, { principal: { kind: "guest", id: "g1" } });
		const browser = createHost<Principal>({
			name: "browser",
			kind: "client",
			self: { kind: "host" },
			upstream: { link: browserUp, principal: { kind: "server" } },
		});
		assert.equal(await server.hold(Echo, {}).who(), "server");
		server.route("worker", {
			authorize: () => true,
			resolve: async () => down,
			principal: () => ({ kind: "host" }),
		});
		assert.equal(await browser.hold(Echo, {}).who(), "guest:g1");
		await browser.close();
		await worker.close();
		await server.close();
	});

	it("refuses a host, a parent link or a route without its principal", () => {
		// @ts-expect-error: `self` is required
		assert.throws(() => createHost({ name: "x" }), /needs `self`/);
		const host = createHost({ self: "host" });
		const [, up] = memoryLinkPair();
		// @ts-expect-error: `principal` is required
		assert.throws(() => host.connect(up, {}), /connect needs `principal`/);
		assert.throws(
			// @ts-expect-error: `principal` is required
			() => host.route("w:", { authorize: () => true, resolve: async () => up }),
			/needs `principal`/,
		);
	});
});

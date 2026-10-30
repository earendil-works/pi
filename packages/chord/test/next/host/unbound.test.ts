import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { int, local, str } from "../../../src/next/contracts/index.ts";
import { ChordError, type Principal } from "../../../src/next/data/index.ts";
import { createHost, defineFacet } from "../../../src/next/host/index.ts";
import { Binding } from "../../../src/next/host/reference.ts";
import { UnboundIndex, type UnboundRequest } from "../../../src/next/host/unbound.ts";
import { memoryLinkPair } from "../../../src/next/link/index.ts";
import { jsonPart } from "../../../src/next/link/internal.ts";
import { Hold } from "../../../src/next/remote/hold.ts";
import { constant } from "../../../src/next/state/index.ts";
import {
	delivered,
	expectCollected,
	instancesOf,
	RawPeer,
	rejection,
	SERVER_ADDRESS,
	Server,
	type TestPrincipal,
	testCodec,
	transported,
} from "../support.ts";

const bindings = instancesOf(Binding, "release");
const holds = instancesOf(Hold, "release");

const Info = local("app.info", { version: 1, params: {}, members: { title: str() } });
const Missing = local("app.missing", { version: 1, params: { id: int() }, members: { n: int() } });

/** A request recording its wakes and ends. */
function request(principal?: Principal): UnboundRequest & { readonly log: string[] } {
	const log: string[] = [];
	return { principal, log, wake: () => log.push("wake"), end: (error) => log.push(`end ${error.message}`) };
}

describe("the index", () => {
	it("wakes every request at the publication, out of the index first; a deleted one is not woken", () => {
		const index = new UnboundIndex();
		const [a, b, c] = [request(), request(), request()];
		index.add("app.a", a);
		index.add("app.a", b);
		index.add("app.b", c);
		index.delete("app.a", b);
		index.wakeAll();
		expect([a.log, b.log, c.log]).toEqual([["wake"], [], ["wake"]]);
		// Out of it: a second publication wakes nobody.
		index.wakeAll();
		expect(a.log).toEqual(["wake"]);
	});

	it("wakes the requests of the names a reload serves only (carry-over: publications wake per name)", () => {
		const index = new UnboundIndex();
		const [a, b, c] = [request(), request(), request()];
		index.add("app.a", a);
		index.add("app.b", b);
		index.add("app.c", c);
		index.wake(["app.a", "app.c", "app.unknown"]);
		expect([a.log, b.log, c.log]).toEqual([["wake"], [], ["wake"]]);
		// The others stay indexed until their own names are served.
		index.wake(["app.b"]);
		expect(b.log).toEqual(["wake"]);
		// Woken out of the index: a later publication wakes none of them again.
		index.wakeAll();
		expect([a.log, b.log, c.log]).toEqual([["wake"], ["wake"], ["wake"]]);
	});

	it("ends the requests of a revoked principal only, and every request at the host's close", () => {
		const index = new UnboundIndex();
		const guest = request({ kind: "guest" });
		const owner = request({ kind: "owner" });
		const own = request();
		for (const each of [guest, owner, own]) index.add("app.a", each);
		const revoked = new ChordError({ code: "forbidden", reason: "revoked", message: "revoked" });
		index.revoke((principal) => principal.kind === "guest", revoked);
		expect([guest.log, owner.log, own.log]).toEqual([["end revoked"], [], []]);
		index.close(new ChordError({ code: "released", reason: "closed", message: "closed" }));
		expect([owner.log, own.log]).toEqual([["end closed"], ["end closed"]]);
	});
});

describe("references waiting in the index", () => {
	it("before the publication: loading, placed by it; a type not served then waits failed { waiting }", async () => {
		const host = createHost({ onError: () => {} });
		const info = host.hold(Info, {}, context);
		const missing = host.hold(Missing, { id: 1 }, context);
		expect([info.state.value, missing.state.value]).toEqual([{ kind: "loading" }, { kind: "loading" }]);
		await host.load(
			[{ name: "@test/a", facet: defineFacet((h) => h.serve(Info, () => ({ title: constant("t") }))) }],
			context,
		);
		await delivered();
		expect(info.state.value).toEqual({ kind: "live" });
		expect(missing.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "waiting", error: { code: "unavailable", message: "app.missing is not served here" } },
			retryAt: undefined,
		});
		// A retry leaves it waiting: an event wakes it, nothing else.
		missing.retry();
		expect(missing.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		await host.close(context);
		expect(missing.state.value).toMatchObject({ kind: "ended", error: { reason: "closed" } });
	});

	it("leave nothing behind once released, before and after the publication (GC)", async () => {
		const host = createHost({ onError: () => {} });
		host.hold(Missing, { id: 1 }, context).release();
		await host.load([], context);
		host.hold(Missing, { id: 2 }, context).release();
		const got = host.get(Missing, { id: 3 }, context, { readyTimeout: 1 }).catch(() => {});
		await got;
		await expectCollected(...bindings);
		expect(host).toBeDefined();
	});
	it("end at the start of the host's close, not after its slow native closes (fix round 1, Sol 6)", async () => {
		const Core = local("app.core", { version: 1, params: {}, members: { n: int() } });
		const closeGate = Promise.withResolvers<void>();
		const host = createHost({ onError: () => {} });
		const facet = defineFacet((h) =>
			h.serve(Core, (_, self) => {
				self.open(
					async () => 1,
					() => closeGate.promise,
				);
				return { n: constant(1) };
			}),
		);
		await host.load([{ name: "@test/a", facet }], context);
		let outcome: unknown;
		void rejection(host.get(Missing, { id: 1 }, context)).then((error) => {
			outcome = error;
		});
		const held = host.hold(Missing, { id: 2 }, context);
		const closing = host.close(context);
		await delivered();
		expect(outcome).toMatchObject({ code: "released", reason: "closed" });
		expect(held.state.value).toMatchObject({ kind: "ended", error: { reason: "closed" } });
		closeGate.resolve();
		await closing;
	});
});

describe("holds waiting in the index", () => {
	/** A server not loaded yet, a raw consumer peer on a child link, and a hold of `app.missing` it sent. */
	async function early() {
		const host = createHost<TestPrincipal>({ address: Server(), principal: { kind: "server" }, onError: () => {} });
		const [a, b] = memoryLinkPair();
		host.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
		const peer = new RawPeer(b);
		peer.send({
			kind: "hold",
			hold: 0,
			type: "app.missing",
			version: 1,
			fingerprint: "0123456789abcdef",
			params: jsonPart({}),
			address: SERVER_ADDRESS,
		});
		await transported();
		return { host, peer, link: a };
	}

	it("wait for the publication without a word, then are refused failed { waiting } and kept", async () => {
		const { host, peer } = await early();
		expect(peer.kinds()).toEqual(["hello"]);
		await host.load([], context);
		expect(await peer.next("failed")).toMatchObject({ hold: 0, cause: { kind: "waiting" } });
		expect(host.activity.value.references).toBe(1);
		await host.close(context);
	});

	it("leave nothing behind once their link closed, before and after the publication (GC)", async () => {
		const before = await early();
		before.link.close();
		await transported();
		await before.host.load([], context);
		const after = await early();
		await after.host.load([], context);
		await after.peer.next("failed");
		after.link.close();
		await transported();
		expect([before.host.activity.value.references, after.host.activity.value.references]).toEqual([0, 0]);
		await expectCollected(...holds);
		expect([before.host, after.host]).toBeDefined();
	});
});

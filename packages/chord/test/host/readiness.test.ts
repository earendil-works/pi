// Tests of a restart's readiness (decision "Reload restarts every affected object; old work finishes on old code",
// rule 3): the recorded requests bound as the successor's would be, when they count as ready, the bound, the cause a
// reload reports and its changes, presence, and the release once the successor's own requests bound.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { evolve, int, local, remote, str } from "../../src/contracts/index.ts";
import type { FailureCause } from "../../src/data/index.ts";
import { createHost, defineFacet, type FacetHost } from "../../src/host/index.ts";
import type { ChordHost } from "../../src/host/internal.ts";
import { Readiness } from "../../src/host/readiness.ts";
import type { Request } from "../../src/host/staging.ts";
import { defineRegistry } from "../../src/registries/index.ts";
import { constant } from "../../src/state/index.ts";
import { expectCollected, flushed, instancesOf, linked, Server, type TestPrincipal } from "../support.ts";

const Slow = local("app.slow", { version: 1, params: { id: int() }, members: { n: int() } });
/** Every readiness started while this file runs, weakly. */
const started = instancesOf(Readiness, "start");
const Missing = local("app.missing", { version: 1, params: {}, members: { n: int() } });
// As staging records it (a request names the registry whatever its types).
const Tags = defineRegistry<unknown, unknown>("app.tags", { version: 1 });
// With params: an object of no params is a host-lifetime one, opened at the load and never ended for lack of holders.
const slowRequest: Request = { kind: "type", contract: Slow, params: { id: 1 } };

/** A host serving `Slow`, whose native opens once `opened` resolves and logs its close to `closed`. */
async function slowHost(opened: Promise<void>, closed: string[] = []) {
	const host = createHost({ onError: () => {} });
	const facet = defineFacet((h) =>
		h.serve(Slow, (_, self) => {
			self.open(
				async () => {
					await opened;
					return null;
				},
				(_native, reason) => void closed.push(reason.kind),
			);
			return { n: constant(1) };
		}),
	);
	await host.load([{ name: "@test/slow", facet }], context);
	return host as ChordHost;
}

/** A readiness of `requests` on `host`, as the host's own caller; each failure it shows is pushed to `shown`. */
function readinessOf(host: ChordHost, requests: readonly Request[], shown: (string | undefined)[] = []): Readiness {
	const caller = { principal: host.principal, incarnation: host.incarnation };
	const shows = (cause: FailureCause | undefined): void => void shown.push(cause?.error.message);
	return new Readiness(host, caller, requests, shows, context);
}

/** Whether `promise` settled after a few turns. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
	let done = false;
	void promise.then(() => {
		done = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 10));
	return done;
}

describe("Readiness: when the recorded requests are ready", () => {
	it("waits for a request still loading and resolves once it is live", async () => {
		const opened = Promise.withResolvers<void>();
		const host = await slowHost(opened.promise);
		const readiness = readinessOf(host, [slowRequest]);
		const ready = readiness.ready(Date.now() + 10_000);
		readiness.start();
		expect(await settled(ready)).toBe(false);
		opened.resolve();
		await ready;
		expect(readiness.cause).toBeUndefined();
		readiness.release();
		await host.close(context);
	});

	it("waits for nothing before it started: the requests bind only once every fate started", async () => {
		const host = await slowHost(Promise.resolve());
		const readiness = readinessOf(host, [slowRequest]);
		const ready = readiness.ready(Date.now() + 10_000);
		expect(await settled(ready)).toBe(false);
		readiness.start();
		await ready;
		readiness.release();
		await host.close(context);
	});

	it("resolves at its bound when a request never gets ready", async () => {
		const host = await slowHost(new Promise(() => {}));
		const readiness = readinessOf(host, [slowRequest]);
		readiness.start();
		const started = Date.now();
		await readiness.ready(started + 50);
		expect(Date.now() - started).toBeGreaterThanOrEqual(40);
		readiness.release();
		await host.close(context);
	});

	it("counts a request failed on this host as ready; the reload reports it as what the successor waits for", async () => {
		const host = await slowHost(Promise.resolve());
		const readiness = readinessOf(host, [{ kind: "type", contract: Missing, params: {} }]);
		readiness.start();
		await readiness.ready(Date.now() + 10_000);
		expect(readiness.cause).toMatchObject({
			kind: "waiting",
			error: { code: "unavailable", message: "waiting for app.missing: app.missing is not served here" },
		});
		readiness.release();
		await host.close(context);
	});

	it("waits, up to its bound, for a request another host refuses for its version: that host's reload heals it", async () => {
		const Shown = remote("app.shown", {
			version: 1,
			params: {},
			hostAddress: () => Server(),
			variants: { main: { state: { text: str() } } },
		});
		const ShownV2 = evolve(Shown, (e) => e.addState("main", "n", int()));
		const serve = (h: FacetHost<TestPrincipal>, raised: boolean) =>
			raised
				? h.serve(ShownV2, () => ({ variant: "main", members: { text: constant("v2"), n: constant(2) } }))
				: h.serve(Shown, () => ({ variant: "main", members: { text: constant("v1") } }));
		const { server, client } = await linked((h) => serve(h, false));
		const readiness = readinessOf(client as ChordHost, [{ kind: "type", contract: ShownV2, params: {} }]);
		readiness.start();
		const ready = readiness.ready(Date.now() + 10_000);
		expect(await settled(ready)).toBe(false);
		expect(readiness.cause).toBeUndefined();
		await server.reload([{ name: "@test/app", facet: defineFacet<TestPrincipal>((h) => serve(h, true)) }], context);
		await ready;
		readiness.release();
		await client.close(context);
		await server.close(context);
	});

	it("does not wait for registry requests: the old attempt's contributions keep them until its seal", async () => {
		const host = await slowHost(new Promise(() => {}));
		const readiness = readinessOf(host, [{ kind: "registry", registry: Tags }]);
		readiness.start();
		await readiness.ready(Date.now() + 10_000);
		expect(readiness.cause).toBeUndefined();
		readiness.release();
		await host.close(context);
	});
});

describe("Readiness: its failure follows the requests", () => {
	it("shows a request's failure, and none once the request recovered", async () => {
		const Flaky = local("app.flaky", { version: 1, params: { id: int() }, members: { n: int() } });
		let failing = true;
		const host = createHost({ onError: () => {} }) as ChordHost;
		const facet = defineFacet((h) =>
			h.serve(Flaky, (_, self) => {
				self.open(
					async () => {
						if (failing) throw new Error("not yet");
						return null;
					},
					() => {},
				);
				return { n: constant(1) };
			}),
		);
		await host.load([{ name: "@test/flaky", facet }], context);
		const held = host.hold(Flaky, { id: 1 }, context);
		await held.state.watch(context);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(held.state.value.kind).toBe("failed");
		const shown: (string | undefined)[] = [];
		const readiness = readinessOf(host, [{ kind: "type", contract: Flaky, params: { id: 1 } }], shown);
		readiness.start();
		expect(shown).toEqual([expect.stringContaining("not yet")]);
		failing = false;
		held.retry();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(shown.at(-1)).toBeUndefined();
		expect(readiness.cause).toBeUndefined();
		readiness.release();
		held.release();
		await host.close(context);
	});
});

describe("Readiness: presence", () => {
	it("keeps its bindings out of presence lists: they are no consumers of their own", async () => {
		const host = await slowHost(Promise.resolve());
		const listed = host.references(Slow);
		const readiness = readinessOf(host, [slowRequest]);
		readiness.start();
		await readiness.ready(Date.now() + 10_000);
		expect(listed.value).toEqual([]);
		const held = host.hold(Slow, { id: 1 }, context);
		await flushed();
		expect(listed.value).toHaveLength(1);
		readiness.release();
		held.release();
		await host.close(context);
	});
});

describe("Readiness.release: the successor's own requests bound", () => {
	it("lets go of its bindings: an object held only by them ends", async () => {
		const closed: string[] = [];
		const host = await slowHost(Promise.resolve(), closed);
		const readiness = readinessOf(host, [slowRequest]);
		readiness.start();
		await readiness.ready(Date.now() + 10_000);
		expect(closed).toEqual([]);
		readiness.release();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(closed).toEqual(["end"]);
		await host.close(context);
	});

	it("ends a wait still running: ready resolves at once", async () => {
		const host = await slowHost(new Promise(() => {}));
		const readiness = readinessOf(host, [slowRequest]);
		readiness.start();
		const ready = readiness.ready(Date.now() + 10_000);
		readiness.release();
		expect(await settled(ready)).toBe(true);
		await host.close(context);
	});
});

describe("Readiness: memory", () => {
	it("is collected with its bindings once the restart's successor is live", async () => {
		const Dependent = local("app.dependent", { version: 1, params: {}, members: { n: int() } });
		const host = createHost({ onError: () => {} });
		const facet = (n: number) =>
			defineFacet((h) => {
				h.serve(Slow, () => ({ n: constant(1) }));
				h.serve(Dependent, (_, self) => ({ n: self.derive([self.get(Slow, { id: 1 }).n], ([m]) => m + n) }));
			});
		await host.load([{ name: "@test/app", facet: facet(1) }], context);
		const dependent = await host.get(Dependent, {}, context);
		const from = started.length;
		await host.reload([{ name: "@test/app", facet: facet(2) }], context);
		await flushed();
		expect(dependent.n.value).toBe(3);
		expect(started.length).toBeGreaterThan(from);
		await expectCollected(...started.slice(from));
		await host.close(context);
	});
});

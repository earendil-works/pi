// Tests of the server's telemetry ingest (decisions "Telemetry from browser pages", "The server is the one place
// telemetry is stored", "Who a span was for"): a page's batch is checked by its schema (size, every field, no control
// characters), its spans must carry the page's own ids, are capped per page and minute, marked `chord.host: browser`
// and stamped with the link's principal; a worker's batch is written as it is, stamped with its host; nobody else
// gets the worker's `ingest`; the calls record no span of their own.

import { InMemoryTelemetryContext, type StoredSpan } from "@earendil-works/pi-telemetry";
import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { hostKind } from "../../src/contracts/index.ts";
import { isChordError, type Principal } from "../../src/data/index.ts";
import { createHost, type Host } from "../../src/host/index.ts";
import { memoryLinkPair } from "../../src/link/index.ts";
import {
	PAGE_BATCH_SPANS,
	PAGE_SPANS_PER_MINUTE,
	PageTelemetry,
	type TelemetryBatch,
	telemetryIngestFacet,
	WorkerTelemetry,
} from "../../src/telemetry-ingest/index.ts";
import { testCodec, transported } from "../support.ts";

const Server = hostKind("server");

/** A server serving the ingest facet (its batches collected), and a client of `principal` linked to it. */
async function ingesting(
	principal: Principal,
	workers: Readonly<Record<string, string>> = {},
	principalAttributes: (who: Principal) => Readonly<Record<string, string>> = (who) => ({
		"chord.principal": JSON.stringify(who),
		"user.name": "Ada",
	}),
) {
	const batches: TelemetryBatch[] = [];
	const telemetry = new InMemoryTelemetryContext();
	const server = createHost({ address: Server(), principal: { kind: "server" }, telemetry, onError: () => {} });
	const facet = telemetryIngestFacet({
		target: {
			ingest: (batch) => {
				batches.push(batch);
				return batch.spans.length;
			},
		},
		workerHost: (who) => workers[JSON.stringify(who)],
		principalAttributes,
	});
	await server.load([{ name: "chord.telemetry", facet }], context);
	const client = createHost({ onError: () => {} });
	await client.load([], context);
	const [a, b] = memoryLinkPair();
	server.accept(a, { principal, codec: testCodec() }, context);
	client.connect(b, { principal: { kind: "server" }, codec: testCodec() }, context);
	await transported();
	return { server, client, batches, telemetry };
}

/** A page span of `host` numbered `n` (its own ids), with `override`. */
function span(host: Host, n: number, override: Partial<StoredSpan> = {}): StoredSpan {
	const id = `browser:${host.incarnation}:${n}`;
	return {
		id,
		traceId: `browser:${host.incarnation}:1`,
		...(n === 1 ? {} : { parentId: `browser:${host.incarnation}:1` }),
		name: "page.click",
		startedMs: 1000,
		endedMs: 1002,
		attributes: {},
		events: [],
		links: [],
		status: { status: "ok" },
		...override,
	};
}

/** The page's `ingest` of `spans` over `client`'s link. */
async function ingest(client: Host, spans: StoredSpan[]) {
	const page = await client.get(PageTelemetry, {}, context);
	return page.ingest({ spans }, context);
}

describe("a page's batches", () => {
	it("writes its own spans marked `chord.host: browser` with its link's principal, no attribute of its overriding", async () => {
		const { client, batches } = await ingesting({ kind: "owner" });
		const spans = [
			span(client, 1, { attributes: { "chord.host": "server", "chord.principal": "root" } }),
			span(client, 2),
		];
		expect(await ingest(client, spans)).toEqual({ written: 2, dropped: 0 });
		expect(batches[0]!.spans.map(({ attributes }) => attributes)).toEqual([
			{ "chord.host": "browser", "chord.principal": '{"kind":"owner"}', "user.name": "Ada" },
			{ "chord.host": "browser", "chord.principal": '{"kind":"owner"}', "user.name": "Ada" },
		]);
		expect(batches[0]!.metrics).toEqual([]);
	});

	it("calls the hook once per span it stamps, caching nothing itself", async () => {
		const hook = vi.fn(() => ({ "chord.principal": "owner" }));
		const { client } = await ingesting({ kind: "owner" }, {}, hook);
		await ingest(client, [span(client, 1), span(client, 2)]);
		await ingest(client, [span(client, 3)]);
		expect(hook).toHaveBeenCalledTimes(3);
	});

	it("never keeps a principal the page claims: with a hook recording none, its spans carry none", async () => {
		const { client, batches } = await ingesting({ kind: "owner" }, {}, () => ({}));
		const claimed = span(client, 1, { attributes: { "chord.principal": "root", "chord.host": "server", n: 1 } });
		await ingest(client, [claimed]);
		expect(batches[0]!.spans[0]!.attributes).toEqual({ n: 1, "chord.host": "browser" });
	});

	it("drops spans posing as another sender's or the server's: ids, traces and parents not under its own prefix", async () => {
		const { client, batches } = await ingesting({ kind: "owner" });
		const server = "0193b2c4-1111-7000-8000-000000000000:7";
		const spans = [
			span(client, 2),
			span(client, 3, { id: server }),
			span(client, 4, { traceId: server }),
			span(client, 5, { parentId: server }),
			span(client, 6, { id: "browser:someone-else:6" }),
			span(client, 7, { startedMs: 2000, endedMs: 1000 }),
		];
		expect(await ingest(client, spans)).toEqual({ written: 1, dropped: 5 });
		expect(batches[0]!.spans.map(({ id }) => id)).toEqual([spans[0]!.id]);
	});

	it.each([
		[
			"more spans than a batch takes",
			(host: Host) => Array.from({ length: PAGE_BATCH_SPANS + 1 }, (_, n) => span(host, n + 2)),
		],
		["a name with a control character", (host: Host) => [span(host, 1, { name: "\u001b]0;PWNED\u0007" })]],
		["an id with a space", (host: Host) => [span(host, 1, { id: `browser:${host.incarnation}: 1` })]],
		["a 129-character name", (host: Host) => [span(host, 1, { name: "n".repeat(129) })]],
		["a 257-character attribute", (host: Host) => [span(host, 1, { attributes: { text: "t".repeat(257) } })]],
		["an attribute key with a control character", (host: Host) => [span(host, 1, { attributes: { "a\u0000": 1 } })]],
		[
			"33 attributes",
			(host: Host) => [
				span(host, 1, { attributes: Object.fromEntries(Array.from({ length: 33 }, (_, n) => [`k${n}`, n])) }),
			],
		],
		["an array attribute", (host: Host) => [span(host, 1, { attributes: { tags: ["a"] } })]],
		[
			"17 events",
			(host: Host) => [
				span(host, 1, { events: Array.from({ length: 17 }, () => ({ name: "e", timeMs: 0, attributes: {} })) }),
			],
		],
		[
			"a 501-character error message",
			(host: Host) => [
				span(host, 1, { status: { status: "error", error: { name: "x", message: "m".repeat(501) } } }),
			],
		],
	])("refuses a batch with %s as invalid arguments, writing nothing", async (_, spans) => {
		const { client, batches } = await ingesting({ kind: "owner" });
		const error = await ingest(client, spans(client)).catch((thrown: unknown) => thrown);
		expect(isChordError(error, "invalid")).toBe(true);
		expect(batches).toEqual([]);
	});

	it("caps a page's spans per minute: past the budget they are dropped and counted", async () => {
		const { client, batches } = await ingesting({ kind: "owner" });
		let written = 0;
		let dropped = 0;
		for (let batch = 0; batch * PAGE_BATCH_SPANS < PAGE_SPANS_PER_MINUTE + PAGE_BATCH_SPANS; batch++) {
			const spans = Array.from({ length: PAGE_BATCH_SPANS }, (_, n) =>
				span(client, batch * PAGE_BATCH_SPANS + n + 2),
			);
			const receipt = await ingest(client, spans);
			written += receipt.written;
			dropped += receipt.dropped;
		}
		expect([written, dropped]).toEqual([PAGE_SPANS_PER_MINUTE, PAGE_BATCH_SPANS]);
		expect(batches.flatMap(({ spans }) => spans)).toHaveLength(PAGE_SPANS_PER_MINUTE);
	});

	it("records no span for an ingest call", async () => {
		const { client, telemetry } = await ingesting({ kind: "owner" });
		await ingest(client, [span(client, 1)]);
		expect(telemetry.getSpans().map(({ name }) => name)).not.toContain("chord.method");
	});
});

describe("a worker's batches", () => {
	it("writes a worker's spans and metrics as they are, stamped with its host; anyone else has nothing to call", async () => {
		const worker = { kind: "worker", key: "project|p1" };
		const { client, batches } = await ingesting(worker, { [JSON.stringify(worker)]: "project|p1" });
		const held = await client.get(WorkerTelemetry, {}, context);
		if (held.variant !== "worker") throw new Error("expected the worker variant");
		const own = { ...span(client, 1), id: "w:1", traceId: "w:1", attributes: { tags: ["a", "b"] } };
		const metric = {
			intervalMs: 10_000,
			name: "chord.link.bytes",
			kind: "counter",
			attributes: { direction: "sent" },
			count: 2,
			sum: 10,
			min: 4,
			max: 6,
		} as const;
		expect(await held.ingest({ spans: [own], metrics: [metric] }, context)).toEqual({ written: 1, dropped: 0 });
		expect(batches[0]).toEqual({
			spans: [{ ...own, attributes: { tags: ["a", "b"], "chord.host": "project|p1" } }],
			metrics: [metric],
		});
		const { client: page } = await ingesting({ kind: "owner" });
		expect((await page.get(WorkerTelemetry, {}, context)).variant).toBe("other");
	});
});

import {
	InMemoryTelemetryContext,
	NOOP_TELEMETRY_CONTEXT,
	NOOP_TELEMETRY_METRICS,
	type StoredSpan,
	type TelemetryCarrier,
	type TelemetryMetrics,
} from "@earendil-works/pi-telemetry";
import { renderTrace } from "@earendil-works/pi-telemetry/render";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT, type Context, withTelemetry } from "../src/context/index.ts";
import { ChordError } from "../src/data/index.ts";
import { memoryLinkPair } from "../src/link/index.ts";
import { jsonPart, type Message } from "../src/link/internal.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";
import {
	CHORD_TELEMETRY_SCHEMA,
	carrierOf,
	chordMetrics,
	OpenSpan,
	parentOf,
	spanFailed,
	untraced,
} from "../src/telemetry.ts";
import { createSqliteTelemetry } from "../src/telemetry-sqlite/index.ts";
import {
	expectCollected,
	metered,
	PlacedNotes,
	RawPeer,
	relayed,
	testCodec,
	transported,
	wireNames,
} from "./support.ts";

/** A context whose span is a root of `telemetry`, while `fn` runs. */
function traced<T>(telemetry: InMemoryTelemetryContext, fn: (context: Context) => Promise<T>): Promise<T> {
	return telemetry.startSpan({ name: "test" }, (span) => fn(withTelemetry(span, BACKGROUND_CONTEXT)));
}

/** `spans` as a tree of names (children indented), events with `·`, without durations or attributes. */
function tree(spans: readonly StoredSpan[]): string {
	return renderTrace(spans.map((span) => ({ ...span, attributes: {}, links: [], startedMs: span.startedMs })))
		.replaceAll(/ \(\+?[\d.]+ms\)/g, "")
		.replaceAll(/ \w+=\S+/g, "");
}

describe("the schema", () => {
	it("declares every span Chord starts and keeps ids off metrics", () => {
		const spans = Object.keys(CHORD_TELEMETRY_SCHEMA.spans).sort();
		expect(spans).toEqual([
			"chord.activate",
			"chord.call",
			"chord.close",
			"chord.hold",
			"chord.http",
			"chord.job",
			"chord.load",
			"chord.method",
			"chord.open",
			"chord.relay",
			"chord.reload",
			"chord.resolve",
			"chord.revoke",
			"chord.routine",
		]);
		const ids = ["object", "hold", "call", "address", "job.id"];
		for (const [name, metric] of Object.entries(CHORD_TELEMETRY_SCHEMA.metrics)) {
			expect([name, Object.keys(metric.attributes).filter((key) => ids.includes(key))]).toEqual([name, []]);
		}
	});

	it("declares every metric a traced call over a relay records", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const { tab } = await relayed({ telemetry: { tab: telemetry, server: telemetry, worker: telemetry } });
		await traced(telemetry, async (context) => {
			const notes = await tab.get(PlacedNotes, { session: "S1" }, context);
			if (notes.variant !== "editor") throw new Error("expected the editor");
			await notes.add({ text: "a" }, context);
		});
		const recorded = new Set(telemetry.getMetrics().map(({ name }) => name));
		const declared = Object.keys(CHORD_TELEMETRY_SCHEMA.metrics);
		expect([...recorded].filter((name) => !declared.includes(name))).toEqual([]);
		const spans = new Set(telemetry.getSpans().map(({ name }) => name));
		spans.delete("test");
		expect([...spans].filter((name) => !(name in CHORD_TELEMETRY_SCHEMA.spans))).toEqual([]);
	});
});

describe("nothing recorded", () => {
	it("treats the NOOP context as untraced: no carrier, its own root", () => {
		expect(untraced(NOOP_TELEMETRY_CONTEXT)).toBe(true);
		expect(untraced(new InMemoryTelemetryContext())).toBe(false);
		expect(carrierOf(NOOP_TELEMETRY_CONTEXT)).toBeUndefined();
		expect(parentOf({ any: "carrier" }, NOOP_TELEMETRY_CONTEXT)).toBe(NOOP_TELEMETRY_CONTEXT);
	});

	it("records nothing and sends no carrier when no host has an adapter", async () => {
		const { tab, tabLink } = await relayed();
		const sent: unknown[] = [];
		const send = tabLink.send.bind(tabLink);
		tabLink.send = (bytes) => {
			sent.push(bytes);
			send(bytes);
		};
		const notes = await tab.get(PlacedNotes, { session: "S1" }, BACKGROUND_CONTEXT);
		if (notes.variant !== "editor") throw new Error("expected the editor");
		expect(await notes.add({ text: "a" }, BACKGROUND_CONTEXT)).toBe(1);
		expect(sent.length).toBeGreaterThan(0);
	});
});

describe("carriers", () => {
	it("extracts an unknown or absent carrier as the adapter's root, never throwing", async () => {
		const telemetry = new InMemoryTelemetryContext();
		expect(parentOf(undefined, telemetry)).toBe(telemetry);
		expect(parentOf({ foo: "bar" }, telemetry)).toBe(telemetry);
		const carrier = await telemetry.startSpan({ name: "parent" }, (span) => carrierOf(span));
		await parentOf(carrier, telemetry).startSpan({ name: "child" }, () => {});
		const [parent, child] = telemetry.getSpans();
		expect(child!.parentId).toBe(parent!.id);
	});
});

describe("open spans", () => {
	it("ends once, with how its work settled: ok, a cancel (status ok), or an error with its category", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const attributes = { "chord.host": "client", type: "t", member: "m", object: "o", "principal.kind": "none" };
		const ok = new OpenSpan(telemetry, "chord.method", attributes);
		ok.endWhen(Promise.resolve(1), "method_failed", undefined);
		const aborted = new OpenSpan(telemetry, "chord.method", attributes);
		aborted.endWhen(Promise.reject(new ChordError({ code: "aborted", message: "stop" })), "method_failed", undefined);
		const failed = new OpenSpan(telemetry, "chord.method", attributes);
		failed.endWhen(Promise.reject(new Error("x".repeat(600))), "method_failed", undefined);
		await transported();
		expect(ok.ended && aborted.ended && failed.ended).toBe(true);
		ok.end();
		const spans = telemetry.getSpans();
		expect(spans.map(({ attributes, status }) => [attributes.outcome, status.status])).toEqual([
			["ok", "ok"],
			["aborted", "ok"],
			["error", "error"],
		]);
		const status = spans[2]!.status;
		expect(status.status === "error" && status.error).toEqual({ name: "method_failed", message: "x".repeat(500) });
	});

	it("marks a span failed with a fixed category and at most 500 characters", async () => {
		const telemetry = new InMemoryTelemetryContext();
		await telemetry.startSpan({ name: "s" }, (span) => spanFailed(span, "call_failed", "y".repeat(501)));
		expect(telemetry.getSpans()[0]!.status).toEqual({
			status: "error",
			error: { name: "call_failed", message: "y".repeat(500) },
		});
	});
});

describe("metrics", () => {
	it("makes each instrument once per adapter's metrics and none for NOOP", () => {
		const telemetry = new InMemoryTelemetryContext();
		const metrics = chordMetrics(telemetry.metrics);
		expect(chordMetrics(telemetry.metrics)).toBe(metrics);
		expect(metrics.counter("chord.link.encodes")).toBe(metrics.counter("chord.link.encodes"));
		expect(chordMetrics(undefined)).toBe(chordMetrics(NOOP_TELEMETRY_METRICS));
		metrics.counter("chord.link.bytes").add(3, { direction: "sent" });
		expect(telemetry.getMetrics()).toMatchObject([
			{ name: "chord.link.bytes", kind: "counter", unit: "By", value: 3, attributes: { direction: "sent" } },
		]);
	});

	it("keeps no adapter alive (its instruments are cached by its metrics object, weakly)", async () => {
		let metrics: TelemetryMetrics | undefined = new InMemoryTelemetryContext().metrics;
		const ref = new WeakRef(metrics);
		chordMetrics(metrics).counter("chord.query.runs").add(1);
		metrics = undefined;
		await expectCollected(ref);
	});
});

describe("across hosts", () => {
	/** The tab, server and workers of `relayed`, all recording to one SQLite telemetry store. */
	async function store() {
		const db = await openNodeSqliteDatabase(":memory:");
		const telemetry = await createSqliteTelemetry(db);
		const hosts = await relayed({ telemetry: { tab: telemetry, server: telemetry, worker: telemetry } });
		return { telemetry, ...hosts };
	}

	it("follows a call from the tab through the server's relay into the worker's method and its commit", async () => {
		const { telemetry, tab } = await store();
		await telemetry.startSpan({ name: "test" }, async (span) => {
			const context = withTelemetry(span, BACKGROUND_CONTEXT);
			const notes = await tab.get(PlacedNotes, { session: "S1" }, context);
			if (notes.variant !== "editor") throw new Error("expected the editor");
			await notes.add({ text: "a" }, context);
		});
		await transported();
		await telemetry.flush();
		const { traces } = await telemetry.findTraces({ name: "test" });
		expect(traces).toHaveLength(1);
		const spans = traces[0]!.spans;
		expect(new Set(spans.map(({ traceId }) => traceId)).size).toBe(1);
		const call = spans.find(({ name }) => name === "chord.call")!;
		expect(call.attributes).toMatchObject({ type: "app.placed-notes", member: "add", "address.kind": "session" });
		const relay = spans.find(({ name, attributes }) => name === "chord.relay" && attributes.member !== "hold")!;
		expect(relay.parentId).toBe(call.id);
		const method = spans.find(({ name, attributes }) => name === "chord.method" && attributes.member === "add")!;
		expect(method.parentId).toBe(relay.id);
		expect(method.attributes).toMatchObject({ "principal.kind": "owner", outcome: "ok" });
		const local = spans.find(({ name, parentId }) => name === "chord.method" && parentId === method.id)!;
		expect(local.attributes).toMatchObject({ type: "app.note-store", member: "add" });
		expect(local.events.map(({ name, attributes }) => [name, attributes.documents, attributes.ops])).toEqual([
			["chord.commit", 1, 1],
		]);
		expect(tree(spans)).toContain(
			[
				"  chord.call",
				"    chord.relay",
				"      chord.method",
				"        chord.method",
				"          · chord.commit",
			].join("\n"),
		);
		await telemetry.close();
	});

	it("names the host that recorded each span: its address key, `client` without an address", async () => {
		const { telemetry, tab } = await store();
		await telemetry.startSpan({ name: "test" }, async (span) => {
			const context = withTelemetry(span, BACKGROUND_CONTEXT);
			const notes = await tab.get(PlacedNotes, { session: "S1" }, context);
			if (notes.variant !== "editor") throw new Error("expected the editor");
			await notes.add({ text: "a" }, context);
		});
		await transported();
		await telemetry.flush();
		const { traces } = await telemetry.findTraces({ limit: 100 });
		const spans = traces.flatMap((trace) => trace.spans).filter(({ name }) => name !== "test");
		const hosts = new Map<string, Set<unknown>>();
		for (const { name, attributes } of spans)
			hosts.set(name, (hosts.get(name) ?? new Set()).add(attributes["chord.host"]));
		expect(Object.fromEntries([...hosts].map(([name, of]) => [name, [...of].sort()]))).toEqual({
			"chord.activate": ["session|S1"],
			"chord.call": ["client"],
			"chord.hold": ["client"],
			"chord.method": ["session|S1"],
			"chord.relay": ["server"],
			"chord.resolve": ["server"],
		});
		await telemetry.close();
	});

	it("holds through the relay under the tab's span; the worker's start and its activations link to their triggers", async () => {
		const { telemetry, tab } = await store();
		await telemetry.startSpan({ name: "test" }, async (span) => {
			await tab.get(PlacedNotes, { session: "S1" }, withTelemetry(span, BACKGROUND_CONTEXT));
		});
		await transported();
		await telemetry.flush();
		const { traces } = await telemetry.findTraces({ limit: 100 });
		// In the order the store's recorder started them (its span ids count up).
		const all = traces
			.flatMap((trace) => trace.spans)
			.sort((a, b) => Number(a.id.split(":")[1]) - Number(b.id.split(":")[1]));
		const hold = all.find(({ name }) => name === "chord.hold")!;
		expect(hold.attributes).toMatchObject({ type: "app.placed-notes", outcome: "bound" });
		const relay = all.find(({ name, parentId }) => name === "chord.relay" && parentId === hold.id)!;
		expect(relay.attributes).toMatchObject({ member: "hold", "upstream.kind": "session", outcome: "ok" });
		const resolve = all.find(({ name }) => name === "chord.resolve")!;
		expect(resolve.parentId).toBeUndefined();
		expect(resolve.attributes).toMatchObject({ kind: "session", address: "session|S1", outcome: "linked" });
		expect(resolve.links.map(({ spanId }) => spanId)).toEqual([relay.id]);
		const [activation, resumed] = all.filter(
			({ name, attributes }) => name === "chord.activate" && attributes.type === "app.placed-notes",
		);
		expect(activation!.parentId).toBeUndefined();
		// Linked to its trigger, and (waiting for it) to the activation of the store it declared: it parked on it, and
		// its own steps ran in a span linked to the parked one.
		const noteStore = all.find(
			({ name, attributes }) => name === "chord.activate" && attributes.type === "app.note-store",
		)!;
		expect(noteStore.links.map(({ spanId }) => spanId)).toEqual([activation!.id]);
		expect(activation!.links.map(({ spanId }) => spanId)).toEqual([relay.id, noteStore.id]);
		expect(activation!.attributes.outcome).toBe("parked");
		expect(activation!.events.map(({ name, attributes }) => [name, attributes.cause])).toEqual([
			["chord.park", "loading"],
		]);
		expect(resumed!.links.map(({ spanId }) => spanId)).toEqual([activation!.id]);
		expect(resumed!.attributes).toMatchObject({ attempt: 1, outcome: "live" });
		await telemetry.close();
	});

	it("costs a call over a relay exactly its spans and no extra encode", async () => {
		/** One call's spans and encodes, after the reference is live, with hosts recording to `telemetry` or not. */
		async function oneCall(telemetry: InMemoryTelemetryContext | undefined) {
			// The links count their encodes through their context (`metered`); the caller's own span is the hosts' adapter's.
			const { context, counts } = await metered();
			const hosts = telemetry === undefined ? {} : { tab: telemetry, server: telemetry, worker: telemetry };
			const { tab } = await relayed({ context, telemetry: hosts });
			// A commit inside a recorded method counts through the method's span: both adapters are summed.
			const encoded = () =>
				(counts()["chord.link.encodes"] ?? 0) +
				(telemetry?.getMetrics().filter(({ name }) => name === "chord.link.encodes").length ?? 0);
			const call = async (caller: Context) => {
				const notes = await tab.get(PlacedNotes, { session: "S1" }, caller);
				if (notes.variant !== "editor") throw new Error("expected the editor");
				await notes.add({ text: "warm" }, caller);
				await transported();
				const spans = telemetry?.getSpans().length ?? 0;
				const encodes = encoded();
				await notes.add({ text: "a" }, caller);
				await transported();
				const recorded = telemetry?.getSpans().slice(spans) ?? [];
				return {
					spans: recorded.map(({ name, attributes }) => `${name} ${attributes.type}`),
					encodes: encoded() - encodes,
				};
			};
			if (telemetry === undefined) return call(BACKGROUND_CONTEXT);
			return telemetry.startSpan({ name: "test" }, (span) => call(withTelemetry(span, BACKGROUND_CONTEXT)));
		}
		const plain = await oneCall(undefined);
		const recorded = await oneCall(new InMemoryTelemetryContext());
		expect(recorded.spans).toEqual([
			"chord.call app.placed-notes",
			"chord.relay app.placed-notes",
			"chord.method app.placed-notes",
			"chord.method app.note-store",
		]);
		expect(recorded.encodes).toBe(plain.encodes);
	});

	it("starts a new root for a well-formed carrier the server's adapter does not know", async () => {
		/** A client adapter whose carriers no other adapter reads. */
		class Foreign extends InMemoryTelemetryContext {
			override inject(): TelemetryCarrier {
				return { unknown: "carrier" };
			}
		}
		const telemetry = new InMemoryTelemetryContext();
		const { tab } = await relayed({ telemetry: { tab: new Foreign(), server: telemetry, worker: telemetry } });
		const tabTelemetry = new Foreign();
		await tabTelemetry.startSpan({ name: "test" }, async (span) => {
			const context = withTelemetry(span, BACKGROUND_CONTEXT);
			const notes = await tab.get(PlacedNotes, { session: "S1" }, context);
			if (notes.variant !== "editor") throw new Error("expected the editor");
			await notes.add({ text: "a" }, context);
		});
		await transported();
		const spans = telemetry.getSpans();
		const relays = spans.filter(({ name }) => name === "chord.relay");
		expect(relays.map(({ parentId, parentContext }) => [parentId, parentContext])).toEqual([
			[null, null],
			[null, null],
		]);
		// The worker's method continues the relay's new trace.
		const call = relays.find(({ attributes }) => attributes.member !== "hold")!;
		const method = spans.find(({ name, attributes }) => name === "chord.method" && attributes.member === "add")!;
		expect(method.parentId).toBe(call.id);
	});
});

describe("re-holds (slice 9 review L1)", () => {
	it("carries the carrier only on an object's first hold (a root linked to its getter: shared work); a re-hold after a reconnect is a fresh root linked to it", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const { tab, server, tabLink } = await relayed({
			telemetry: { tab: telemetry, server: telemetry, worker: telemetry },
		});
		const notes = await telemetry.startSpan({ name: "page load" }, (span) =>
			tab.get(PlacedNotes, { session: "S1" }, withTelemetry(span, BACKGROUND_CONTEXT)),
		);
		await transported();
		let link: { close(): void } = tabLink;
		for (let round = 0; round < 3; round++) {
			link.close();
			await transported();
			const [a, b] = memoryLinkPair();
			link = a;
			server.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, BACKGROUND_CONTEXT);
			tab.connect(b, { principal: { kind: "server" }, codec: testCodec() }, BACKGROUND_CONTEXT);
			for (let i = 0; i < 5; i++) await transported();
		}
		const spans = telemetry.getSpans();
		const load = spans.find(({ name }) => name === "page load")!;
		const holds = spans.filter(({ name }) => name === "chord.hold");
		expect(holds.map(({ parentId }) => parentId)).toEqual([null, null, null, null]);
		const [first, ...again] = holds;
		expect(first!.links.map(({ context: carrier }) => carrier)).toEqual([load.context]);
		for (const hold of again) {
			expect(hold.links.map(({ context: carrier }) => carrier)).toEqual([first!.context]);
			expect(hold.attributes.outcome).toBe("bound");
		}
		const relays = spans.filter(({ name, attributes }) => name === "chord.relay" && attributes.member === "hold");
		expect(relays.map(({ parentId }) => parentId)).toEqual(holds.map(({ id }) => id));
		notes.release();
	});
});

describe("relayed re-holds (slice 9 review L1)", () => {
	it("re-holds upstream after a drop in a fresh relay root linked to the first relay span", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const { tab, routeLinks } = await relayed({
			telemetry: { tab: telemetry, server: telemetry, worker: telemetry },
		});
		const notes = await telemetry.startSpan({ name: "page load" }, (span) =>
			tab.get(PlacedNotes, { session: "S1" }, withTelemetry(span, BACKGROUND_CONTEXT)),
		);
		await transported();
		routeLinks[0]!.close();
		for (let i = 0; i < 8; i++) await transported();
		expect(routeLinks).toHaveLength(2);
		const hold = telemetry.getSpans().find(({ name }) => name === "chord.hold")!;
		const relays = telemetry
			.getSpans()
			.filter(({ name, attributes }) => name === "chord.relay" && attributes.member === "hold");
		expect(relays.map(({ parentId }) => parentId)).toEqual([hold.id, null]);
		expect(relays[1]!.links.map(({ context: carrier }) => carrier)).toEqual([relays[0]!.context]);
		notes.release();
	});
});

describe("what a peer sends (slice 9 review M1, M2, L8)", () => {
	/** A server routing `Session` (recording to `telemetry`) and a raw guest peer on an untrusted link to it. */
	async function hostile() {
		const telemetry = new InMemoryTelemetryContext();
		const { server, errors } = await relayed({ telemetry: { server: telemetry, worker: telemetry } });
		const [a, b] = memoryLinkPair();
		server.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, BACKGROUND_CONTEXT);
		const peer = new RawPeer(b);
		await peer.next("hello");
		return { telemetry, peer, errors };
	}

	/** A hold of `PlacedNotes` for S1 with `override`. */
	function holdOf(override: Partial<Extract<Message, { kind: "hold" }>>): Message {
		return {
			kind: "hold",
			hold: 0,
			type: PlacedNotes.name,
			version: 1,
			fingerprint: PlacedNotes.fingerprint,
			params: jsonPart({ session: "S1" }),
			address: { kind: "session", params: { id: "S1" } },
			...override,
		};
	}

	it.each([
		["a 500,000-character type", { type: "x".repeat(500_000) }],
		["a 257-character host kind", { address: { kind: "k".repeat(257), params: {} } }],
		["a carrier with a control character", { trace: { "pi-memory-span": "\u001b]0;PWNED\u0007" } }],
		["a carrier key with a space", { trace: { "a b": "c" } }],
		["a carrier of 9 keys", { trace: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, "v"])) }],
		["a carrier value of 257 characters", { trace: { k: "v".repeat(257) } }],
	])("refuses %s as a malformed header: the link closes, nothing is recorded", async (_, override) => {
		const { telemetry, peer, errors } = await hostile();
		peer.send(holdOf(override as Partial<Extract<Message, { kind: "hold" }>>));
		await transported();
		expect(peer.closed).toBe(true);
		expect(errors.server.map(({ kind }) => kind)).toContain("protocol_error");
		expect(telemetry.getSpans().filter(({ name }) => name === "chord.relay")).toEqual([]);
	});

	it("caps an object's label (its client-chosen params key) at 256 characters in its spans", async () => {
		const { telemetry, peer } = await hostile();
		const session = "s".repeat(10_000);
		peer.send(holdOf({ params: jsonPart({ session }), address: { kind: "session", params: { id: session } } }));
		await peer.next("bound");
		peer.send({
			kind: "call",
			call: 0,
			hold: 0,
			method: wireNames(PlacedNotes, "editor").methods.add!,
			args: jsonPart({ text: "a" }),
		});
		await peer.next("result");
		const labelled = telemetry.getSpans().filter(({ attributes }) => typeof attributes.object === "string");
		expect(labelled.map(({ name }) => name)).toEqual(expect.arrayContaining(["chord.activate", "chord.method"]));
		for (const { attributes } of labelled) expect(String(attributes.object).length).toBeLessThanOrEqual(256);
		const resolve = telemetry.getSpans().find(({ name }) => name === "chord.resolve")!;
		expect(String(resolve.attributes.address).length).toBe(256);
	});
});

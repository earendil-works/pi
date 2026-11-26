import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import type { Message as PublicMessage } from "../../src/index.ts";
import {
	binaryCodec,
	checkMessage,
	DeflatedPart,
	describeMessage,
	jsonPart,
	type Message,
	parsePart,
	parsePayload,
	payloadPart,
	textCodec,
} from "../../src/link/internal.ts";
import type { Part } from "../../src/link/part.ts";
import { forEachCodec, testCodec } from "../support.ts";

/** A part as JSON text: a received part's bytes decoded (a deflated part stays as it is). */
function partText(part: Part): Part {
	return part instanceof Uint8Array ? new TextDecoder().decode(part) : part;
}

const incarnation = "0190f5a2-7c3e-7d4a-9b1c-2d3e4f5a6b7c";

/** The address a hold names: `Server()` on the wire. */
const server = { kind: "server", params: {} };
const error = { kind: "chord", error: { code: "released", message: "gone" } } as const;

/** One message of every kind, with the optional fields both present and absent; parts are JSON text. */
const EVERY_KIND: Message[] = [
	{ kind: "hello", protocol: 1, incarnation, calls: 256 },
	// No call window: a trusted link's (decision "Call windows only for untrusted links").
	{ kind: "hello", protocol: 1, incarnation },
	{
		kind: "hold",
		hold: 300,
		type: "app.notes",
		version: 2,
		fingerprint: "0123456789abcdef",
		params: '{"id":1}',
		address: server,
	},
	{
		kind: "hold",
		hold: 1,
		type: "app.notes",
		version: 1,
		fingerprint: "0123456789abcdef",
		params: '{"session":"S1"}',
		address: { kind: "session", params: { id: "S1" } },
		principal: { kind: "guest" },
		incarnation,
	},
	{
		kind: "hold",
		hold: 2,
		type: "app.notes",
		version: 1,
		fingerprint: "0123456789abcdef",
		params: "{}",
		address: server,
		incarnation,
	},
	{ kind: "release", hold: 0 },
	{ kind: "call", call: 3, hold: 0, method: 1, args: '{"text":"x"}' },
	{ kind: "call", call: 4, hold: 0, method: 0 },
	{ kind: "abort", call: 3 },
	{
		kind: "bound",
		holds: [{ hold: 0, granted: [1], members: [{ member: 0, value: '[1,"a"]' }], failed: [{ member: 1, error }] }],
	},
	{
		kind: "bound",
		holds: [
			{ hold: 0, granted: [], members: [], failed: [] },
			{ hold: 5, granted: [2], members: [{ member: 1, value: "null" }], failed: [] },
		],
	},
	{
		kind: "state",
		holds: [
			{ hold: 0, members: [{ member: 2, ops: '[["s",["n"],1]]' }], failed: [], retired: [] },
			{ hold: 1, members: [], failed: [{ member: 0, error }], retired: [] },
			// Retired members (decision "One retirement mechanism"), alone and with a failure.
			{ hold: 2, members: [{ member: 1, ops: '[["r",{}]]' }], failed: [], retired: [1, 3] },
			{ hold: 3, members: [], failed: [{ member: 0, error }], retired: [2] },
		],
	},
	{
		kind: "failed",
		hold: 0,
		cause: { kind: "transient", error: { kind: "chord", error: { code: "unavailable", message: "m" } } },
	},
	{
		kind: "failed",
		hold: 0,
		cause: { kind: "broken", error: { kind: "chord", error: { code: "unavailable", message: "m" } } },
	},
	{
		kind: "failed",
		hold: 0,
		cause: { kind: "transient", error: { kind: "chord", error: { code: "unavailable", message: "m" } } },
		retryIn: 0,
	},
	// Not the object's fault (dependency model §2): no backoff window, an event wakes it.
	{
		kind: "failed",
		hold: 0,
		cause: { kind: "waiting", error: { kind: "chord", error: { code: "contract_mismatch", message: "m" } } },
	},
	// An admission refused the caller (slice 14 §2.4): no backoff window, the decision wakes it.
	{
		kind: "failed",
		hold: 0,
		cause: { kind: "denied", error: { kind: "chord", error: { code: "forbidden", message: "no access" } } },
	},
	// The wire error format in `failed` and `gone`: a plugin's error travels too.
	{ kind: "failed", hold: 0, cause: { kind: "broken", error: { kind: "plugin", code: "config", message: "m" } } },
	{ kind: "gone", hold: 1, error: { kind: "plugin", code: "config", message: "m", details: { at: 1 } } },
	{
		kind: "failed",
		hold: 9,
		cause: { kind: "transient", error: { kind: "chord", error: { code: "unavailable", message: "m" } } },
		retryIn: 60_000,
	},
	// With its hop budget (audit A5): the first host's, and the last one passed on.
	{ kind: "retry", hold: 300, hops: 16 },
	{ kind: "retry", hold: 300, hops: 1 },
	{ kind: "loading", hold: 300 },
	{ kind: "result", call: 3, value: '{"n":1}' },
	{ kind: "result", call: 3 },
	{ kind: "error", call: 3, error: { kind: "plugin", code: "c", message: "m", details: [1] } },
	{ kind: "gone", hold: 0, error: { kind: "chord", error: { code: "released", message: "m" } } },
	{ kind: "ack" },
	{ kind: "ack", origin: 1 },
	// Event acks (decision "Events: fire-and-forget members"): the event messages consumed, never a state ack.
	{ kind: "ack", events: 1 },
	{ kind: "ack", origin: 300, events: 4000 },
	{ kind: "closed", origin: 300 },
	// Events: `at` a whole `Date.now()`, several holds and members in one message, and none (a relay's filtered one).
	{
		kind: "event",
		events: [
			{ hold: 0, member: 0, at: 1_762_819_200_123, value: '{"t":1,"y":0.5}' },
			{ hold: 300, member: 2, at: 0, value: "null" },
		],
	},
	{ kind: "event", origin: 7, events: [] },
	{
		kind: "hold",
		origin: 2,
		hold: 0,
		type: "t",
		version: 1,
		fingerprint: "0123456789abcdef",
		params: "{}",
		address: server,
	},
	{ kind: "release", origin: 2, hold: 3 },
	{ kind: "call", origin: 2, call: 1, hold: 3, method: 0, args: "[1]" },
	{ kind: "abort", origin: 2, call: 1 },
	{ kind: "retry", origin: 2, hold: 3, hops: 16 },
	{ kind: "bound", origin: 2, holds: [{ hold: 3, granted: [], members: [], failed: [] }] },
	{ kind: "state", origin: 2, holds: [] },
	{
		kind: "failed",
		origin: 2,
		hold: 3,
		cause: { kind: "broken", error: { kind: "chord", error: { code: "unavailable", message: "m" } } },
	},
	{ kind: "loading", origin: 2, hold: 3 },
	{ kind: "result", origin: 2, call: 1 },
	{ kind: "error", origin: 2, call: 1, error: { kind: "plugin", code: "c", message: "m" } },
	{ kind: "gone", origin: 2, hold: 3, error: { kind: "chord", error: { code: "released", message: "m" } } },
	{
		kind: "hold",
		hold: 3,
		type: "app.notes",
		version: 1,
		fingerprint: "0123456789abcdef",
		params: "{}",
		address: server,
		chain: [incarnation, incarnation],
		limit: 65_536,
	},
	{
		kind: "hold",
		hold: 4,
		type: "t",
		version: 1,
		fingerprint: "0123456789abcdef",
		params: "{}",
		address: server,
		limit: 0,
	},
	{ kind: "revoke", revocation: { grant: "g1" } },
	{ kind: "ping" },
	{ kind: "pong" },
	// Trace carriers (R5, slice 9) on a hold and a call, with and without an origin, arguments and other fields.
	{
		kind: "hold",
		hold: 5,
		type: "app.notes",
		version: 1,
		fingerprint: "0123456789abcdef",
		params: "{}",
		address: server,
		trace: { "pi-memory-span": "1", "pi-memory-trace": "s:1" },
	},
	{
		kind: "hold",
		origin: 3,
		hold: 6,
		type: "app.notes",
		version: 1,
		fingerprint: "0123456789abcdef",
		params: "{}",
		address: server,
		limit: 10,
		trace: { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" },
	},
	{ kind: "call", call: 7, hold: 0, method: 1, args: '{"text":"x"}', trace: { a: "b" } },
	{ kind: "call", origin: 2, call: 8, hold: 3, method: 0, trace: {} },
	{ kind: "call", call: 9, hold: 0, method: 1, args: '{"text":"x"}', old: true },
	{ kind: "call", origin: 2, call: 10, hold: 3, method: 0, trace: { a: "b" }, old: true },
];

/** A carrier at the bounds: 8 keys, keys and values of 256 characters. */
const LARGEST_CARRIER = Object.fromEntries(
	Array.from({ length: 8 }, (_, index) => [`${index}`.padEnd(256, "k"), "v".repeat(256)]),
);

/** A decoded message with every part as its text, to compare with one built from text parts. */
function plain(message: Message): Message {
	switch (message.kind) {
		case "hold":
			return { ...message, params: partText(message.params) };
		case "call":
			return message.args === undefined ? message : { ...message, args: partText(message.args) };
		case "result":
			return message.value === undefined ? message : { ...message, value: partText(message.value) };
		case "bound":
			return {
				...message,
				holds: message.holds.map((entry) => ({
					...entry,
					members: entry.members.map(({ member, value }) => ({ member, value: partText(value) })),
				})),
			};
		case "state":
			return {
				...message,
				holds: message.holds.map((entry) => ({
					...entry,
					members: entry.members.map(({ member, ops }) => ({ member, ops: partText(ops) })),
				})),
			};
		case "event":
			return { ...message, events: message.events.map((entry) => ({ ...entry, value: partText(entry.value) })) };
		default:
			return message;
	}
}

forEachCodec(() => {
	describe("messages", () => {
		it.each(EVERY_KIND)("round-trip %j and pass the message schema", (message) => {
			const codec = testCodec();
			const decoded = checkMessage(codec.decode(codec.encode(message)), context);
			expect(plain(decoded)).toEqual(message);
		});

		it("round-trip deflated parts in every part's place, still deflated (a relay forwards them so)", () => {
			const codec = testCodec();
			const deflated = () => new DeflatedPart(new Uint8Array([0, 1, 2, 255]));
			const messages: Message[] = [
				{
					kind: "hold",
					hold: 0,
					type: "t",
					version: 1,
					fingerprint: "0123456789abcdef",
					params: deflated(),
					address: server,
				},
				{ kind: "call", call: 0, hold: 0, method: 0, args: deflated() },
				{ kind: "result", call: 0, value: deflated(), segments: [new Uint8Array([7])] },
				{
					kind: "bound",
					holds: [{ hold: 0, granted: [], members: [{ member: 0, value: deflated() }], failed: [] }],
				},
				{ kind: "state", holds: [{ hold: 0, members: [{ member: 0, ops: deflated() }], failed: [], retired: [] }] },
				{ kind: "event", origin: 2, events: [{ hold: 0, member: 1, at: 5, value: deflated() }] },
			];
			for (const message of messages) {
				const decoded = checkMessage(codec.decode(codec.encode(message)), context);
				expect(decoded).toEqual(message);
			}
		});

		it("round-trip parts received as bytes (a relay forwards them as they came)", () => {
			const codec = testCodec();
			const message: Message = { kind: "result", call: 0, value: new TextEncoder().encode('{"n":1}') };
			expect(plain(codec.decode(codec.encode(message)))).toEqual({ kind: "result", call: 0, value: '{"n":1}' });
		});

		it("carry byte segments beside a payload, as views of the message", () => {
			const codec = testCodec();
			const data = new Uint8Array(1024).fill(7);
			const thumbs = [new Uint8Array([1, 2]), new Uint8Array([3])];
			const { json, segments } = payloadPart({ name: "a", data, thumbs }, true);
			const message: Message = { kind: "call", call: 0, hold: 0, method: 0, args: json, segments };
			const bytes = codec.encode(message);
			const decoded = codec.decode(bytes) as Extract<Message, { kind: "call" }>;
			expect(decoded.segments).toHaveLength(3);
			expect(decoded.segments![0]!.buffer).toBe(bytes.buffer);
			const args = parsePayload(decoded.args as Uint8Array, decoded.segments) as {
				data: Uint8Array;
				thumbs: Uint8Array[];
			};
			expect(args.data).toEqual(data);
			expect(args.data.buffer).toBe(bytes.buffer);
			expect(args.thumbs).toEqual(thumbs);
			// The segments travel raw: the message is barely larger than the bytes it carries.
			expect(bytes.byteLength).toBeLessThan(1024 + 3 + 100);
		});

		it("refuse an empty message, an unknown kind and trailing bytes", () => {
			const codec = testCodec();
			const release = codec.encode({ kind: "release", hold: 1 });
			const trailing = new Uint8Array([...release, ...(codec === binaryCodec ? [0] : [0x20, 0x31])]);
			expect(() => codec.decode(new Uint8Array())).toThrow();
			expect(() =>
				codec.decode(codec === binaryCodec ? new Uint8Array([31]) : new TextEncoder().encode('["?"]')),
			).toThrow("unknown kind");
			expect(() => codec.decode(trailing)).toThrow();
		});

		it("refuse an origin on a kind without one, an origin 0, and a closed without one (the message schema)", () => {
			const codec = testCodec();
			const check = (message: unknown) => () =>
				checkMessage(codec.decode(codec.encode(message as Message)), context);
			expect(check({ kind: "ping", origin: 1 })).toThrow("message schema");
			expect(check({ kind: "ack", origin: 0 })).toThrow("message schema");
			const closed = codec === binaryCodec ? new Uint8Array([14]) : new TextEncoder().encode('["C"]');
			expect(() => checkMessage(codec.decode(closed), context)).toThrow("message schema");
		});

		it("carry a trace carrier up to its bounds; past them, of another shape or on another kind, the schema refuses it", () => {
			const codec = testCodec();
			const check = (message: unknown) => () =>
				checkMessage(codec.decode(codec.encode(message as Message)), context);
			const call = { kind: "call", call: 0, hold: 0, method: 0 } as const;
			expect(check({ ...call, trace: LARGEST_CARRIER })()).toEqual({ ...call, trace: LARGEST_CARRIER });
			expect(check({ ...call, trace: { ...LARGEST_CARRIER, nine: "x" } })).toThrow("message schema");
			expect(check({ ...call, trace: { ["k".repeat(257)]: "v" } })).toThrow("message schema");
			expect(check({ ...call, trace: { k: "v".repeat(257) } })).toThrow("message schema");
			expect(check({ ...call, trace: { k: 1 } })).toThrow("message schema");
			expect(check({ ...call, trace: ["k"] })).toThrow("message schema");
			// Printable ASCII only (review M2): no control character, no space in a key; a value may hold one (W3C's
			// `tracestate`).
			expect(check({ ...call, trace: { k: "a\u001b[2J" } })).toThrow("message schema");
			expect(check({ ...call, trace: { "k\u0007": "v" } })).toThrow("message schema");
			expect(check({ ...call, trace: { "a b": "v" } })).toThrow("message schema");
			expect(check({ ...call, trace: { k: "é" } })).toThrow("message schema");
			expect(check({ ...call, trace: { k: "a=1, b=2" } })()).toEqual({ ...call, trace: { k: "a=1, b=2" } });
			// The codecs write it only on a hold or a call; a decoder's forgery fails the schema.
			expect(() => checkMessage({ kind: "abort", call: 0, trace: { k: "v" } }, context)).toThrow("message schema");
		});

		it("carry a trace carrier beside a call's byte segments", () => {
			const codec = testCodec();
			const { json, segments } = payloadPart({ data: new Uint8Array([1, 2, 3]) }, true);
			const message: Message = {
				kind: "call",
				call: 0,
				hold: 0,
				method: 0,
				args: json,
				segments,
				trace: { a: "b" },
			};
			const decoded = codec.decode(codec.encode(message)) as Extract<Message, { kind: "call" }>;
			expect(decoded.trace).toEqual({ a: "b" });
			expect(decoded.segments).toEqual(segments);
		});

		it("refuse a type or host kind past 256 characters (review M1: a relay records them unparsed)", () => {
			const codec = testCodec();
			const check = (message: unknown) => () =>
				checkMessage(codec.decode(codec.encode(message as Message)), context);
			const hold = {
				kind: "hold",
				hold: 0,
				type: "t".repeat(256),
				version: 1,
				fingerprint: "0123456789abcdef",
				params: "{}",
				address: { kind: "k".repeat(256), params: {} },
			};
			expect(check(hold)).not.toThrow();
			expect(check({ ...hold, type: "t".repeat(257) })).toThrow("message schema");
			expect(check({ ...hold, address: { kind: "k".repeat(257), params: {} } })).toThrow("message schema");
		});

		it("keep a leading U+FEFF in strings and parts (it is data, not a byte order mark)", () => {
			const codec = testCodec();
			const message: Message = {
				kind: "hold",
				hold: 0,
				type: "\uFEFFthing",
				version: 1,
				fingerprint: "0123456789abcdef",
				params: jsonPart({ "\uFEFFkey": "\uFEFFvalue" }),
				address: server,
			};
			const decoded = codec.decode(codec.encode(message)) as Extract<Message, { kind: "hold" }>;
			expect(plain(decoded)).toEqual(message);
			expect(parsePart(decoded.params as string | Uint8Array)).toEqual({ "\uFEFFkey": "\uFEFFvalue" });
			const result: Message = { kind: "result", call: 0, value: jsonPart("\uFEFF") };
			expect(plain(codec.decode(codec.encode(result)))).toEqual(result);
		});

		it("leave the envelope to the message schema: a misshapen error passes the codec and fails the schema", () => {
			const codec = testCodec();
			const decoded = codec.decode(codec.encode({ kind: "error", call: 0, error: { kind: "nope" } } as never));
			expect(() => checkMessage(decoded, context)).toThrow("message: fails the message schema");
			expect(() => checkMessage({ kind: "release", hold: -1 }, context)).toThrow(
				"message: fails the message schema",
			);
		});
	});
});

describe("the binary codec", () => {
	it("writes ids as varints, the incarnation as 16 and the fingerprint as 8 raw bytes, no outer length", () => {
		expect(binaryCodec.encode({ kind: "hello", protocol: 1, incarnation, calls: 1 })).toHaveLength(1 + 1 + 16 + 1);
		// No call window is written as 0 (a window is at least 1) and read back as absent.
		const none = binaryCodec.encode({ kind: "hello", protocol: 1, incarnation });
		expect(none.at(-1)).toBe(0);
		expect(binaryCodec.decode(none)).toEqual({ kind: "hello", protocol: 1, incarnation });
		expect([...binaryCodec.encode({ kind: "release", hold: 300 })]).toEqual([2, 0xac, 0x02]);
		const hold = binaryCodec.encode({
			kind: "hold",
			hold: 0,
			type: "t",
			version: 1,
			fingerprint: "0123456789abcdef",
			params: "{}",
			address: server,
		});
		// kind, id, type, version, fingerprint, params, the address's kind and params, the optional fields' flags
		expect(hold).toHaveLength(1 + 1 + 2 + 1 + 8 + 3 + 7 + 3 + 1);
		expect([...binaryCodec.encode({ kind: "ack" })]).toEqual([13]);
		// An event ack: the kind byte's third flag, then its count (a state ack stays one byte).
		expect([...binaryCodec.encode({ kind: "ack", events: 3 })]).toEqual([13 | 0x20, 3]);
		expect(binaryCodec.decode(binaryCodec.encode({ kind: "ack", events: 3 }))).toEqual({ kind: "ack", events: 3 });
		expect(() => binaryCodec.decode(new Uint8Array([14 | 0x20, 1]))).toThrow("binary: an unknown kind");
		// An origin: the kind byte's high bit, then the origin as a varint.
		expect([...binaryCodec.encode({ kind: "ack", origin: 300 })]).toEqual([13 | 0x80, 0xac, 0x02]);
		expect([...binaryCodec.encode({ kind: "closed", origin: 1 })]).toEqual([14 | 0x80, 1]);
	});

	it("writes a failure's cause as one byte, 0 transient, 1 broken, 2 waiting, 3 denied (slice 14 §2.4); refuses another", () => {
		const error = { kind: "chord", error: { code: "unavailable", message: "m" } } as const;
		const failed = (kind: "transient" | "broken" | "waiting" | "denied"): Message => ({
			kind: "failed",
			hold: 0,
			cause: { kind, error },
		});
		expect(
			["transient", "broken", "waiting", "denied"].map((kind) => binaryCodec.encode(failed(kind as "denied"))[2]),
		).toEqual([0, 1, 2, 3]);
		const unknown = binaryCodec.encode(failed("waiting"));
		unknown[2] = 4;
		expect(() => binaryCodec.decode(unknown)).toThrow("an unknown failure kind");
	});

	it("costs a state entry without retirements no byte: the failure count is doubled, plus one when they follow", () => {
		const state = (retired: number[]): Message => ({
			kind: "state",
			holds: [{ hold: 0, members: [], failed: [], retired }],
		});
		// kind, entry count, hold, member count, failures (0 doubled)
		expect([...binaryCodec.encode(state([]))]).toEqual([6, 1, 0, 0, 0]);
		// the low bit set, then the retired count and member
		expect([...binaryCodec.encode(state([3]))]).toEqual([6, 1, 0, 0, 1, 1, 3]);
		const first = binaryCodec.decode(binaryCodec.encode(state([])));
		const second = binaryCodec.decode(binaryCodec.encode(state([])));
		const retired = (message: Message) => (message as Extract<Message, { kind: "state" }>).holds[0]!.retired;
		// No allocation per message: decoded entries without retirements share one empty list.
		expect(retired(first)).toBe(retired(second));
	});

	it("prefixes a part with its length doubled, plus one when it is deflated", () => {
		const plain = binaryCodec.encode({ kind: "result", call: 0, value: "12" });
		const deflated = binaryCodec.encode({ kind: "result", call: 0, value: new DeflatedPart(new Uint8Array([7, 8])) });
		// kind, call, payload flags, prefix, bytes
		expect([...plain]).toEqual([8, 0, 1, 4, 0x31, 0x32]);
		expect([...deflated]).toEqual([8, 0, 1, 5, 7, 8]);
	});

	it("decodes parts as views of the message, never parsing them: a malformed part decodes", () => {
		const part = new TextEncoder().encode("{not json");
		const bytes = binaryCodec.encode({ kind: "result", call: 0, value: part });
		const decoded = binaryCodec.decode(bytes) as Extract<Message, { kind: "result" }>;
		const value = decoded.value as Uint8Array;
		expect(value.buffer).toBe(bytes.buffer);
		expect(() => parsePart(value)).toThrow();
	});

	it("refuses varints past a safe integer and lengths past the message", () => {
		expect(() => binaryCodec.decode(new Uint8Array([2, ...new Array(8).fill(0xff), 0x7f]))).toThrow(
			"a varint does not fit",
		);
		expect(() => binaryCodec.decode(new Uint8Array([1, 0, 9, 0x61]))).toThrow("the message ends early");
	});

	it("refuses a varint of more than 8 bytes, which would read as no number", () => {
		const state = new Uint8Array([6, ...new Array(150).fill(0x80), 0]);
		expect(() => binaryCodec.decode(state)).toThrow("a varint does not fit");
	});

	it("flags a trace carrier in the kind byte (0x40) and writes it as JSON after the origin", () => {
		const call = binaryCodec.encode({ kind: "call", origin: 2, call: 0, hold: 0, method: 0, trace: { a: "b" } });
		const json = new TextEncoder().encode('{"a":"b"}');
		expect([...call.subarray(0, 3 + json.byteLength)]).toEqual([3 | 0x80 | 0x40, 2, json.byteLength, ...json]);
		const plainCall = binaryCodec.encode({ kind: "call", call: 0, hold: 0, method: 0 });
		expect(plainCall[0]).toBe(3);
	});

	it("flags a call that is old work of a reload in the kind byte (0x20); another kind with that flag is unknown", () => {
		const call = binaryCodec.encode({ kind: "call", call: 0, hold: 0, method: 0, old: true });
		expect(call[0]).toBe(3 | 0x20);
		expect(binaryCodec.decode(call)).toEqual({ kind: "call", call: 0, hold: 0, method: 0, old: true });
		const release = binaryCodec.encode({ kind: "release", hold: 1 });
		release[0]! |= 0x20;
		expect(() => binaryCodec.decode(release)).toThrow("unknown kind");
	});

	it("refuses unknown hold flags", () => {
		const hold = binaryCodec.encode({
			kind: "hold",
			hold: 0,
			type: "t",
			version: 1,
			fingerprint: "0123456789abcdef",
			params: "{}",
			address: server,
		});
		const forged = hold.slice();
		forged[forged.length - 1] = 32;
		expect(() => binaryCodec.decode(forged)).toThrow("unknown hold flags");
	});

	it("returns a right-sized message: a large one keeps no larger backing store", () => {
		const value = jsonPart("x".repeat(500_000));
		// Small fields after the large value: they must not double the buffer the message keeps.
		const members = [
			{ member: 0, value },
			{ member: 1, value: "1" },
		];
		const bytes = binaryCodec.encode({ kind: "bound", holds: [{ hold: 0, granted: [], members, failed: [] }] });
		expect(bytes.buffer.byteLength - bytes.byteLength).toBeLessThanOrEqual(4096);
		const small = binaryCodec.encode({ kind: "release", hold: 1 });
		expect(small.buffer.byteLength).toBe(small.byteLength);
		// A message of about two thirds of the starting buffer keeps no spare room either.
		const medium = binaryCodec.encode({ kind: "result", call: 0, value: jsonPart("x".repeat(160)) });
		expect(medium.buffer.byteLength).toBe(medium.byteLength);
	});

	it("returns messages that share no buffer: a later encode leaves an earlier message as it was", () => {
		const first = binaryCodec.encode({ kind: "result", call: 0, value: '"a"' });
		const copy = [...first];
		binaryCodec.encode({ kind: "result", call: 1, value: '"bbbbbbbb"' });
		expect([...first]).toEqual(copy);
		expect(first.buffer.byteLength).toBe(first.byteLength);
		// A message that grew the kept buffer (5 KiB) is copied out of it too.
		const grown = binaryCodec.encode({ kind: "result", call: 0, value: jsonPart("a".repeat(5_000)) });
		const grownCopy = [...grown];
		binaryCodec.encode({ kind: "result", call: 1, value: jsonPart("b".repeat(5_000)) });
		expect([...grown]).toEqual(grownCopy);
		expect(grown.buffer.byteLength).toBe(grown.byteLength);
	});

	it("writes a fingerprint and an incarnation only as lowercase hex of their length, dashes left out wherever they are", () => {
		const hold = (fingerprint: string, incarnation?: string): Message => ({
			kind: "hold",
			hold: 0,
			type: "t",
			version: 1,
			fingerprint,
			params: "{}",
			address: server,
			...(incarnation === undefined ? {} : { incarnation }),
		});
		for (const bad of ["0123456789ABCDEF", "0123456789abcde", "0123456789abcdef0", "0123456789abcdeg", ""]) {
			expect(() => binaryCodec.encode(hold(bad))).toThrow(/^binary: not 8 bytes of hex$/);
		}
		const dashed = "0192f5e2-7c3a-7def-8abc-0123456789ab";
		const decoded = binaryCodec.decode(binaryCodec.encode(hold("0123456789abcdef", dashed.replace("-", "--"))));
		expect((decoded as Extract<Message, { kind: "hold" }>).incarnation).toBe(dashed);
		for (const bad of [dashed.slice(1), `${dashed}0`, dashed.toUpperCase(), dashed.replace("0", "x")]) {
			expect(() => binaryCodec.encode(hold("0123456789abcdef", bad))).toThrow(/^binary: not 16 bytes of hex$/);
		}
	});

	it("decodes optional fields in their order and leaves absent ones unset (no key of `undefined`)", () => {
		const incarnation = "0192f5e2-7c3a-7def-8abc-0123456789ab";
		const keys = (message: Message) => Object.keys(binaryCodec.decode(binaryCodec.encode(message)));
		const hold = {
			kind: "hold",
			hold: 0,
			type: "t",
			version: 1,
			fingerprint: "0123456789abcdef",
			params: "{}",
			address: server,
		} as const;
		expect(keys(hold)).toEqual(["kind", "hold", "type", "version", "fingerprint", "params", "address"]);
		expect(
			keys({ ...hold, principal: { kind: "p" }, incarnation, chain: [incarnation], limit: 3, trace: { a: "b" } }),
		).toEqual([
			"kind",
			"hold",
			"type",
			"version",
			"fingerprint",
			"params",
			"address",
			"principal",
			"incarnation",
			"chain",
			"limit",
			"trace",
		]);
		expect(keys({ kind: "call", call: 0, hold: 0, method: 0 })).toEqual(["kind", "call", "hold", "method"]);
		const segments = [new Uint8Array([1])];
		expect(keys({ kind: "call", call: 0, hold: 0, method: 0, args: "[]", segments, old: true })).toEqual([
			"kind",
			"call",
			"hold",
			"method",
			"args",
			"segments",
			"old",
		]);
		expect(keys({ kind: "result", call: 0 })).toEqual(["kind", "call"]);
		expect(keys({ kind: "result", call: 0, value: "1", origin: 2 })).toEqual(["kind", "call", "value", "origin"]);
		const cause = { kind: "broken", error: { kind: "chord", error: { code: "released", message: "" } } } as const;
		expect(keys({ kind: "failed", hold: 0, cause })).toEqual(["kind", "hold", "cause"]);
		expect(keys({ kind: "failed", hold: 0, cause, retryIn: 0 })).toEqual(["kind", "hold", "cause", "retryIn"]);
	});

	it("leaves a decoded message's lists its own: the public type keeps a state entry's failed list mutable", () => {
		const error = { kind: "chord", error: { code: "unavailable", message: "m" } } as const;
		const state: Message = {
			kind: "state",
			holds: [
				{
					hold: 0,
					members: [],
					failed: [
						{ member: 2, error },
						{ member: 1, error },
					],
					retired: [],
				},
			],
		};
		const decoded: PublicMessage = binaryCodec.decode(binaryCodec.encode(state));
		// A tool's own sort of what it decoded compiles (a type test) and changes nothing of the codec's.
		if (decoded.kind === "state") for (const entry of decoded.holds) entry.failed.sort((a, b) => a.member - b.member);
		expect((decoded as Extract<Message, { kind: "state" }>).holds[0]!.failed.map(({ member }) => member)).toEqual([
			1, 2,
		]);
	});

	it("allocates about one frame per encode of a frame a little past the kept buffer (review of f17e4a999)", () => {
		const gc = runInNewContext("gc") as () => void;
		const value = new TextEncoder().encode(`"${"x".repeat(1_022)}"`);
		for (const count of [16, 18, 34]) {
			const members = Array.from({ length: count }, (_, member) => ({ member, value }));
			const frame: Message = { kind: "bound", holds: [{ hold: 0, granted: [], members, failed: [] }] };
			const length = binaryCodec.encode(frame).byteLength;
			gc();
			const before = process.memoryUsage().arrayBuffers;
			for (let index = 0; index < 32; index++) binaryCodec.encode(frame);
			// Regrown from the kept buffer at every send, an 18 KiB frame took 80 KB of buffers (the base 36 KB).
			expect((process.memoryUsage().arrayBuffers - before) / 32).toBeLessThan(3 * length);
		}
	});

	it("allocates about one frame for a mid-size frame right after a much larger one (review of 4b2ae2444)", () => {
		const gc = runInNewContext("gc") as () => void;
		const part = (bytes: number) => new TextEncoder().encode(`"${"x".repeat(bytes - 2)}"`);
		const bound = (members: { member: number; value: Uint8Array }[]): Message => ({
			kind: "bound",
			holds: [{ hold: 0, granted: [], members, failed: [] }],
		});
		const large = bound([{ member: 0, value: part(1024 * 1024) }]);
		const mid = bound(Array.from({ length: 20 }, (_, member) => ({ member, value: part(1024) })));
		const length = binaryCodec.encode(mid).byteLength;
		let allocated = 0;
		for (let round = 0; round < 20; round++) {
			binaryCodec.encode(large);
			gc();
			const before = process.memoryUsage().arrayBuffers;
			binaryCodec.encode(mid);
			allocated += process.memoryUsage().arrayBuffers - before;
		}
		// Sized from the large frame before it, each mid-size frame took a MiB.
		expect(allocated / 20).toBeLessThan(3 * length);
	});

	it("allocates about one frame for a frame of many small parts (review of adcbac474)", () => {
		const gc = runInNewContext("gc") as () => void;
		const value = new TextEncoder().encode(`"${"x".repeat(510)}"`);
		const members = Array.from({ length: 2048 }, (_, member) => ({ member, value }));
		const frame: Message = { kind: "bound", holds: [{ hold: 0, granted: [], members, failed: [] }] };
		const length = binaryCodec.encode(frame).byteLength;
		gc();
		const before = process.memoryUsage().arrayBuffers;
		for (let index = 0; index < 8; index++) binaryCodec.encode(frame);
		// Estimated by its parts alone, it fell short by its fields and doubled: four frames.
		expect((process.memoryUsage().arrayBuffers - before) / 8).toBeLessThan(1.5 * length);
	});

	it("allocates about one frame for a text that changes density: ASCII, then three-byte (review of 35496c9c8)", () => {
		const gc = runInNewContext("gc") as () => void;
		const value = JSON.stringify({ en: "a".repeat(524_288), zh: "源".repeat(524_288) });
		const frame: Message = {
			kind: "bound",
			holds: [{ hold: 0, granted: [], members: [{ member: 0, value }], failed: [] }],
		};
		const length = binaryCodec.encode(frame).byteLength;
		gc();
		const before = process.memoryUsage().arrayBuffers;
		for (let index = 0; index < 4; index++) binaryCodec.encode(frame);
		// Reserved at the density of its ASCII half, the three-byte half fell short again and again: 4.4 frames.
		expect((process.memoryUsage().arrayBuffers - before) / 4).toBeLessThan(1.6 * length);
	});

	it("allocates about one frame for several long two-byte texts in one message (review of 3b9a00775)", () => {
		const gc = runInNewContext("gc") as () => void;
		const value = JSON.stringify("é".repeat(65_536));
		const members = Array.from({ length: 4 }, (_, member) => ({ member, value }));
		const frame: Message = { kind: "bound", holds: [{ hold: 0, granted: [], members, failed: [] }] };
		const length = binaryCodec.encode(frame).byteLength;
		gc();
		const before = process.memoryUsage().arrayBuffers;
		for (let index = 0; index < 4; index++) binaryCodec.encode(frame);
		// Each text falling short on its own copied the frame so far again: 3.8 frames.
		expect((process.memoryUsage().arrayBuffers - before) / 4).toBeLessThan(1.6 * length);
	});

	it("allocates no more than the base for a state of 256 failed members with 1 KiB errors (review of 98a93c706)", () => {
		const gc = runInNewContext("gc") as () => void;
		const failed = Array.from({ length: 256 }, (_, member) => ({
			member,
			error: {
				kind: "plugin" as const,
				code: "ELOAD",
				message: `could not load member ${member}`,
				details: { reason: `failed to parse schema at ${"segment/".repeat(120)}${member}` },
			},
		}));
		const frame: Message = { kind: "state", holds: [{ hold: 1, members: [], retired: [], failed }] };
		const length = binaryCodec.encode(frame).byteLength;
		gc();
		const before = process.memoryUsage().arrayBuffers;
		for (let index = 0; index < 4; index++) binaryCodec.encode(frame);
		// Grown by exactly each error once sized, the frame so far was copied 256 times: 31 frames (the base 4.4; the
		// errors are not estimated, so a shortfall doubles).
		expect((process.memoryUsage().arrayBuffers - before) / 4).toBeLessThan(4.5 * length);
	});

	it("encodes a failure whose error is null or missing as the base did: the estimate reads no error (review of 46f7f5f2e)", () => {
		const state = (error: unknown, ops: string): Message => ({
			kind: "state",
			// Any JSON may come from a peer there (the schema's unknown), decoded by the text codec as it is.
			holds: [
				{
					hold: 1,
					members: ops === "" ? [] : [{ member: 1, ops }],
					retired: [],
					failed: [{ member: 0, error: error as never }],
				},
			],
		});
		const nullError = [6, 1, 1, 0, 2, 0, 29, ...new TextEncoder().encode('{"kind":"chord","error":null}')];
		expect([...binaryCodec.encode(state({ kind: "chord", error: null }, ""))]).toEqual(nullError);
		expect(binaryCodec.decode(binaryCodec.encode(state({ kind: "chord" }, "")))).toEqual(
			state({ kind: "chord" }, ""),
		);
		// Past the kept buffer too (a buffer of its own, estimated).
		const large = state({ kind: "chord", error: null }, JSON.stringify("x".repeat(20_000)));
		const decoded = binaryCodec.decode(binaryCodec.encode(large)) as Extract<Message, { kind: "state" }>;
		expect(decoded.holds[0]!.failed).toEqual([{ member: 0, error: { kind: "chord", error: null } }]);
	});

	it("refuses invalid UTF-8 in strings", () => {
		expect(() => binaryCodec.decode(new Uint8Array([1, 0, 1, 0xff]))).toThrow();
	});

	it("writes retry as its kind, hold and hops, loading as its kind and hold, and failed's retryIn as one more than it (0: absent)", () => {
		expect([...binaryCodec.encode({ kind: "retry", hold: 300, hops: 16 })]).toEqual([11, 0xac, 0x02, 16]);
		expect([...binaryCodec.encode({ kind: "loading", hold: 1 })]).toEqual([12, 1]);
		const cause = { kind: "broken", error: { kind: "chord", error: { code: "released", message: "" } } } as const;
		const absent = binaryCodec.encode({ kind: "failed", hold: 0, cause });
		const present = binaryCodec.encode({ kind: "failed", hold: 0, cause, retryIn: 0 });
		expect(absent.at(-1)).toBe(0);
		expect(present.at(-1)).toBe(1);
	});
});

describe("the text codec", () => {
	const text = (message: Message) => new TextDecoder().decode(textCodec.encode(message));

	it("writes one JSON tuple per message with short tags and positional fields, parts spliced in", () => {
		expect(text({ kind: "release", hold: 3 })).toBe('["R",3]');
		expect(text({ kind: "call", call: 1, hold: 0, method: 2 })).toBe('["c",1,0,2]');
		const members = [{ member: 0, value: "5" }];
		expect(text({ kind: "bound", holds: [{ hold: 0, granted: [1, 3], members, failed: [] }] })).toBe(
			'["b",[[0,[1,3],[[0,[0,5]]]]]]',
		);
		expect(text({ kind: "retry", hold: 2, hops: 16 })).toBe('["T",2,16]');
		expect(text({ kind: "loading", hold: 2 })).toBe('["l",2]');
		const cause = {
			kind: "transient",
			error: { kind: "chord", error: { code: "unavailable", message: "m" } },
		} as const;
		expect(text({ kind: "failed", hold: 2, cause })).toBe(
			'["f",2,"t",{"kind":"chord","error":{"code":"unavailable","message":"m"}}]',
		);
		expect(text({ kind: "failed", hold: 2, cause, retryIn: 750 })).toBe(
			'["f",2,"t",{"kind":"chord","error":{"code":"unavailable","message":"m"}},750]',
		);
		expect(text({ kind: "failed", hold: 2, cause: { ...cause, kind: "waiting" } })).toBe(
			'["f",2,"w",{"kind":"chord","error":{"code":"unavailable","message":"m"}}]',
		);
		expect(text({ kind: "failed", hold: 2, cause: { ...cause, kind: "denied" } })).toBe(
			'["f",2,"d",{"kind":"chord","error":{"code":"unavailable","message":"m"}}]',
		);
		expect(() => textCodec.decode(new TextEncoder().encode('["f",2,"x",{}]'))).toThrow("an unknown failure kind");
		expect(text({ kind: "ack" })).toBe('["a"]');
		expect(text({ kind: "ack", events: 2 })).toBe('["a",2]');
		expect(text({ kind: "event", events: [{ hold: 1, member: 0, at: 9, value: '{"y":1}' }] })).toBe(
			'["E",[[1,0,9,[0,{"y":1}]]]]',
		);
		// An origin wraps the message's own tuple.
		expect(text({ kind: "release", origin: 4, hold: 3 })).toBe('["@",4,["R",3]]');
		expect(text({ kind: "closed", origin: 4 })).toBe('["@",4,["C"]]');
	});

	it("tags every part with its codec, [0, json] or [1, base64] for a deflated one, so no value is reserved", () => {
		const message: Message = { kind: "result", call: 1, value: new DeflatedPart(new Uint8Array([1, 2, 3])) };
		expect(text(message)).toBe('["r",1,[1,"AQID"]]');
		expect(textCodec.decode(textCodec.encode(message))).toEqual(message);
		// A value of any shape is data, the one-key `$deflated` object the first builder reserved included.
		const shaped: Message = { kind: "result", call: 1, value: '{"$deflated":"AQID"}' };
		expect(text(shaped)).toBe('["r",1,[0,{"$deflated":"AQID"}]]');
		expect(textCodec.decode(textCodec.encode(shaped))).toEqual(shaped);
		expect(text({ kind: "revoke", revocation: { grant: "g" } })).toBe('["V",{"grant":"g"}]');
	});

	it("refuses a part that is no [codec, payload] pair, or of an unknown codec", () => {
		const decode = (tuple: string) => textCodec.decode(new TextEncoder().encode(tuple));
		expect(() => decode('["r",1,{"n":1}]')).toThrow("no [codec, payload] pair");
		expect(() => decode('["r",1,[2,"AQID"]]')).toThrow("unknown codec");
		expect(() => decode('["r",1,[1,5]]')).toThrow("unknown codec");
	});

	it("carries a binary link's deflated part over a text hop and back unchanged (a relay between codecs)", () => {
		const part = new DeflatedPart(new Uint8Array([9, 8, 7]));
		const message: Message = {
			kind: "state",
			holds: [{ hold: 0, members: [{ member: 0, ops: part }], failed: [], retired: [] }],
		};
		const overText = textCodec.decode(textCodec.encode(binaryCodec.decode(binaryCodec.encode(message))));
		expect(binaryCodec.decode(binaryCodec.encode(overText))).toEqual(message);
	});

	it("leaves out a hold's absent optional fields at the end, null in the middle", () => {
		const hold = {
			kind: "hold",
			hold: 0,
			type: "t",
			version: 1,
			fingerprint: "0123456789abcdef",
			params: "{}",
			address: server,
		} as const;
		const head = '["H",0,"t",1,"0123456789abcdef",[0,{}],["server",{}]';
		expect(text(hold)).toBe(`${head}]`);
		expect(text({ ...hold, incarnation })).toBe(`${head},null,"${incarnation}"]`);
		expect(text({ ...hold, limit: 5 })).toBe(`${head},null,null,null,5]`);
		expect(text({ ...hold, trace: { a: "b" } })).toBe(`${head},null,null,null,null,{"a":"b"}]`);
	});

	it("writes a call's trace carrier last, its payload's fields positional then (null when absent)", () => {
		const call = { kind: "call", call: 0, hold: 1, method: 2 } as const;
		expect(text({ ...call, trace: { a: "b" } })).toBe('["c",0,1,2,null,null,{"a":"b"}]');
		expect(text({ ...call, args: "[1]", trace: { a: "b" } })).toBe('["c",0,1,2,[0,[1]],null,{"a":"b"}]');
		expect(text({ ...call, args: "[1]" })).toBe('["c",0,1,2,[0,[1]]]');
	});

	it("writes a call's old-work flag after its carrier (null when absent), its payload's fields positional then", () => {
		const call = { kind: "call", call: 0, hold: 1, method: 2 } as const;
		expect(text({ ...call, old: true })).toBe('["c",0,1,2,null,null,null,true]');
		expect(text({ ...call, args: "[1]", trace: { a: "b" }, old: true })).toBe(
			'["c",0,1,2,[0,[1]],null,{"a":"b"},true]',
		);
	});

	it("leaves the old-work flag's value to the message schema: only true passes", () => {
		const decoded = textCodec.decode(new TextEncoder().encode('["c",0,1,2,null,null,null,1]'));
		expect(() => checkMessage(decoded, context)).toThrow("message schema");
	});

	it("puts byte segments after the tuple and a newline, their lengths the tuple's last field", () => {
		const bytes = textCodec.encode({
			kind: "result",
			call: 0,
			value: '{"$bytes":0}',
			segments: [new Uint8Array([1, 2])],
		});
		expect([...bytes]).toEqual([...new TextEncoder().encode('["r",0,[0,{"$bytes":0}],[2]]\n'), 1, 2]);
	});

	it("refuses a tuple of the wrong arity and segments without a payload carrying them", () => {
		expect(() => textCodec.decode(new TextEncoder().encode('["R",1,2]'))).toThrow('a "R" message with 2 fields');
		expect(() => textCodec.decode(new TextEncoder().encode('["s",[[0,[],[],[],9]]]'))).toThrow(
			"a state entry with 5 fields",
		);
		expect(() => textCodec.decode(new TextEncoder().encode('["s",[[0]]]'))).toThrow("a state entry with 1 fields");
		expect(() => textCodec.decode(new Uint8Array([...new TextEncoder().encode('["R",1]\n'), 1]))).toThrow(
			"byte segments without a payload",
		);
		expect(() => textCodec.decode(new TextEncoder().encode('["@",1,["@",2,["a"]]]'))).toThrow("wraps one message");
		expect(() => textCodec.decode(new TextEncoder().encode('["@",1]'))).toThrow("wraps one message");
	});

	it("refuses a hold without its address: every hold names one", () => {
		const decode = (tuple: string) => textCodec.decode(new TextEncoder().encode(tuple));
		expect(() => decode('["H",0,"t",1,"0123456789abcdef",[0,{}]]')).toThrow('a "H" message with 5 fields');
		expect(() => decode('["H",0,"t",1,"0123456789abcdef",[0,{}],null]')).toThrow("expected a list");
		expect(() => decode('["H",0,"t",1,"0123456789abcdef",[0,{}],["server"]]')).toThrow("an address is a pair");
		const hold = { kind: "hold", hold: 0, type: "t", version: 1, fingerprint: "0123456789abcdef", params: "{}" };
		expect(() => checkMessage(hold, context)).toThrow("message schema");
	});

	it("refuses a retry without its hop budget, or with one outside 1..16 (audit A5)", () => {
		const decode = (tuple: string) => textCodec.decode(new TextEncoder().encode(tuple));
		expect(() => decode('["T",2]')).toThrow('a "T" message with 1 fields');
		for (const hops of [0, 17]) {
			expect(() => checkMessage({ kind: "retry", hold: 2, hops }, context)).toThrow("message schema");
		}
	});
});

describe("describeMessage", () => {
	it("prints a message in the text tuple form", () => {
		expect(describeMessage({ kind: "abort", call: 7 })).toBe('["x",7]');
		expect(describeMessage({ kind: "result", call: 0, value: '{"$bytes":0}', segments: [new Uint8Array(3)] })).toBe(
			'["r",0,[0,{"$bytes":0}],[3]]',
		);
	});
});

describe("a codec mismatch", () => {
	it("decodes the other codec's hello as no message of its own", () => {
		const hello: Message = { kind: "hello", protocol: 1, incarnation, calls: 256 };
		expect(() => binaryCodec.decode(textCodec.encode(hello))).toThrow();
		expect(() => textCodec.decode(binaryCodec.encode(hello))).toThrow();
	});
});

describe("the binary codec's strings", () => {
	it("survive the buffer growing around them, at every offset near the initial size", () => {
		for (let length = 0; length < 400; length++) {
			// A long value of three-byte characters (filling what it reserved), then a short one that lands at every offset around the buffer's first growth.
			const members = [
				{ member: 0, value: jsonPart("€".repeat(length)) },
				{ member: 1, value: "1" },
			];
			const message: Message = { kind: "bound", holds: [{ hold: 1, granted: [], members, failed: [] }] };
			expect(plain(binaryCodec.decode(binaryCodec.encode(message)))).toEqual(message);
		}
	});
});

describe("the binary codec's medium strings", () => {
	/** A result message as bytes, built by hand: kind, call, payload flags, the part's doubled length, its UTF-8. */
	const expected = (text: string): number[] => {
		const bytes = new TextEncoder().encode(text);
		const prefix: number[] = [];
		for (let rest = bytes.byteLength * 2; ; rest = Math.floor(rest / 0x80)) {
			if (rest < 0x80) {
				prefix.push(rest);
				break;
			}
			prefix.push((rest % 0x80) | 0x80);
		}
		return [8, 0, 1, ...prefix, ...bytes];
	};

	it("are written behind their minimal length, at every length around a prefix's growth and the ASCII bound", () => {
		const lengths = [...Array.from({ length: 140 }, (_, index) => index), 4_094, 4_095];
		const texts = [
			...lengths.map((length) => "x".repeat(length)),
			// Below `LONG` (4,096 units) with the "é": from there a fixed five-byte prefix.
			...lengths.filter((length) => length < 4_095).map((length) => `${"x".repeat(length)}é`),
			...[2_729, 2_730, 2_731, 2_732, 4_095].map((length) => "€".repeat(length)),
			"\ud800 a lone surrogate",
		];
		for (const text of texts) {
			expect([...binaryCodec.encode({ kind: "result", call: 0, value: text })]).toEqual(expected(text));
		}
	});

	it("cost no more than a long one's per byte: 4,095 ASCII bytes take less than twice as long as 4,096", () => {
		const encode = (bytes: number) => {
			const message: Message = { kind: "result", call: 0, value: "a".repeat(bytes) };
			const start = performance.now();
			for (let index = 0; index < 2_000; index++) binaryCodec.encode(message);
			return performance.now() - start;
		};
		const medium: number[] = [];
		const long: number[] = [];
		for (let round = 0; round < 11; round++) {
			medium.push(encode(4_095));
			long.push(encode(4_096));
		}
		const median = (list: number[]) => list.sort((a, b) => a - b)[5]!;
		// Unit by unit (a loop over the text) this was 3 times as long; with an encoded copy 1.3 times.
		expect(median(medium) / median(long)).toBeLessThan(2);
	});
});

describe("the binary codec's long strings", () => {
	const texts = [
		["ASCII", "x".repeat(10_000)],
		["three-byte characters", "€".repeat(10_000)],
		["surrogate pairs", "😀".repeat(5_000)],
		["mixed, at the in-place threshold", `${"a".repeat(4_093)}😀€`],
		["a leading U+FEFF", `\uFEFF${"y".repeat(5_000)}`],
	];

	it.each(texts)("round-trip %s, encoded in place behind a padded length", (_, text) => {
		const message: Message = { kind: "result", call: 0, value: jsonPart(text) };
		const bytes = binaryCodec.encode(message);
		expect(plain(binaryCodec.decode(bytes))).toEqual(message);
		expect(bytes.buffer.byteLength - bytes.byteLength).toBeLessThanOrEqual(4096);
	});
});

describe("the binary codec's short strings", () => {
	it.each([0, 1, 41, 42, 43])("round-trip at %i three-byte characters, around the one-byte length", (length) => {
		const type = "€".repeat(length);
		const message: Message = {
			kind: "hold",
			hold: 0,
			type,
			version: 1,
			fingerprint: "0123456789abcdef",
			params: jsonPart(type),
			address: server,
		};
		expect(plain(binaryCodec.decode(binaryCodec.encode(message)))).toEqual(message);
	});
});

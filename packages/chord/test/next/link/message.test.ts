import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
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
} from "../../../src/next/link/internal.ts";
import type { Part } from "../../../src/next/link/part.ts";
import { forEachCodec, testCodec } from "../support.ts";

/** A part as JSON text: a received part's bytes decoded (a deflated part stays as it is). */
function partText(part: Part): Part {
	return part instanceof Uint8Array ? new TextDecoder().decode(part) : part;
}

const incarnation = "0190f5a2-7c3e-7d4a-9b1c-2d3e4f5a6b7c";
const error = { kind: "chord", error: { code: "released", message: "gone" } } as const;

/** One message of every kind, with the optional fields both present and absent; parts are JSON text. */
const EVERY_KIND: Message[] = [
	{ kind: "hello", protocol: 1, incarnation, calls: 256 },
	{ kind: "hold", hold: 300, type: "app.notes", version: 2, fingerprint: "0123456789abcdef", params: '{"id":1}' },
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
		incarnation,
	},
	{ kind: "release", hold: 0 },
	{ kind: "call", call: 3, hold: 0, method: 1, args: '{"text":"x"}' },
	{ kind: "call", call: 4, hold: 0, method: 0 },
	{ kind: "abort", call: 3 },
	{
		kind: "bound",
		holds: [{ hold: 0, variant: 1, members: [{ member: 0, value: '[1,"a"]' }], failed: [{ member: 1, error }] }],
	},
	{
		kind: "bound",
		holds: [
			{ hold: 0, variant: 0, members: [], failed: [] },
			{ hold: 5, variant: 2, members: [{ member: 1, value: "null" }], failed: [] },
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
	// The wire error format in `failed` and `gone`: a plugin's error travels too.
	{ kind: "failed", hold: 0, cause: { kind: "broken", error: { kind: "plugin", code: "config", message: "m" } } },
	{ kind: "gone", hold: 1, error: { kind: "plugin", code: "config", message: "m", details: { at: 1 } } },
	{
		kind: "failed",
		hold: 9,
		cause: { kind: "transient", error: { kind: "chord", error: { code: "unavailable", message: "m" } } },
		retryIn: 60_000,
	},
	{ kind: "retry", hold: 300 },
	{ kind: "loading", hold: 300 },
	{ kind: "result", call: 3, value: '{"n":1}' },
	{ kind: "result", call: 3 },
	{ kind: "error", call: 3, error: { kind: "plugin", code: "c", message: "m", details: [1] } },
	{ kind: "gone", hold: 0, error: { kind: "chord", error: { code: "released", message: "m" } } },
	{ kind: "ack" },
	{ kind: "ack", origin: 1 },
	{ kind: "closed", origin: 300 },
	{ kind: "hold", origin: 2, hold: 0, type: "t", version: 1, fingerprint: "0123456789abcdef", params: "{}" },
	{ kind: "release", origin: 2, hold: 3 },
	{ kind: "call", origin: 2, call: 1, hold: 3, method: 0, args: "[1]" },
	{ kind: "abort", origin: 2, call: 1 },
	{ kind: "retry", origin: 2, hold: 3 },
	{ kind: "bound", origin: 2, holds: [{ hold: 3, variant: 0, members: [], failed: [] }] },
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
		chain: [incarnation, incarnation],
		limit: 65_536,
	},
	{ kind: "hold", hold: 4, type: "t", version: 1, fingerprint: "0123456789abcdef", params: "{}", limit: 0 },
	{ kind: "revoke", revocation: { grant: "g1" } },
	{ kind: "ping" },
	{ kind: "pong" },
];

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
				{ kind: "hold", hold: 0, type: "t", version: 1, fingerprint: "0123456789abcdef", params: deflated() },
				{ kind: "call", call: 0, hold: 0, method: 0, args: deflated() },
				{ kind: "result", call: 0, value: deflated(), segments: [new Uint8Array([7])] },
				{
					kind: "bound",
					holds: [{ hold: 0, variant: 0, members: [{ member: 0, value: deflated() }], failed: [] }],
				},
				{ kind: "state", holds: [{ hold: 0, members: [{ member: 0, ops: deflated() }], failed: [], retired: [] }] },
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
				codec.decode(codec === binaryCodec ? new Uint8Array([99]) : new TextEncoder().encode('["?"]')),
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

		it("keep a leading U+FEFF in strings and parts (it is data, not a byte order mark)", () => {
			const codec = testCodec();
			const message: Message = {
				kind: "hold",
				hold: 0,
				type: "\uFEFFthing",
				version: 1,
				fingerprint: "0123456789abcdef",
				params: jsonPart({ "\uFEFFkey": "\uFEFFvalue" }),
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
		expect([...binaryCodec.encode({ kind: "release", hold: 300 })]).toEqual([2, 0xac, 0x02]);
		const hold = binaryCodec.encode({
			kind: "hold",
			hold: 0,
			type: "t",
			version: 1,
			fingerprint: "0123456789abcdef",
			params: "{}",
		});
		// kind, id, type, version, fingerprint, params, the optional fields' flags
		expect(hold).toHaveLength(1 + 1 + 2 + 1 + 8 + 3 + 1);
		expect([...binaryCodec.encode({ kind: "ack" })]).toEqual([13]);
		// An origin: the kind byte's high bit, then the origin as a varint.
		expect([...binaryCodec.encode({ kind: "ack", origin: 300 })]).toEqual([13 | 0x80, 0xac, 0x02]);
		expect([...binaryCodec.encode({ kind: "closed", origin: 1 })]).toEqual([14 | 0x80, 1]);
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

	it("refuses unknown hold flags", () => {
		const hold = binaryCodec.encode({
			kind: "hold",
			hold: 0,
			type: "t",
			version: 1,
			fingerprint: "0123456789abcdef",
			params: "{}",
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
		const bytes = binaryCodec.encode({ kind: "bound", holds: [{ hold: 0, variant: 0, members, failed: [] }] });
		expect(bytes.buffer.byteLength - bytes.byteLength).toBeLessThanOrEqual(4096);
		const small = binaryCodec.encode({ kind: "release", hold: 1 });
		expect(small.buffer.byteLength).toBe(small.byteLength);
		// A message of about two thirds of the starting buffer keeps no spare room either.
		const medium = binaryCodec.encode({ kind: "result", call: 0, value: jsonPart("x".repeat(160)) });
		expect(medium.buffer.byteLength).toBe(medium.byteLength);
	});

	it("refuses invalid UTF-8 in strings", () => {
		expect(() => binaryCodec.decode(new Uint8Array([1, 0, 1, 0xff]))).toThrow();
	});

	it("writes retry and loading as their kind and hold, and failed's retryIn as one more than it (0: absent)", () => {
		expect([...binaryCodec.encode({ kind: "retry", hold: 300 })]).toEqual([11, 0xac, 0x02]);
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
		expect(text({ kind: "bound", holds: [{ hold: 0, variant: 1, members, failed: [] }] })).toBe(
			'["b",[[0,1,[[0,[0,5]]]]]]',
		);
		expect(text({ kind: "retry", hold: 2 })).toBe('["T",2]');
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
		expect(text({ kind: "ack" })).toBe('["a"]');
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
		} as const;
		expect(text(hold)).toBe('["H",0,"t",1,"0123456789abcdef",[0,{}]]');
		expect(text({ ...hold, incarnation })).toBe(`["H",0,"t",1,"0123456789abcdef",[0,{}],null,null,"${incarnation}"]`);
		expect(text({ ...hold, limit: 5 })).toBe('["H",0,"t",1,"0123456789abcdef",[0,{}],null,null,null,null,5]');
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
			const message: Message = { kind: "bound", holds: [{ hold: 1, variant: 0, members, failed: [] }] };
			expect(plain(binaryCodec.decode(binaryCodec.encode(message)))).toEqual(message);
		}
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
		};
		expect(plain(binaryCodec.decode(binaryCodec.encode(message)))).toEqual(message);
	});
});

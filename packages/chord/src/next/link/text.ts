// The text codec (2b): one JSON tuple per message, Delta style (a short kind tag, positional fields, no field names),
// and `describeMessage`, which prints any message in that form. A part's JSON text is spliced into the tuple as it is;
// decoding parses the tuple and writes each part back as text (one parse per part per hop: a debugging codec). Byte
// segments of a payload marked as carrying bytes follow the tuple after a newline (JSON text never contains a raw
// one), their lengths the tuple's last field. A message with an origin is wrapped: `["@", origin, tuple]`. Every part
// is tagged with its codec, so no JSON value is reserved: `[0, json]`, or `[1, base64]` for a part its origin deflated
// (the text codec itself never compresses).

import {
	type BoundEntry,
	type Codec,
	type FailedMember,
	type Message,
	NO_RETIRED,
	type StateEntry,
} from "./message.ts";
import type { Part } from "./part.ts";
import { parseJson, partText, textPart } from "./values.ts";

const UTF8 = new TextEncoder();

/** Messages as JSON tuples: readable on the wire, for debugging links. */
export const textCodec: Codec = {
	name: "text",
	encode(message) {
		const json = UTF8.encode(tuple(message));
		const segments = segmentsOf(message);
		if (segments === undefined) return json;
		let length = json.byteLength + 1;
		for (const segment of segments) length += segment.byteLength;
		const bytes = new Uint8Array(length);
		bytes.set(json, 0);
		bytes[json.byteLength] = NEWLINE;
		let offset = json.byteLength + 1;
		for (const segment of segments) {
			bytes.set(segment, offset);
			offset += segment.byteLength;
		}
		return bytes;
	},
	decode(bytes) {
		const newline = bytes.indexOf(NEWLINE);
		const json = newline === -1 ? bytes : bytes.subarray(0, newline);
		const rest = newline === -1 ? bytes.subarray(bytes.byteLength) : bytes.subarray(newline + 1);
		const fields = parseJson(json);
		if (!Array.isArray(fields)) throw new Error("text: a message is a tuple");
		return fromTuple(fields, rest);
	},
};

/** A message in the text codec's tuple form, for logs and tests (byte segments show as `{"$bytes": i}`). */
export function describeMessage(message: Message): string {
	return tuple(message);
}

const NEWLINE = 0x0a;

/** The segments following a payload's tuple; `undefined` without a payload marked as carrying bytes. */
function segmentsOf(message: Message): readonly Uint8Array[] | undefined {
	return message.kind === "call" || message.kind === "result" ? message.segments : undefined;
}

/** The tuple's JSON text, parts spliced in; wrapped with its origin when it has one. */
function tuple(message: Message): string {
	const origin = "origin" in message ? message.origin : undefined;
	return origin === undefined ? ownTuple(message) : `["@",${origin},${ownTuple(message)}]`;
}

/** The tuple of a message's own fields. */
function ownTuple(message: Message): string {
	switch (message.kind) {
		case "hello":
			return json(["h", message.protocol, message.incarnation, message.calls]);
		case "hold": {
			const { address, principal, incarnation, chain, limit } = message;
			const head = json(["H", message.hold, message.type, message.version, message.fingerprint]).slice(0, -1);
			// Optional trailing fields: an absent one in the middle is null, absent ones at the end are left out.
			const optional = [
				address === undefined ? null : [address.kind, address.params],
				principal ?? null,
				incarnation ?? null,
				chain ?? null,
				limit ?? null,
			];
			while (optional.length > 0 && optional.at(-1) === null) optional.pop();
			const rest = optional.map((field) => `,${json(field)}`).join("");
			return `${head},${partText(message.params)}${rest}]`;
		}
		case "release":
			return json(["R", message.hold]);
		case "call":
			return withPayload(json(["c", message.call, message.hold, message.method]), message.args, message.segments);
		case "abort":
			return json(["x", message.call]);
		case "bound":
			return `["b",[${message.holds.map(boundEntry).join(",")}]]`;
		case "state":
			return `["s",[${message.holds.map(stateEntry).join(",")}]]`;
		case "failed": {
			const kind = message.cause.kind === "transient" ? "t" : "b";
			const retryIn = message.retryIn === undefined ? [] : [message.retryIn];
			return json(["f", message.hold, kind, message.cause.error, ...retryIn]);
		}
		case "result":
			return withPayload(json(["r", message.call]), message.value, message.segments);
		case "error":
			return json(["e", message.call, message.error]);
		case "gone":
			return json(["g", message.hold, message.error]);
		case "revoke":
			return json(["V", message.revocation]);
		case "retry":
			return json(["T", message.hold]);
		case "loading":
			return json(["l", message.hold]);
		case "ack":
			return json(["a"]);
		case "closed":
			return json(["C"]);
		case "ping":
			return json(["p"]);
		case "pong":
			return json(["P"]);
	}
}

function json(value: unknown): string {
	return JSON.stringify(value);
}

/** `[hold, variant, [[member, value]…], failed?]`. */
function boundEntry({ hold, variant, members, failed }: BoundEntry): string {
	const pairs = members.map(({ member, value }) => `[${member},${partText(value)}]`).join(",");
	return `[${hold},${variant},[${pairs}]${failedField(failed)}]`;
}

/** `[hold, [[member, ops]…], failed?, retired?]`; `failed` is `[]` when only `retired` follows. */
function stateEntry({ hold, members, failed, retired }: StateEntry): string {
	const pairs = members.map(({ member, ops }) => `[${member},${partText(ops)}]`).join(",");
	if (retired.length === 0) return `[${hold},[${pairs}]${failedField(failed)}]`;
	return `[${hold},[${pairs}],${json(failed.map(({ member, error }) => [member, error]))},${json(retired)}]`;
}

/** The failures as an entry's optional last field: left out when there are none. */
function failedField(failed: readonly FailedMember[]): string {
	return failed.length === 0 ? "" : `,${json(failed.map(({ member, error }) => [member, error]))}`;
}

/**
 * A tuple (its closed JSON `head`) ending in a payload part; one marked as carrying bytes adds the segments' lengths
 * as the last field.
 */
function withPayload(head: string, part: Part | undefined, segments: readonly Uint8Array[] | undefined): string {
	if (part === undefined) return head;
	const prefix = `${head.slice(0, -1)},${partText(part)}`;
	if (segments === undefined) return `${prefix}]`;
	return `${prefix},${json(segments.map((segment) => segment.byteLength))}]`;
}

/**
 * A message from its tuple: the tag and arity checked, lists of pairs checked as lists, parts written back as text;
 * the field types are the message schema's to check. `rest` holds the segments, which only a payload marked as
 * carrying bytes may have.
 */
function fromTuple(fields: unknown[], rest: Uint8Array): Message {
	if (fields[0] !== "@") return fromFields(fields, rest);
	const inner = fields.length === 3 ? list(fields[2]) : [];
	if (inner[0] === "@" || inner.length === 0) throw new Error("text: an origin wraps one message");
	const message = fromFields(inner, rest);
	// A fresh object; the message schema checks the origin and refuses one on a kind without it.
	(message as { origin?: unknown }).origin = fields[1];
	return message;
}

/** A message from its own fields' tuple (see `fromTuple`). */
function fromFields(fields: unknown[], rest: Uint8Array): Message {
	const [tag, ...f] = fields;
	const arity = (...allowed: number[]): void => {
		if (!allowed.includes(f.length)) throw new Error(`text: a "${String(tag)}" message with ${f.length} fields`);
	};
	if (tag !== "c" && tag !== "r" && rest.byteLength > 0) {
		throw new Error("text: byte segments without a payload that carries them");
	}
	// The message schema establishes the types of the fields taken here.
	const field = <T>(index: number): T => f[index] as T;
	switch (tag) {
		case "h":
			arity(3);
			return { kind: "hello", protocol: field(0), incarnation: field(1), calls: field(2) };
		case "H": {
			arity(5, 6, 7, 8, 9, 10);
			const [address, principal, incarnation, chain, limit] = [5, 6, 7, 8, 9].map((index) => f[index] ?? null);
			let wireAddress = {};
			if (address !== null) {
				const pair = list(address);
				if (pair.length !== 2) throw new Error("text: an address is a pair");
				wireAddress = { address: { kind: pair[0], params: pair[1] } };
			}
			return {
				kind: "hold",
				hold: field(0),
				type: field(1),
				version: field(2),
				fingerprint: field(3),
				params: textPart(f[4]),
				...wireAddress,
				...(principal === null ? {} : { principal: principal as { kind: string } }),
				...(incarnation === null ? {} : { incarnation: incarnation as string }),
				...(chain === null ? {} : { chain: chain as string[] }),
				...(limit === null ? {} : { limit: limit as number }),
			};
		}
		case "R":
			arity(1);
			return { kind: "release", hold: field(0) };
		case "c":
			arity(3, 4, 5);
			return {
				kind: "call",
				call: field(0),
				hold: field(1),
				method: field(2),
				...payload("args", f.slice(3), rest),
			};
		case "x":
			arity(1);
			return { kind: "abort", call: field(0) };
		case "b":
			arity(1);
			return {
				kind: "bound",
				holds: list(f[0]).map((entry): BoundEntry => {
					const fields = list(entry);
					if (fields.length !== 3 && fields.length !== 4) {
						throw new Error(`text: a bound entry with ${fields.length} fields`);
					}
					const [hold, variant, members, failed] = fields;
					return {
						hold: hold as number,
						variant: variant as number,
						members: pairs(members).map(([member, value]) => ({
							member: member as number,
							value: textPart(value),
						})),
						failed: failures(failed),
					};
				}),
			};
		case "s":
			arity(1);
			return {
				kind: "state",
				holds: list(f[0]).map((entry): StateEntry => {
					const fields = list(entry);
					if (fields.length < 2 || fields.length > 4) {
						throw new Error(`text: a state entry with ${fields.length} fields`);
					}
					const [hold, members, failed, retired] = fields;
					return {
						hold: hold as number,
						members: pairs(members).map(([member, ops]) => ({ member: member as number, ops: textPart(ops) })),
						failed: failures(failed),
						// The message schema checks each index.
						retired: retired === undefined ? NO_RETIRED : (list(retired) as number[]),
					};
				}),
			};
		case "f": {
			arity(3, 4);
			if (f[1] !== "t" && f[1] !== "b") throw new Error("text: an unknown failure kind");
			// The schema check after decoding establishes the wire error.
			const error = f[2] as Extract<Message, { kind: "error" }>["error"];
			const cause = { kind: f[1] === "t" ? "transient" : "broken", error } as const;
			return { kind: "failed", hold: field(0), cause, ...(f.length === 4 ? { retryIn: field<number>(3) } : {}) };
		}
		case "r":
			arity(1, 2, 3);
			return { kind: "result", call: field(0), ...payload("value", f.slice(1), rest) };
		case "e":
			arity(2);
			return { kind: "error", call: field(0), error: field(1) };
		case "g":
			arity(2);
			return { kind: "gone", hold: field(0), error: field(1) };
		case "V":
			arity(1);
			return { kind: "revoke", revocation: f[0] };
		case "T":
			arity(1);
			return { kind: "retry", hold: field(0) };
		case "l":
			arity(1);
			return { kind: "loading", hold: field(0) };
		case "a":
			arity(0);
			return { kind: "ack" };
		case "C":
			arity(0);
			// Its origin is the wrapper's; 0 without one, which the message schema refuses.
			return { kind: "closed", origin: 0 };
		case "p":
			arity(0);
			return { kind: "ping" };
		case "P":
			arity(0);
			return { kind: "pong" };
		default:
			throw new Error("text: an unknown kind");
	}
}

/**
 * A payload part from its fields: none, the value, or the value and its segments' lengths (marked as carrying bytes,
 * the segments views of `rest`).
 */
function payload<K extends string>(
	key: K,
	fields: unknown[],
	rest: Uint8Array,
): { [P in K]?: Part } & { segments?: Uint8Array[] } {
	if (fields.length < 2) {
		if (rest.byteLength > 0) throw new Error("text: byte segments without a payload that carries them");
		return (fields.length === 0 ? {} : { [key]: textPart(fields[0]) }) as { [P in K]?: Part };
	}
	const lengths = list(fields[1]);
	let offset = 0;
	const segments = lengths.map((length) => {
		if (!Number.isSafeInteger(length) || (length as number) < 0) throw new Error("text: a segment length");
		const segment = rest.subarray(offset, offset + (length as number));
		offset += length as number;
		return segment;
	});
	if (offset !== rest.byteLength) throw new Error("text: the segments do not fill the message");
	return { [key]: textPart(fields[0]), segments } as { [P in K]?: Part } & { segments: Uint8Array[] };
}

function list(value: unknown): unknown[] {
	if (!Array.isArray(value)) throw new Error("text: expected a list");
	return value;
}

/** A list of `[index, value]` pairs. */
function pairs(value: unknown): [unknown, unknown][] {
	return list(value).map((pair) => {
		const entry = list(pair);
		if (entry.length !== 2) throw new Error("text: expected a pair");
		return entry as [unknown, unknown];
	});
}

/** The optional failures field; absent means none. */
function failures(value: unknown): FailedMember[] {
	if (value === undefined) return [];
	// The message schema checks each error's shape.
	return pairs(value).map(([member, error]) => ({ member, error }) as FailedMember);
}

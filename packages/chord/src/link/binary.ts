// The binary codec (2b): a kind byte (its high bit set when an origin follows as a varint, the next one when a trace
// carrier follows as JSON, slice 9, the third for a `call`'s old-work flag and an event `ack`), then the kind's fields
// as unsigned varints, length-prefixed UTF-8 strings, raw incarnation (16 bytes) and fingerprint (8 bytes), parts as
// length-prefixed bytes whose prefix also says whether the part is deflated (decoded as views of the message, never
// parsed or inflated here), and byte segments only beside payloads marked as carrying bytes. No outer length: links
// deliver whole messages.

import {
	type BoundEntry,
	CAUSE_KINDS,
	type Codec,
	type FailedMember,
	type Message,
	NO_RETIRED,
	type StateEntry,
} from "./message.ts";
import { DeflatedPart, type Part } from "./part.ts";
import { parseJson, readUtf8 } from "./values.ts";

const UTF8 = new TextEncoder();

/** Kinds by their byte. */
const KINDS = [
	"hello",
	"hold",
	"release",
	"call",
	"abort",
	"bound",
	"state",
	"failed",
	"result",
	"error",
	"gone",
	"retry",
	"loading",
	"ack",
	"closed",
	"ping",
	"pong",
	"revoke",
	"event",
] as const;

const KIND_BYTES = new Map<string, number>(KINDS.map((kind, byte) => [kind, byte]));

/** The kind byte's flag for an origin. */
const ORIGIN = 0x80;

/** The kind byte's flag for a trace carrier (a `hold`'s or `call`'s; the message schema refuses it elsewhere). */
const TRACE = 0x40;

/**
 * The kind byte's third flag: on a `call`, old work of a reload (`call.old`); on an `ack`, an event ack, its count
 * following (so a state ack stays one byte); another kind with it is unknown.
 */
const OLD = 0x20;

/** A payload's flags: present, and carrying byte segments. */
const PRESENT = 1;

const SEGMENTS = 2;

/** A hold's optional fields, one bit each. */
const PRINCIPAL = 1;

const INCARNATION = 2;

const CHAIN = 4;

const LIMIT = 8;

/** A part's length prefix is its length doubled, plus one when the part is deflated. */
const DEFLATED = 1;

/** Messages as bytes; the default codec of every link. */
export const binaryCodec: Codec = {
	name: "binary",
	encode(message) {
		// The idle writer and its buffer, reused; an encode inside an encode (a `toJSON` that sends) makes its own.
		const writer = idle ?? new Writer();
		idle = undefined;
		try {
			encodeMessage(message, writer);
			return writer.finish();
		} finally {
			writer.reset();
			idle = writer;
		}
	},
	decode(bytes) {
		const reader = new Reader(bytes);
		const byte = reader.byte();
		const kind = KINDS[byte & ~(ORIGIN | TRACE | OLD)];
		if (kind === undefined || (byte & OLD && kind !== "call" && kind !== "ack"))
			throw new Error("binary: an unknown kind");
		const origin = byte & ORIGIN ? reader.varint() : undefined;
		const trace = byte & TRACE ? reader.json() : undefined;
		const message = kind === "ack" && byte & OLD ? { kind, events: reader.varint() } : decodeFields(kind, reader);
		reader.end();
		// A fresh object; the message schema refuses an origin or a trace on a kind without one, and checks the trace.
		if (origin !== undefined) (message as { origin?: number }).origin = origin;
		if (trace !== undefined) (message as { trace?: unknown }).trace = trace;
		if (kind === "call" && byte & OLD) (message as { old?: true }).old = true;
		return message;
	},
};

/**
 * The writer no encode uses now, with its buffer: encoding into one buffer kept across messages costs a message one
 * right-sized copy, where a fresh zeroed buffer per message and its copy cost 2.5 KiB per held object (`hot-paths.ts`,
 * case 1) and made an encode 3.5 times as slow. It keeps no message: `finish` copies or hands its buffer off, and
 * `reset` drops a grown one.
 */
let idle: Writer | undefined;

/** Writes `message` with `writer`: its kind byte with its flags, its origin and trace, then its fields. */
function encodeMessage(message: Message, writer: Writer): void {
	// Encoded on any kind: the message schema, after decoding, refuses an origin on a kind that has none.
	const origin = (message as { readonly origin?: number }).origin;
	const trace = message.kind === "hold" || message.kind === "call" ? message.trace : undefined;
	const old =
		(message.kind === "call" && message.old === true) || (message.kind === "ack" && message.events !== undefined)
			? OLD
			: 0;
	writer.byte(
		KIND_BYTES.get(message.kind)! | (origin === undefined ? 0 : ORIGIN) | (trace === undefined ? 0 : TRACE) | old,
	);
	if (origin !== undefined) writer.varint(origin);
	if (trace !== undefined) writer.json(trace);
	encodeFields(message, writer);
}

function encodeFields(message: Message, writer: Writer): void {
	switch (message.kind) {
		case "hello":
			writer.varint(message.protocol);
			writer.uuid(message.incarnation);
			// 0 when absent: no window (a window is at least 1).
			writer.varint(message.calls ?? 0);
			return;
		case "hold": {
			writer.varint(message.hold);
			writer.string(message.type);
			writer.varint(message.version);
			writer.hex(message.fingerprint, 8);
			writer.part(message.params);
			const { address, principal, incarnation, chain, limit } = message;
			writer.string(address.kind);
			writer.json(address.params);
			writer.byte(
				(principal === undefined ? 0 : PRINCIPAL) |
					(incarnation === undefined ? 0 : INCARNATION) |
					(chain === undefined ? 0 : CHAIN) |
					(limit === undefined ? 0 : LIMIT),
			);
			if (principal !== undefined) writer.json(principal);
			if (incarnation !== undefined) writer.uuid(incarnation);
			if (chain !== undefined) {
				writer.varint(chain.length);
				for (const instance of chain) writer.uuid(instance);
			}
			if (limit !== undefined) writer.varint(limit);
			return;
		}
		case "release":
		case "loading":
			writer.varint(message.hold);
			return;
		case "retry":
			writer.varint(message.hold);
			writer.varint(message.hops);
			return;
		case "call":
			writer.varint(message.call);
			writer.varint(message.hold);
			writer.varint(message.method);
			writer.payload(message.args, message.segments);
			return;
		case "abort":
			writer.varint(message.call);
			return;
		case "bound":
			writer.varint(message.holds.length);
			for (const { hold, granted, members, failed } of message.holds) {
				writer.varint(hold);
				writer.varint(granted.length);
				for (const name of granted) writer.varint(name);
				writer.varint(members.length);
				for (const { member, value } of members) {
					writer.varint(member);
					writer.part(value);
				}
				writer.failed(failed);
			}
			return;
		case "state":
			writer.varint(message.holds.length);
			for (const { hold, members, failed, retired } of message.holds) {
				writer.varint(hold);
				writer.varint(members.length);
				for (const { member, ops } of members) {
					writer.varint(member);
					writer.part(ops);
				}
				writer.failedAndRetired(failed, retired);
			}
			return;
		case "failed":
			writer.varint(message.hold);
			writer.byte(CAUSE_KINDS.indexOf(message.cause.kind));
			writer.json(message.cause.error);
			// 0 when absent, else one more than the delay.
			writer.varint(message.retryIn === undefined ? 0 : message.retryIn + 1);
			return;
		case "result":
			writer.varint(message.call);
			writer.payload(message.value, message.segments);
			return;
		case "error":
			writer.varint(message.call);
			writer.json(message.error);
			return;
		case "gone":
			writer.varint(message.hold);
			writer.json(message.error);
			return;
		case "revoke":
			writer.json(message.revocation);
			return;
		case "event":
			writer.varint(message.events.length);
			for (const { hold, member, at, value } of message.events) {
				writer.varint(hold);
				writer.varint(member);
				writer.varint(at);
				writer.part(value);
			}
			return;
		case "ack":
			// An event ack's count (the kind byte's flag says it follows); a state ack has no field.
			if (message.events !== undefined) writer.varint(message.events);
			return;
		case "closed":
		case "ping":
		case "pong":
			return;
	}
}

/** The kind's fields, read structurally; the envelope's types are checked by the message schema afterwards. */
function decodeFields(kind: (typeof KINDS)[number], reader: Reader): Message {
	// The message schema establishes the types of what is read here (JSON fields are checked by it).
	switch (kind) {
		case "hello": {
			const protocol = reader.varint();
			const incarnation = reader.uuid();
			const calls = reader.varint();
			return { kind, protocol, incarnation, ...(calls === 0 ? {} : { calls }) };
		}
		case "hold": {
			const hold = reader.varint();
			const type = reader.string();
			const version = reader.varint();
			const fingerprint = reader.fingerprint();
			const params = reader.part();
			const address = { kind: reader.string(), params: reader.json() };
			const flags = reader.byte();
			if (flags > (PRINCIPAL | INCARNATION | CHAIN | LIMIT)) throw new Error("binary: unknown hold flags");
			// The optional fields set in place, in their order: no object per absent field to spread.
			const message: Writable<Extract<Message, { kind: "hold" }>> = {
				kind,
				hold,
				type,
				version,
				fingerprint,
				params,
				address,
			};
			if (flags & PRINCIPAL) message.principal = reader.json() as { kind: string };
			if (flags & INCARNATION) message.incarnation = reader.uuid();
			if (flags & CHAIN) message.chain = reader.list(readUuid);
			if (flags & LIMIT) message.limit = reader.varint();
			return message;
		}
		case "release":
		case "loading":
			return { kind, hold: reader.varint() };
		case "retry":
			return { kind, hold: reader.varint(), hops: reader.varint() };
		case "call": {
			const message: Writable<Extract<Message, { kind: "call" }>> = {
				kind,
				call: reader.varint(),
				hold: reader.varint(),
				method: reader.varint(),
			};
			reader.payload(message, "args");
			return message;
		}
		case "abort":
			return { kind, call: reader.varint() };
		case "bound": {
			const holds = reader.list(readBoundEntry);
			return { kind, holds };
		}
		case "state": {
			const holds = reader.list(readStateEntry);
			return { kind, holds };
		}
		case "failed": {
			const hold = reader.varint();
			const cause = CAUSE_KINDS[reader.byte()];
			if (cause === undefined) throw new Error("binary: an unknown failure kind");
			// The schema check after decoding establishes the wire error.
			const error = reader.json() as Extract<Message, { kind: "error" }>["error"];
			const retryIn = reader.varint();
			const message: Writable<Extract<Message, { kind: "failed" }>> = { kind, hold, cause: { kind: cause, error } };
			if (retryIn !== 0) message.retryIn = retryIn - 1;
			return message;
		}
		case "result": {
			const message: Writable<Extract<Message, { kind: "result" }>> = { kind, call: reader.varint() };
			reader.payload(message, "value");
			return message;
		}
		case "error":
			return { kind, call: reader.varint(), error: reader.json() as Extract<Message, { kind: "error" }>["error"] };
		case "gone":
			return { kind, hold: reader.varint(), error: reader.json() as Extract<Message, { kind: "error" }>["error"] };
		case "revoke":
			return { kind, revocation: reader.json() };
		case "event": {
			const events = reader.list((reader) => ({
				hold: reader.varint(),
				member: reader.varint(),
				at: reader.varint(),
				value: reader.part(),
			}));
			return { kind, events };
		}
		case "ack":
		case "ping":
		case "pong":
			return { kind };
		case "closed":
			// Its origin is the kind byte's; 0 without one, which the message schema refuses.
			return { kind, origin: 0 };
	}
}

/** A message's fields, set while it is decoded. */
type Writable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * The readers of a list's elements: module functions taking the reader, so a list costs no closure per decode (lists
 * are read for every `bound`, `state` and `event`).
 */
function readVarint(reader: Reader): number {
	return reader.varint();
}

function readUuid(reader: Reader): string {
	return reader.uuid();
}

function readBoundEntry(reader: Reader): BoundEntry {
	const hold = reader.varint();
	const granted = reader.list(readVarint);
	const members = reader.list(readBoundMember);
	return { hold, granted, members, failed: reader.failed() };
}

function readBoundMember(reader: Reader): BoundEntry["members"][number] {
	return { member: reader.varint(), value: reader.part() };
}

function readStateEntry(reader: Reader): StateEntry {
	const hold = reader.varint();
	const members = reader.list(readStateMember);
	// The failure count times two, plus one when retirements follow.
	const flags = reader.varint();
	const failed = reader.failedEntries(Math.floor(flags / 2));
	const retired = flags % 2 === 0 ? NO_RETIRED : reader.list(readVarint);
	return { hold, members, failed, retired };
}

function readStateMember(reader: Reader): StateEntry["members"][number] {
	return { member: reader.varint(), ops: reader.part() };
}

function readFailedMember(reader: Reader): FailedMember {
	// The message schema checks each error's shape.
	return { member: reader.varint(), error: reader.json() as FailedMember["error"] };
}

/** Up to this many UTF-16 units a string takes at most 126 bytes, so its length is one varint byte. */
const SHORT = 42;

/** From this many UTF-16 units a string is encoded in place (below it, encoding on its own and copying is cheaper). */
const LONG = 4096;

/** The fixed length prefix of a long string: five varint bytes, up to 32 GiB (16 GiB for a part). */
const LENGTH_SLOT = 5;

/** The room left after a large chunk for the fields that follow it. */
const SPARE = 4096;

const DASH = 0x2d;

/** The buffer a writer starts with and keeps across messages: most messages fit (a hold, a `bound`, a state change). */
const BASE = 4096;

/** Writes messages, one at a time, into one growing buffer; each right-sized at its end. */
class Writer {
	#buffer = new Uint8Array(BASE);
	#length = 0;

	byte(byte: number): void {
		this.#reserve(1);
		this.#buffer[this.#length++] = byte;
	}

	/** An unsigned LEB128 varint of a safe integer. */
	varint(value: number): void {
		this.#reserve(8);
		let rest = value;
		while (rest >= 0x80) {
			this.#buffer[this.#length++] = (rest % 0x80) | 0x80;
			rest = Math.floor(rest / 0x80);
		}
		this.#buffer[this.#length++] = rest;
	}

	raw(bytes: Uint8Array): void {
		this.#reserve(bytes.byteLength);
		this.#buffer.set(bytes, this.#length);
		this.#length += bytes.byteLength;
	}

	/**
	 * `text`, lowercase hex of `length` bytes (a fingerprint), as those bytes. Throws on anything else. Read digit by
	 * digit into the buffer: a pattern test and an array per call cost more than the message's other fields.
	 */
	hex(text: string, length: number): void {
		if (text.length !== length * 2) throw notHex(length);
		this.#reserve(length);
		for (let index = 0; index < length; index++) {
			const high = digit(text.charCodeAt(index * 2));
			const low = digit(text.charCodeAt(index * 2 + 1));
			if (high < 0 || low < 0) throw notHex(length);
			this.#buffer[this.#length + index] = high * 16 + low;
		}
		this.#length += length;
	}

	/**
	 * A UUID (an incarnation) as its 16 bytes: its lowercase hex digits with every dash left out wherever it is, 32 of
	 * them. Throws on anything else.
	 */
	uuid(text: string): void {
		this.#reserve(16);
		let digits = 0;
		let high = 0;
		for (let index = 0; index < text.length; index++) {
			const unit = text.charCodeAt(index);
			if (unit === DASH) continue;
			const value = digit(unit);
			if (value < 0 || digits === 32) throw notHex(16);
			if (digits % 2 === 0) high = value;
			else this.#buffer[this.#length + (digits >> 1)] = high * 16 + value;
			digits++;
		}
		if (digits !== 32) throw notHex(16);
		this.#length += 16;
	}

	/** A length-prefixed UTF-8 string (`#text`). */
	string(text: string): void {
		this.#text(text, 1);
	}

	json(value: unknown): void {
		this.string(JSON.stringify(value) ?? "null");
	}

	/**
	 * A part: its text encoded in place, or its bytes (a part received) copied as they are, behind its length doubled,
	 * plus one when deflated.
	 */
	part(part: Part): void {
		if (typeof part === "string") {
			this.#text(part, 2);
			return;
		}
		const bytes = part instanceof DeflatedPart ? part.bytes : part;
		this.varint(bytes.byteLength * 2 + (part instanceof DeflatedPart ? DEFLATED : 0));
		this.raw(bytes);
	}

	/**
	 * Text behind its UTF-8 length times `scale` (2 for a part's prefix), encoded straight into the buffer where the
	 * prefix is known in advance: a short text (its prefix fits one byte: at most 126 bytes, 42 UTF-16 units, divided
	 * by `scale`) and a long one (a snapshot's JSON, behind a fixed five-byte prefix, a padded varint, which readers
	 * accept). Others are encoded on their own and copied in. No text is encoded twice, and the largest value of a
	 * message is never copied.
	 */
	#text(text: string, scale: 1 | 2): void {
		if (text.length < LONG) {
			// ASCII (most names and JSON) is its own UTF-8, its length known: written unit by unit.
			const start = this.#length;
			this.varint(text.length * scale);
			if (this.#ascii(text)) return;
			this.#length = start;
		}
		if (text.length <= SHORT / scale) {
			this.#reserve(1 + text.length * 3);
			const { written } = UTF8.encodeInto(text, this.#buffer.subarray(this.#length + 1));
			this.#buffer[this.#length] = written * scale;
			this.#length += 1 + written;
			return;
		}
		if (text.length < LONG) {
			const bytes = UTF8.encode(text);
			this.varint(bytes.byteLength * scale);
			this.raw(bytes);
			return;
		}
		const slot = this.#length;
		// At least one byte per UTF-16 unit; more room is made when the text is not all ASCII.
		this.#reserve(LENGTH_SLOT + text.length);
		this.#length += LENGTH_SLOT;
		let read = 0;
		while (read < text.length) {
			const rest = read === 0 ? text : text.slice(read);
			const done = UTF8.encodeInto(rest, this.#buffer.subarray(this.#length));
			read += done.read;
			this.#length += done.written;
			if (read < text.length) this.#reserve(Math.max((text.length - read) * 2, 4));
		}
		let length = (this.#length - slot - LENGTH_SLOT) * scale;
		for (let index = 0; index < LENGTH_SLOT; index++) {
			this.#buffer[slot + index] = (length % 0x80) | (index < LENGTH_SLOT - 1 ? 0x80 : 0);
			length = Math.floor(length / 0x80);
		}
	}

	/**
	 * `text`'s units as bytes when all are ASCII; otherwise nothing written (whatever it wrote is past the length) and
	 * `false`. No view of the buffer per string, as `encodeInto` needs (0.5 KiB per held object).
	 */
	#ascii(text: string): boolean {
		const units = text.length;
		this.#reserve(units);
		const buffer = this.#buffer;
		const at = this.#length;
		for (let index = 0; index < units; index++) {
			const unit = text.charCodeAt(index);
			if (unit >= 0x80) return false;
			buffer[at + index] = unit;
		}
		this.#length = at + units;
		return true;
	}

	/** A payload: its flags, then its part and, when marked, its segments (count, lengths, raw bytes). */
	payload(part: Part | undefined, segments: readonly Uint8Array[] | undefined): void {
		if (part === undefined) {
			this.varint(0);
			return;
		}
		this.varint(segments === undefined ? PRESENT : PRESENT | SEGMENTS);
		this.part(part);
		if (segments === undefined) return;
		this.varint(segments.length);
		for (const segment of segments) this.varint(segment.byteLength);
		for (const segment of segments) this.raw(segment);
	}

	failed(failed: readonly FailedMember[]): void {
		this.varint(failed.length);
		this.#failedEntries(failed);
	}

	/**
	 * A state entry's failures and retirements: the failure count times two, plus one when retirements follow, so an
	 * entry without retirements costs no byte more than its failures.
	 */
	failedAndRetired(failed: readonly FailedMember[], retired: readonly number[]): void {
		this.varint(failed.length * 2 + (retired.length > 0 ? 1 : 0));
		this.#failedEntries(failed);
		if (retired.length === 0) return;
		this.varint(retired.length);
		for (const member of retired) this.varint(member);
	}

	#failedEntries(failed: readonly FailedMember[]): void {
		for (const { member, error } of failed) {
			this.varint(member);
			this.json(error);
		}
	}

	/**
	 * The message: a right-sized copy, or for a message that grew the buffer and fills it but for a little (less than
	 * 64 bytes or an eighth of the message) a view of it, handed off: a large message ends within its 4 KiB of room and
	 * is not copied, and the writer takes a new buffer (`reset`).
	 */
	finish(): Uint8Array {
		const buffer = this.#buffer;
		const spare = buffer.byteLength - this.#length;
		if (buffer.byteLength === BASE || (spare >= 64 && spare * 8 > this.#length)) return buffer.slice(0, this.#length);
		return buffer.subarray(0, this.#length);
	}

	/** Ready for the next message: empty, with a base buffer again when this one grew (it is not kept past its message). */
	reset(): void {
		this.#length = 0;
		if (this.#buffer.byteLength !== BASE) this.#buffer = new Uint8Array(BASE);
	}

	/** Grows the buffer to fit `bytes` more: doubled, or for a large chunk to its end plus room for the small fields after it. */
	#reserve(bytes: number): void {
		if (this.#length + bytes <= this.#buffer.byteLength) return;
		const grown = new Uint8Array(Math.max(this.#buffer.byteLength * 2, this.#length + bytes + SPARE));
		grown.set(this.#buffer.subarray(0, this.#length));
		this.#buffer = grown;
	}
}

/** Reads a message's bytes; every read is bounds-checked, segments are views of the message. */
class Reader {
	readonly #bytes: Uint8Array;
	#offset = 0;

	constructor(bytes: Uint8Array) {
		this.#bytes = bytes;
	}

	byte(): number {
		const byte = this.#bytes[this.#offset];
		if (byte === undefined) throw new Error("binary: the message ends early");
		this.#offset++;
		return byte;
	}

	/** An unsigned LEB128 varint of at most 8 bytes, at most a safe integer. */
	varint(): number {
		let value = 0;
		let scale = 1;
		for (let read = 1; ; read++) {
			if (read > 8) throw new Error("binary: a varint does not fit");
			const byte = this.byte();
			value += (byte & 0x7f) * scale;
			if (value > Number.MAX_SAFE_INTEGER) throw new Error("binary: a varint does not fit");
			if (byte < 0x80) return value;
			scale *= 0x80;
		}
	}

	raw(length: number): Uint8Array {
		const at = this.#skip(length);
		return this.#bytes.subarray(at, at + length);
	}

	string(): string {
		return readUtf8(this.raw(this.varint()));
	}

	/** 8 bytes (a fingerprint) as lowercase hex, read in place (no view per field). */
	fingerprint(): string {
		const at = this.#skip(8);
		return hexText(this.#bytes, at);
	}

	/** 16 bytes as a UUID's text, read in place. */
	uuid(): string {
		const at = this.#skip(16);
		return uuid(this.#bytes, at);
	}

	/** The offset of the next `length` bytes, which it passes. */
	#skip(length: number): number {
		if (length > this.#bytes.byteLength - this.#offset) throw new Error("binary: the message ends early");
		const at = this.#offset;
		this.#offset += length;
		return at;
	}

	json(): unknown {
		return parseJson(this.raw(this.varint()));
	}

	/** A part as a view of the message, unparsed and not inflated. */
	part(): Uint8Array | DeflatedPart {
		const prefix = this.varint();
		const bytes = this.raw(Math.floor(prefix / 2));
		return prefix % 2 === DEFLATED ? new DeflatedPart(bytes) : bytes;
	}

	/** A list: its count (each element takes at least a byte, so it cannot pass the message's end), then its elements. */
	list<T>(read: (reader: Reader) => T): T[] {
		return this.#elements(this.varint(), read);
	}

	/**
	 * `count` elements, pushed: a packed list as `Array.from` made it (a list made at its length has holes to its
	 * readers' code), without its array-like and its calls.
	 */
	#elements<T>(count: number, read: (reader: Reader) => T): T[] {
		if (count > this.#bytes.byteLength - this.#offset) throw new Error("binary: a count does not fit");
		// Most lists hold none or one: as literals they have no slack (a first `push` reserves 17 slots).
		if (count === 0) return [];
		if (count === 1) return [read(this)];
		const list: T[] = [];
		for (let index = 0; index < count; index++) list.push(read(this));
		return list;
	}

	/**
	 * A payload part set on `message` under `key`, left absent when not present, with its segments when marked as
	 * carrying them.
	 */
	payload<K extends string>(message: { [P in K]?: Part } & { segments?: readonly Uint8Array[] }, key: K): void {
		const flags = this.varint();
		if (flags === 0) return;
		if (flags !== PRESENT && flags !== (PRESENT | SEGMENTS)) throw new Error("binary: unknown payload flags");
		// A key of the message's own payload field.
		(message as Record<K, Part>)[key] = this.part();
		if (flags === PRESENT) return;
		const lengths = this.list(readVarint);
		message.segments = lengths.map((length) => this.raw(length));
	}

	failed(): FailedMember[] {
		return this.failedEntries(this.varint());
	}

	/** `count` failed members, as `Writer.failed` writes them after their count. */
	failedEntries(count: number): FailedMember[] {
		return this.#elements(count, readFailedMember);
	}

	/** The message is consumed exactly. */
	end(): void {
		if (this.#offset !== this.#bytes.byteLength) throw new Error("binary: bytes after the message");
	}
}

/** A lowercase hex digit's value; -1 for any other unit. */
function digit(unit: number): number {
	if (unit >= 0x30 && unit <= 0x39) return unit - 0x30;
	if (unit >= 0x61 && unit <= 0x66) return unit - 0x57;
	return -1;
}

function notHex(length: number): Error {
	return new Error(`binary: not ${length} bytes of hex`);
}

/** The ASCII of the lowercase hex digits. */
const DIGITS = UTF8.encode("0123456789abcdef");

/**
 * Where decoded hex is spelled out before it is read as one string (a flat one: no array, join or concatenation per
 * fingerprint or incarnation); one decode at a time uses them.
 */
const FINGERPRINT_TEXT = new Uint8Array(16);

const UUID_TEXT = UTF8.encode("00000000-0000-0000-0000-000000000000");

/** The 8 bytes of `bytes` from `at` (a fingerprint) as lowercase hex. */
function hexText(bytes: Uint8Array, at: number): string {
	for (let index = 0; index < 8; index++) {
		const byte = bytes[at + index]!;
		FINGERPRINT_TEXT[index * 2] = DIGITS[byte >> 4]!;
		FINGERPRINT_TEXT[index * 2 + 1] = DIGITS[byte & 15]!;
	}
	return readUtf8(FINGERPRINT_TEXT);
}

/** Where each of a UUID's 16 bytes is spelled in its text: two digits, after its dashes. */
const UUID_AT = [0, 2, 4, 6, 9, 11, 14, 16, 19, 21, 24, 26, 28, 30, 32, 34];

/** The 16 bytes of `bytes` from `at` as a UUID's text. */
function uuid(bytes: Uint8Array, at: number): string {
	for (let index = 0; index < 16; index++) {
		const byte = bytes[at + index]!;
		const to = UUID_AT[index]!;
		UUID_TEXT[to] = DIGITS[byte >> 4]!;
		UUID_TEXT[to + 1] = DIGITS[byte & 15]!;
	}
	return readUtf8(UUID_TEXT);
}

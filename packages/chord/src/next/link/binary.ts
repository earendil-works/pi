// The binary codec (2b): a kind byte (its high bit set when an origin follows as a varint), then the kind's fields as
// unsigned varints, length-prefixed UTF-8 strings, raw incarnation (16 bytes) and fingerprint (8 bytes), parts as
// length-prefixed bytes whose prefix also says whether the part is deflated (decoded as views of the message, never
// parsed or inflated here), and byte segments only beside payloads marked as carrying bytes. No outer length: links
// deliver whole messages.

import {
	type BoundEntry,
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
] as const;

const KIND_BYTES = new Map<string, number>(KINDS.map((kind, byte) => [kind, byte]));

/** The kind byte's flag for an origin. */
const ORIGIN = 0x80;

/** A payload's flags: present, and carrying byte segments. */
const PRESENT = 1;

const SEGMENTS = 2;

/** A hold's optional fields, one bit each. */
const ADDRESS = 1;

const PRINCIPAL = 2;

const INCARNATION = 4;

const CHAIN = 8;

const LIMIT = 16;

/** A part's length prefix is its length doubled, plus one when the part is deflated. */
const DEFLATED = 1;

/** Messages as bytes; the default codec of every link. */
export const binaryCodec: Codec = {
	name: "binary",
	encode(message) {
		const writer = new Writer();
		const origin = "origin" in message ? message.origin : undefined;
		if (origin === undefined) {
			writer.byte(KIND_BYTES.get(message.kind)!);
		} else {
			writer.byte(KIND_BYTES.get(message.kind)! | ORIGIN);
			writer.varint(origin);
		}
		encodeFields(message, writer);
		return writer.finish();
	},
	decode(bytes) {
		const reader = new Reader(bytes);
		const byte = reader.byte();
		const origin = byte & ORIGIN ? reader.varint() : undefined;
		const kind = KINDS[byte & ~ORIGIN];
		if (kind === undefined) throw new Error("binary: an unknown kind");
		const message = decodeFields(kind, reader);
		reader.end();
		// A fresh object; the message schema refuses an origin on a kind without one.
		if (origin !== undefined) (message as { origin?: number }).origin = origin;
		return message;
	},
};

function encodeFields(message: Message, writer: Writer): void {
	switch (message.kind) {
		case "hello":
			writer.varint(message.protocol);
			writer.raw(hex(message.incarnation.replaceAll("-", ""), 16));
			writer.varint(message.calls);
			return;
		case "hold": {
			writer.varint(message.hold);
			writer.string(message.type);
			writer.varint(message.version);
			writer.raw(hex(message.fingerprint, 8));
			writer.part(message.params);
			const { address, principal, incarnation, chain, limit } = message;
			writer.byte(
				(address === undefined ? 0 : ADDRESS) |
					(principal === undefined ? 0 : PRINCIPAL) |
					(incarnation === undefined ? 0 : INCARNATION) |
					(chain === undefined ? 0 : CHAIN) |
					(limit === undefined ? 0 : LIMIT),
			);
			if (address !== undefined) {
				writer.string(address.kind);
				writer.json(address.params);
			}
			if (principal !== undefined) writer.json(principal);
			if (incarnation !== undefined) writer.raw(hex(incarnation.replaceAll("-", ""), 16));
			if (chain !== undefined) {
				writer.varint(chain.length);
				for (const instance of chain) writer.raw(hex(instance.replaceAll("-", ""), 16));
			}
			if (limit !== undefined) writer.varint(limit);
			return;
		}
		case "release":
		case "retry":
		case "loading":
			writer.varint(message.hold);
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
			for (const { hold, variant, members, failed } of message.holds) {
				writer.varint(hold);
				writer.varint(variant);
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
			writer.byte(message.cause.kind === "transient" ? 0 : 1);
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
		case "ack":
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
		case "hello":
			return { kind, protocol: reader.varint(), incarnation: uuid(reader.raw(16)), calls: reader.varint() };
		case "hold": {
			const hold = reader.varint();
			const type = reader.string();
			const version = reader.varint();
			const fingerprint = hexText(reader.raw(8));
			const params = reader.part();
			const flags = reader.byte();
			if (flags > (ADDRESS | PRINCIPAL | INCARNATION | CHAIN | LIMIT)) throw new Error("binary: unknown hold flags");
			const address = flags & ADDRESS ? { address: { kind: reader.string(), params: reader.json() } } : {};
			const principal = flags & PRINCIPAL ? { principal: reader.json() as { kind: string } } : {};
			const incarnation = flags & INCARNATION ? { incarnation: uuid(reader.raw(16)) } : {};
			const chain = flags & CHAIN ? { chain: reader.list(() => uuid(reader.raw(16))) } : {};
			const limit = flags & LIMIT ? { limit: reader.varint() } : {};
			return {
				kind,
				hold,
				type,
				version,
				fingerprint,
				params,
				...address,
				...principal,
				...incarnation,
				...chain,
				...limit,
			};
		}
		case "release":
		case "retry":
		case "loading":
			return { kind, hold: reader.varint() };
		case "call": {
			const [call, hold, method] = [reader.varint(), reader.varint(), reader.varint()];
			return { kind, call, hold, method, ...reader.payload("args") };
		}
		case "abort":
			return { kind, call: reader.varint() };
		case "bound": {
			const holds = reader.list((): BoundEntry => {
				const [hold, variant] = [reader.varint(), reader.varint()];
				const members = reader.list(() => ({ member: reader.varint(), value: reader.part() }));
				return { hold, variant, members, failed: reader.failed() };
			});
			return { kind, holds };
		}
		case "state": {
			const holds = reader.list((): StateEntry => {
				const hold = reader.varint();
				const members = reader.list(() => ({ member: reader.varint(), ops: reader.part() }));
				// The failure count times two, plus one when retirements follow.
				const flags = reader.varint();
				const failed = reader.failedEntries(Math.floor(flags / 2));
				const retired = flags % 2 === 0 ? NO_RETIRED : reader.list(() => reader.varint());
				return { hold, members, failed, retired };
			});
			return { kind, holds };
		}
		case "failed": {
			const hold = reader.varint();
			const cause = reader.byte();
			if (cause > 1) throw new Error("binary: an unknown failure kind");
			// The schema check after decoding establishes the wire error.
			const error = reader.json() as Extract<Message, { kind: "error" }>["error"];
			const retryIn = reader.varint();
			return {
				kind,
				hold,
				cause: { kind: cause === 0 ? "transient" : "broken", error },
				...(retryIn === 0 ? {} : { retryIn: retryIn - 1 }),
			};
		}
		case "result":
			return { kind, call: reader.varint(), ...reader.payload("value") };
		case "error":
			return { kind, call: reader.varint(), error: reader.json() as Extract<Message, { kind: "error" }>["error"] };
		case "gone":
			return { kind, hold: reader.varint(), error: reader.json() as Extract<Message, { kind: "error" }>["error"] };
		case "revoke":
			return { kind, revocation: reader.json() };
		case "ack":
		case "ping":
		case "pong":
			return { kind };
		case "closed":
			// Its origin is the kind byte's; 0 without one, which the message schema refuses.
			return { kind, origin: 0 };
	}
}

/** Up to this many UTF-16 units a string takes at most 126 bytes, so its length is one varint byte. */
const SHORT = 42;

/** From this many UTF-16 units a string is encoded in place (below it, encoding on its own and copying is cheaper). */
const LONG = 4096;

/** The fixed length prefix of a long string: five varint bytes, up to 32 GiB (16 GiB for a part). */
const LENGTH_SLOT = 5;

/** The room left after a large chunk for the fields that follow it. */
const SPARE = 4096;

/** Writes a message into one growing buffer, right-sized at the end. */
class Writer {
	/** Large enough for most small messages (a state change, a call), small enough to zero cheaply. */
	#buffer = new Uint8Array(256);
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
	 * The message: a view of the buffer, or a right-sized copy when the spare room is meaningful (at least 64 bytes and
	 * more than an eighth of the message), so a kept message keeps at most that much beyond itself. A large message
	 * ends within its 4 KiB of room and is not copied.
	 */
	finish(): Uint8Array {
		const message = this.#buffer.subarray(0, this.#length);
		const spare = this.#buffer.byteLength - this.#length;
		return spare >= 64 && spare * 8 > this.#length ? message.slice() : message;
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
		if (length > this.#bytes.byteLength - this.#offset) throw new Error("binary: the message ends early");
		const bytes = this.#bytes.subarray(this.#offset, this.#offset + length);
		this.#offset += length;
		return bytes;
	}

	string(): string {
		return readUtf8(this.raw(this.varint()));
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
	list<T>(read: () => T): T[] {
		const count = this.varint();
		if (count > this.#bytes.byteLength - this.#offset) throw new Error("binary: a count does not fit");
		return Array.from({ length: count }, read);
	}

	/** A payload part under `key`, absent when not present, with its segments when marked as carrying them. */
	payload<K extends string>(key: K): { [P in K]?: Part } & { segments?: Uint8Array[] } {
		const flags = this.varint();
		if (flags === 0) return {};
		if (flags !== PRESENT && flags !== (PRESENT | SEGMENTS)) throw new Error("binary: unknown payload flags");
		const part = this.part();
		if (flags === PRESENT) return { [key]: part } as { [P in K]?: Part };
		const lengths = this.list(() => this.varint());
		const segments = lengths.map((length) => this.raw(length));
		return { [key]: part, segments } as { [P in K]?: Part } & { segments: Uint8Array[] };
	}

	failed(): FailedMember[] {
		return this.failedEntries(this.varint());
	}

	/** `count` failed members, as `Writer.failed` writes them after their count. */
	failedEntries(count: number): FailedMember[] {
		if (count > this.#bytes.byteLength - this.#offset) throw new Error("binary: a count does not fit");
		// The message schema checks each error's shape.
		return Array.from({ length: count }, () => ({
			member: this.varint(),
			error: this.json() as Extract<Message, { kind: "error" }>["error"],
		}));
	}

	/** The message is consumed exactly. */
	end(): void {
		if (this.#offset !== this.#bytes.byteLength) throw new Error("binary: bytes after the message");
	}
}

/** Lowercase hex of 8 and 16 bytes: a fingerprint, an incarnation without its dashes. */
const HEX = new Map([
	[8, /^[0-9a-f]{16}$/],
	[16, /^[0-9a-f]{32}$/],
]);

/** `length` bytes from lowercase hex (an incarnation without dashes, a fingerprint). */
function hex(text: string, length: number): Uint8Array {
	if (!HEX.get(length)!.test(text)) throw new Error(`binary: not ${length} bytes of hex`);
	return Uint8Array.from({ length }, (_, index) => Number.parseInt(text.slice(index * 2, index * 2 + 2), 16));
}

function hexText(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 16 bytes as a UUID's text. */
function uuid(bytes: Uint8Array): string {
	const text = hexText(bytes);
	return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

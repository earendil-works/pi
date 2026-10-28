import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "../src/types.ts";
import { parseStreamingJson, parseToolCallArguments } from "../src/utils/json-parse.ts";
import { type JsonChange, StreamingJsonParser, ToolCallArgumentsStream } from "../src/utils/streaming-json.ts";
import { allocatedBytes, collectGarbage } from "./memory-helpers.ts";

// #9265: streamed tool-call arguments were re-parsed in full on every delta.

/** Seeded random numbers, so every run checks the same documents. */
function random(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		return state / 0x7fffffff;
	};
}

type Random = () => number;

const pick = <T>(rand: Random, items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;

const STRING_PIECES = [
	"a",
	"b",
	"x y",
	" ",
	"\n",
	"\t",
	"\\",
	'"',
	"/",
	"é",
	"😀",
	"\u0001",
	"\u001f",
	"\u2028",
	"{",
	"]",
	",",
];

function randomString(rand: Random): string {
	let text = "";
	const length = Math.floor(rand() * 6);
	for (let index = 0; index < length; index++) text += pick(rand, STRING_PIECES);
	return text;
}

function randomScalar(rand: Random): JsonValue {
	return pick(rand, [
		() => randomString(rand),
		() => Math.floor(rand() * 2000) - 1000,
		() => rand() * 100,
		() => 1e21,
		() => -5e-8,
		() => -0,
		() => 0,
		() => true,
		() => false,
		() => null,
	])();
}

function randomValue(rand: Random, depth: number): JsonValue {
	const roll = rand();
	if (depth > 3 || roll < 0.3) return randomScalar(rand);
	if (roll < 0.65) {
		const members: { [key: string]: JsonValue } = {};
		const count = Math.floor(rand() * 4);
		for (let index = 0; index < count; index++) members[randomString(rand)] = randomValue(rand, depth + 1);
		return members;
	}
	return Array.from({ length: Math.floor(rand() * 4) }, () => randomValue(rand, depth + 1));
}

/** JSON text of `value`, with random insignificant whitespace when `spaced`. */
function render(value: JsonValue, rand: Random, spaced: boolean): string {
	const space = () => (spaced ? pick(rand, ["", "", " ", "\n  ", "\t", "\r\n"]) : "");
	if (Array.isArray(value)) {
		return `[${space()}${value.map((item) => render(item, rand, spaced)).join(`${space()},${space()}`)}${space()}]`;
	}
	if (value !== null && typeof value === "object") {
		const members = Object.entries(value).map(
			([key, item]) => `${JSON.stringify(key)}${space()}:${space()}${render(item, rand, spaced)}`,
		);
		return `{${space()}${members.join(`${space()},${space()}`)}${space()}}`;
	}
	// JSON.stringify(-0) is "0"; keep the sign so the text parses back to the same value.
	return Object.is(value, -0) ? "-0" : JSON.stringify(value);
}

function randomDocuments(seed: number, count: number, spaced: boolean): string[] {
	const rand = random(seed);
	return Array.from({ length: count }, () =>
		render(
			rand() < 0.8 ? { path: randomString(rand), args: randomValue(rand, 0) } : randomValue(rand, 0),
			rand,
			spaced,
		),
	);
}

/** Whether the reference shows unterminated numbers and literals, as snapshots do; changes leave them out. */
let pendingScalars = true;

/**
 * Reference for `StreamingJsonParser` on a prefix of valid JSON (strings may also hold raw control characters and
 * invalid escapes): a plain recursive-descent reading of the whole prefix that follows the documented rules. It is
 * written independently of the incremental parser so the two check each other.
 */
function referenceSnapshot(text: string, options: { pendingScalars?: boolean } = {}): JsonValue | undefined {
	pendingScalars = options.pendingScalars ?? true;
	const read = readValue(text, skipSpace(text, 0));
	return read === undefined ? undefined : read.value;
}

type Read = { readonly value: JsonValue; readonly complete: boolean; readonly end: number };

const SPACE = " \t\n\r";

function skipSpace(text: string, start: number): number {
	let index = start;
	while (index < text.length && SPACE.includes(text[index]!)) index++;
	return index;
}

function readValue(text: string, start: number): Read | undefined {
	if (start >= text.length) return undefined;
	const char = text[start];
	if (char === '"') return readString(text, start);
	if (char === "{") return readObject(text, start);
	if (char === "[") return readArray(text, start);
	return readScalar(text, start);
}

const SIMPLE: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

function readString(text: string, start: number): Read & { readonly value: string } {
	let value = "";
	let index = start + 1;
	while (index < text.length) {
		const char = text[index]!;
		if (char === '"') return { value, complete: true, end: index + 1 };
		if (char !== "\\") {
			value += char;
			index++;
			continue;
		}
		const next = text[index + 1];
		if (next === undefined) return { value, complete: false, end: text.length };
		if (SIMPLE[next] !== undefined) {
			value += SIMPLE[next];
			index += 2;
			continue;
		}
		if (next === "u") {
			let end = index + 2;
			while (end < index + 6 && end < text.length && /[0-9a-fA-F]/.test(text[end]!)) end++;
			if (end === index + 6) {
				value += String.fromCharCode(Number.parseInt(text.slice(index + 2, end), 16));
				index = end;
				continue;
			}
			if (end === text.length) return { value, complete: false, end };
			// Not four hex digits: the escape stays literal and the next character is read normally.
			value += text.slice(index, end);
			index = end;
			continue;
		}
		// Invalid escape: the backslash stays literal and the next character is read normally.
		value += "\\";
		index++;
	}
	return { value, complete: false, end: text.length };
}

function setOwn(members: { [key: string]: JsonValue }, key: string, value: JsonValue): void {
	Object.defineProperty(members, key, { value, writable: true, enumerable: true, configurable: true });
}

function readObject(text: string, start: number): Read {
	const members: { [key: string]: JsonValue } = {};
	const partial = { value: members, complete: false, end: text.length };
	let index = skipSpace(text, start + 1);
	if (index >= text.length) return partial;
	if (text[index] === "}") return { value: members, complete: true, end: index + 1 };
	for (;;) {
		if (text[index] !== '"') throw new Error(`reference reads valid JSON only: ${JSON.stringify(text)}`);
		const key = readString(text, index);
		if (!key.complete) return partial;
		index = skipSpace(text, key.end);
		if (index >= text.length) return partial;
		index = skipSpace(text, index + 1);
		const member = readValue(text, index);
		if (member === undefined) return partial;
		setOwn(members, key.value, member.value);
		if (!member.complete) return partial;
		index = skipSpace(text, member.end);
		if (index >= text.length) return partial;
		if (text[index] === "}") return { value: members, complete: true, end: index + 1 };
		index = skipSpace(text, index + 1);
		if (index >= text.length) return partial;
	}
}

function readArray(text: string, start: number): Read {
	const elements: JsonValue[] = [];
	const partial = { value: elements, complete: false, end: text.length };
	let index = skipSpace(text, start + 1);
	if (index >= text.length) return partial;
	if (text[index] === "]") return { value: elements, complete: true, end: index + 1 };
	for (;;) {
		const element = readValue(text, index);
		if (element === undefined) return partial;
		elements.push(element.value);
		if (!element.complete) return partial;
		index = skipSpace(text, element.end);
		if (index >= text.length) return partial;
		if (text[index] === "]") return { value: elements, complete: true, end: index + 1 };
		index = skipSpace(text, index + 1);
		if (index >= text.length) return partial;
	}
}

function readScalar(text: string, start: number): Read | undefined {
	let end = start;
	while (end < text.length && !`${SPACE},:{}[]"`.includes(text[end]!)) end++;
	const token = text.slice(start, end);
	if (end < text.length) return { value: JSON.parse(token) as JsonValue, complete: true, end };
	if (!pendingScalars) return undefined;
	// At the end of the text: a literal prefix, a number, or a number whose exponent has no digits yet.
	for (const [literal, value] of [
		["true", true],
		["false", false],
		["null", null],
	] as const) {
		if (literal.startsWith(token)) return { value, complete: false, end };
	}
	if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token))
		return { value: Number(token), complete: false, end };
	const mantissa = /^(-?(?:0|[1-9]\d*)(?:\.\d+)?)[eE][+-]?$/.exec(token);
	return mantissa === null ? undefined : { value: Number(mantissa[1]), complete: false, end };
}

type Step = { readonly read: string; readonly snapshot: JsonValue | undefined; readonly copy: JsonValue | undefined };

/** Feed `text` in pieces; returns the snapshot after each piece, a copy taken right then, and the text read by then. */
function stream(text: string, chunkSize: number | Random): Step[] {
	const parser = new StreamingJsonParser();
	const steps: Step[] = [];
	for (let index = 0; index < text.length; ) {
		const size = typeof chunkSize === "number" ? chunkSize : 1 + Math.floor(chunkSize() * 12);
		parser.append(text.slice(index, index + size));
		index += size;
		const snapshot = parser.snapshot();
		steps.push({ read: text.slice(0, index), snapshot, copy: structuredClone(snapshot) });
	}
	return steps;
}

function finalSnapshot(text: string, chunkSize = text.length || 1): JsonValue | undefined {
	return stream(text, chunkSize).at(-1)?.snapshot;
}

const CHUNK_SIZES: readonly (number | "random")[] = [1, 2, 3, 7, "random"];

/** A stable seed from the text, so random chunk sizes differ per document. */
function read32(text: string): number {
	let hash = 7;
	for (let index = 0; index < text.length; index++) hash = (hash * 31 + text.charCodeAt(index)) | 0;
	return Math.abs(hash) + 1;
}

describe("StreamingJsonParser differential fuzzing", () => {
	it("matches the reference after every piece, at every chunk size, with insignificant whitespace", () => {
		for (const text of randomDocuments(1, 250, true)) {
			for (const size of CHUNK_SIZES) {
				for (const { read, snapshot } of stream(text, size === "random" ? random(read32(text)) : size)) {
					expect(snapshot, `${JSON.stringify(read)} (chunk size ${size})`).toEqual(referenceSnapshot(read));
				}
			}
		}
	});

	it("matches today's parseStreamingJson at every prefix of compact documents", () => {
		for (const text of randomDocuments(2, 400, false)) {
			for (const { read, snapshot } of stream(text, 1)) {
				// Documented differences: parseStreamingJson trims trailing whitespace, and shows an unfinished root
				// `null` as {}.
				if (/\s$/.test(read)) continue;
				const expected = parseStreamingJson(read);
				if (snapshot === null && "null".startsWith(read)) continue;
				expect(snapshot ?? {}, JSON.stringify(read)).toEqual(expected);
			}
		}
	});

	it("reads complete documents exactly like JSON.parse", () => {
		for (const text of [...randomDocuments(3, 300, true), ...randomDocuments(4, 300, false)]) {
			const expected = JSON.parse(text) as JsonValue;
			for (const size of CHUNK_SIZES) {
				expect(finalSnapshot(text, size === "random" ? 5 : size), text).toEqual(expected);
			}
		}
	});

	it("never changes a snapshot once it is returned", () => {
		for (const text of randomDocuments(5, 150, true)) {
			for (const { snapshot, copy } of stream(text, random(read32(text)))) expect(snapshot).toEqual(copy);
		}
	});

	it("repairs raw control characters and invalid escapes like parseStreamingJson, and shows them while streaming", () => {
		const rand = random(6);
		const malformed = ["\n", "\t", "\u0000", "\\d", "\\x41", "\\u12", "\\uZZZZ", "\\u00e9", "\\\\", "\\q"];
		for (let round = 0; round < 300; round++) {
			let content = "";
			for (let index = 0; index < 6; index++) content += pick(rand, [...malformed, "a", " ", "é"]);
			const text = `{"path":"p","content":"${content}","n":${round}}`;
			// Complete text: the same repaired value as today's parser.
			expect(finalSnapshot(text, 1), JSON.stringify(text)).toEqual(parseStreamingJson(text));
			for (const { read, snapshot } of stream(text, 1)) {
				expect(snapshot, JSON.stringify(read)).toEqual(referenceSnapshot(read));
			}
		}
	});
});

describe("StreamingJsonParser strings", () => {
	it("holds an escape back until it is complete, at every split position", () => {
		for (const [text, value] of [
			[String.raw`{"a":"x\u00e9y"}`, "xéy"],
			[String.raw`{"a":"x\ny"}`, "x\ny"],
			[String.raw`{"a":"x\\y"}`, "x\\y"],
			[String.raw`{"a":"x\"y"}`, 'x"y'],
			[String.raw`{"a":"x\/y"}`, "x/y"],
		] as const) {
			for (let split = 0; split <= text.length; split++) {
				const parser = new StreamingJsonParser();
				parser.append(text.slice(0, split));
				expect(parser.snapshot(), text.slice(0, split)).toEqual(referenceSnapshot(text.slice(0, split)));
				parser.append(text.slice(split));
				expect(parser.snapshot()).toEqual({ a: value });
			}
		}
	});

	it("joins surrogate pairs split across pieces, escaped or raw", () => {
		const escaped = String.raw`{"a":"\ud83d\ude00!"}`;
		const raw = '{"a":"😀!"}';
		for (const text of [escaped, raw]) {
			for (let split = 0; split <= text.length; split++) {
				const parser = new StreamingJsonParser();
				parser.append(text.slice(0, split));
				parser.snapshot();
				parser.append(text.slice(split));
				expect(parser.snapshot()).toEqual({ a: "😀!" });
			}
		}
		// A high surrogate whose low half has not arrived shows alone, like JSON.parse() of the escape.
		const parser = new StreamingJsonParser();
		parser.append(String.raw`{"a":"\ud83d`);
		expect(parser.snapshot()).toEqual({ a: "\ud83d" });
	});

	it("keeps trailing whitespace of an unterminated string", () => {
		const parser = new StreamingJsonParser();
		parser.append('{"code":"x\t\t  ');
		expect(parser.snapshot()).toEqual({ code: "x\t\t  " });
	});

	it("keeps raw control characters and invalid escapes visible while streaming", () => {
		const parser = new StreamingJsonParser();
		parser.append('{"a":"x\ny \\d \\u12"');
		expect(parser.snapshot()).toEqual({ a: "x\ny \\d \\u12" });
	});

	it("keeps invalid \\u escapes literal without dropping fields (#10868)", () => {
		expect(finalSnapshot(String.raw`{"path":"a.tex","content":"\usepackage{x}","mode":"w"}`, 1)).toEqual({
			path: "a.tex",
			content: "\\usepackage{x}",
			mode: "w",
		});
		expect(finalSnapshot(String.raw`{"text":"caf\u00e9 \url"}`, 3)).toEqual({ text: "café \\url" });
		const parser = new StreamingJsonParser();
		parser.append(String.raw`{"text":"ab\u00`);
		expect(parser.snapshot()).toEqual({ text: "ab" });
	});

	it("makes `__proto__` an own member, as JSON.parse does", () => {
		const text = '{"__proto__":{"polluted":true},"b":{"__proto__":"x"}}';
		for (let split = 0; split <= text.length; split++) {
			const parser = new StreamingJsonParser();
			parser.append(text.slice(0, split));
			const partial = parser.snapshot() as { [key: string]: JsonValue } | undefined;
			if (partial !== undefined) expect(Object.getPrototypeOf(partial)).toBe(Object.prototype);
			parser.append(text.slice(split));
			const value = parser.snapshot() as { [key: string]: JsonValue };
			expect(value).toEqual(JSON.parse(text));
			expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
			expect(Object.hasOwn(value, "__proto__")).toBe(true);
		}
		expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
	});

	it("keeps the last value of a duplicate key in the first key's position, as JSON.parse does", () => {
		const text = '{"a":1,"b":2,"a":"three"}';
		expect(Object.keys(finalSnapshot(text, 1) as object)).toEqual(Object.keys(JSON.parse(text)));
		expect(finalSnapshot(text, 1)).toEqual(JSON.parse(text));
	});
});

/** Expected values of the inputs, from other partial-JSON parsers' public test suites (see each table's source). */
type Vector = readonly [input: string, expected: JsonValue | undefined];

// partial-json (MIT, https://github.com/promplate/partial-json-parser-js/blob/main/tests/examples.test.js), with every
// partial type allowed, as parseStreamingJson uses it.
const PARTIAL_JSON_VECTORS: readonly Vector[] = [
	['"', ""],
	['["', [""]],
	['{"": "', { "": "" }],
	["n", null],
	["t", true],
	["f", false],
	["0", 0],
	["-1.25e+4", -1.25e4],
	["-1.25e+", -1.25],
	["-1.25e", -1.25],
	// Differences, documented in streaming-json.ts: an invalid escape stays visible (partial-json cuts the string at
	// the backslash), and `Infinity`/`NaN` words are not JSON and are dropped.
	['" \\x12', " \\x12"],
	["I", undefined],
	["-I", undefined],
	["N", undefined],
];

// Vercel AI SDK fixJson (Apache-2.0, https://github.com/vercel/ai/blob/main/packages/ai/src/util/fix-json.test.ts):
// the expected values are JSON.parse() of its repaired texts.
const FIX_JSON_VECTORS: readonly Vector[] = [
	["", undefined],
	["nul", null],
	["t", true],
	["fals", false],
	["12.2", 12.2],
	["-12", -12],
	["-", undefined],
	["2.5e", 2.5],
	["2.5e-", 2.5],
	["2.5e3", 2.5e3],
	["-2.5e3", -2.5e3],
	["2.5E", 2.5],
	["2.5E-", 2.5],
	["2.5E3", 2.5e3],
	["-2.5E3", -2.5e3],
	["12.34e", 12.34],
	["5e", 5],
	['"abc', "abc"],
	['"value with \\"quoted\\" text and \\\\ escape', 'value with "quoted" text and \\ escape'],
	['"value with \\', "value with "],
	['"\\u', ""],
	['"\\u12', ""],
	['"text \\u00', "text "],
	['{"a":"\\u12', { a: "" }],
	['"value with unicode \u003C"', "value with unicode <"],
	["[", []],
	["[[1], [2", [[1], [2]]],
	['[["1"], ["2', [["1"], ["2"]]],
	["[[false], [nu", [[false], [null]]],
	["[[[]], [[]", [[[]], [[]]]],
	["[[{}], [{", [[{}], [{}]]],
	["[1, ", [1]],
	["[[], 123", [[], 123]],
	['{"key":', {}],
	['{"a": {"b": 1}, "c": {"d": 2', { a: { b: 1 }, c: { d: 2 } }],
	['{"a": {"b": "1"}, "c": {"d": 2', { a: { b: "1" }, c: { d: 2 } }],
	['{"a": {"b": false}, "c": {"d": 2', { a: { b: false }, c: { d: 2 } }],
	['{"a": {"b": []}, "c": {"d": 2', { a: { b: [] }, c: { d: 2 } }],
	['{"a": {"b": {}}, "c": {"d": 2', { a: { b: {} }, c: { d: 2 } }],
	['{"ke', {}],
	['{"k1": 1, "k2', { k1: 1 }],
	['{"k1": 1, "k2":', { k1: 1 }],
	['{"key": "value"  ', { key: "value" }],
	['{"a": {"b": {}', { a: { b: {} } }],
	["[1, [2, 3, [", [1, [2, 3, []]]],
	["[false, [true, [", [false, [true, []]]],
	['{"key": {"subKey":', { key: {} }],
	['{"key": 123, "key2": {"subKey":', { key: 123, key2: {} }],
	['{"key": null, "key2": {"subKey":', { key: null, key2: {} }],
	['{"key": [1, 2, {', { key: [1, 2, {}] }],
	['[1, 2, {"key": "value",', [1, 2, { key: "value" }]],
	['{"a": {"b": ["c", {"d": "e",', { a: { b: ["c", { d: "e" }] } }],
	['{"a": {"b": {"c": {"d":', { a: { b: { c: {} } } }],
	['{"a": 1, "b": [', { a: 1, b: [] }],
	['{"a": 1, "b": {', { a: 1, b: {} }],
	['{"a": 1, "b": "', { a: 1, b: "" }],
	[
		'{\n  "a": [\n    {\n      "a1": "v1",\n      "a2": "v2",\n      "a3": "v3"\n    }\n  ],\n  "b": [\n    {\n      "b1": "n',
		{ a: [{ a1: "v1", a2: "v2", a3: "v3" }], b: [{ b1: "n" }] },
	],
	['{"type":"div","children":[{"type":"Card","props":{}', { type: "div", children: [{ type: "Card", props: {} }] }],
	// Difference: fixJson completes `12.` to 12; like parseStreamingJson, a number cut after its dot is omitted.
	["12.", undefined],
	["12.e", undefined],
];

describe("StreamingJsonParser ported test vectors", () => {
	it.each([...PARTIAL_JSON_VECTORS, ...FIX_JSON_VECTORS])("reads %j", (input, expected) => {
		for (const size of [input.length || 1, 1, 2]) {
			expect(finalSnapshot(input, size)).toEqual(expected);
		}
	});

	it("reads every JSONTestSuite document JSON.parse accepts exactly like it, and never throws on the rest", () => {
		const suite = JSON.parse(readFileSync(new URL("./data/json-test-suite.json", import.meta.url), "utf8")) as {
			files: Record<string, string>;
		};
		for (const [name, base64] of Object.entries(suite.files)) {
			const text = Buffer.from(base64, "base64").toString("utf8");
			let expected: JsonValue | undefined;
			try {
				expected = JSON.parse(text) as JsonValue;
			} catch {
				expected = undefined;
			}
			for (const size of [text.length || 1, 1, 3]) {
				const snapshot = finalSnapshot(text, size);
				if (expected !== undefined) expect(snapshot, name).toEqual(expected);
				else expectJson(snapshot, name);
			}
		}
	});
});

/** Asserts `value` is plain, finite JSON data: what consumers such as Durable's strict JSON copy accept. */
function expectJson(value: JsonValue | undefined, label: string): void {
	if (value === undefined || value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number") {
		expect(Number.isFinite(value), label).toBe(true);
		return;
	}
	expect([Object.prototype, Array.prototype], label).toContain(Object.getPrototypeOf(value));
	for (const item of Object.values(value)) expectJson(item, label);
}

describe("StreamingJsonParser malformed text", () => {
	const MALFORMED = [
		'{"a":1 "b":2}',
		'{"a" 1, "b": 2}',
		"{a:1, 'b': 2}",
		'{"a":1,,"b":2,}',
		"[1 2, , 3,]",
		'{"a":[1,2}, "b":3]',
		"]]]}}}{",
		'{"a":NaN,"b":Infinity,"c":-Infinity,"d":undefined,"e":1}',
		'{"a":01,"b":1.,"c":.5,"d":+1,"e":0x10,"f":1e}',
		'{"a":"x"} trailing garbage {"b":2}',
		'{"a": tru, "b": nulll, "c": falsey}',
		'{"a":{"b":{"c":',
		'{"a\\": 1}',
		'"unterminated \\',
		'// comment\n{"a":1}',
		'\u0000{\u0001"a"\u0002:\u00031}',
		'{"a":"x"}}}]]]',
	];

	it("never throws, keeps snapshots plain JSON and unchanged, at every chunk size", () => {
		for (const text of MALFORMED) {
			for (const size of CHUNK_SIZES) {
				const steps = stream(text, size === "random" ? random(read32(text)) : size);
				for (const { snapshot, copy } of steps) {
					expectJson(snapshot, text);
					expect(snapshot).toEqual(copy);
				}
				// Every chunk size reads malformed text the same way.
				expect(steps.at(-1)?.snapshot, text).toEqual(finalSnapshot(text));
			}
		}
	});

	it("tolerates missing commas and colons and drops values in invalid positions", () => {
		expect(finalSnapshot('{"a":1 "b":2}')).toEqual({ a: 1, b: 2 });
		expect(finalSnapshot('{"a" 1, "b": 2}')).toEqual({ a: 1, b: 2 });
		expect(finalSnapshot("[1 2, , 3,]")).toEqual([1, 2, 3]);
		expect(finalSnapshot('{"a":NaN,"b":Infinity,"e":1}')).toEqual({ e: 1 });
		expect(finalSnapshot('{"a":"x"} trailing garbage {"b":2}')).toEqual({ a: "x" });
	});

	it("survives random corruption of valid documents", () => {
		const rand = random(7);
		const noise = ['"', "\\", "{", "}", "[", "]", ",", ":", "x", "1", "-", "\n", "t"];
		for (const text of randomDocuments(8, 300, true)) {
			const characters = [...text];
			for (let edit = 0; edit < 3; edit++) {
				const at = Math.floor(rand() * (characters.length + 1));
				if (rand() < 0.5) characters.splice(at, 1);
				else characters.splice(at, 0, pick(rand, noise));
			}
			const corrupted = characters.join("");
			for (const { snapshot } of stream(corrupted, random(read32(corrupted)))) expectJson(snapshot, corrupted);
			// The changes keep a copy equal to the parser's own value, malformed or not.
			const parser = new StreamingJsonParser();
			const mirror = new Mirror();
			for (let index = 0; index < corrupted.length; index += 4)
				mirror.apply(parser.append(corrupted.slice(index, index + 4)));
			// A space ends a number or literal at the end, which snapshots show and changes do not report yet.
			mirror.apply(parser.append(" "));
			expect(mirror.value, corrupted).toEqual(parser.snapshot());
		}
	});
});

/** A copy of a value kept current by applying the parser's changes, as a writer such as Durable keeps one. */
class Mirror {
	value: JsonValue | undefined = undefined;

	apply(changes: readonly JsonChange[]): void {
		for (const change of changes) {
			const key = change.path.at(-1);
			let parent = this.value as Record<string | number, JsonValue>;
			for (const segment of change.path.slice(0, -1)) parent = parent[segment] as Record<string | number, JsonValue>;
			if (change.kind === "set") {
				const value = structuredClone(change.value);
				if (key === undefined) this.value = value;
				else parent[key] = value;
			} else if (key === undefined) {
				this.value = `${this.value as string}${change.text}`;
			} else {
				parent[key] = `${parent[key] as string}${change.text}`;
			}
		}
	}
}

/** Feed `text` in pieces into a parser and a mirror of its changes; checks the mirror after each piece. */
function mirrorStream(text: string, size: number | Random): Mirror {
	const parser = new StreamingJsonParser();
	const mirror = new Mirror();
	for (let index = 0; index < text.length; ) {
		const length = typeof size === "number" ? size : 1 + Math.floor(size() * 12);
		mirror.apply(parser.append(text.slice(index, index + length)));
		index += length;
		// Changes leave out unterminated numbers and literals, which snapshots show.
		expect(mirror.value, JSON.stringify(text.slice(0, index))).toEqual(
			referenceSnapshot(text.slice(0, index), { pendingScalars: false }),
		);
	}
	return mirror;
}

describe("StreamingJsonParser changes", () => {
	it("keep a copy equal to the value read so far, at every chunk size, and to JSON.parse at the end", () => {
		for (const text of randomDocuments(9, 200, true)) {
			for (const size of CHUNK_SIZES) {
				const mirror = mirrorStream(text, size === "random" ? random(read32(text)) : size);
				expect(mirror.value, text).toEqual(JSON.parse(text));
			}
		}
	});

	it("report a number that ends and a string that starts in one piece, in order", () => {
		const parser = new StreamingJsonParser();
		expect(parser.append('{"n":1')).toEqual([{ kind: "set", path: [], value: {} }]);
		expect(parser.append('2,"s":"ab')).toEqual([
			{ kind: "set", path: ["n"], value: 12 },
			{ kind: "set", path: ["s"], value: "ab" },
		]);
		expect(parser.append('c","t":tru')).toEqual([{ kind: "append", path: ["s"], text: "c" }]);
		expect(parser.append("e}")).toEqual([{ kind: "set", path: ["t"], value: true }]);
		expect(parser.append(' {"ignored":1}')).toEqual([]);
	});

	it("report nested objects and arrays as empty containers, then their members and items", () => {
		const parser = new StreamingJsonParser();
		expect(parser.append('{"a":[1,{"b":["x"')).toEqual([
			{ kind: "set", path: [], value: {} },
			{ kind: "set", path: ["a"], value: [] },
			{ kind: "set", path: ["a", 0], value: 1 },
			{ kind: "set", path: ["a", 1], value: {} },
			{ kind: "set", path: ["a", 1, "b"], value: [] },
			{ kind: "set", path: ["a", 1, "b", 0], value: "x" },
		]);
		expect(parser.append(',"y')).toEqual([{ kind: "set", path: ["a", 1, "b", 1], value: "y" }]);
		expect(parser.append('z"]}],"a":"again"}')).toEqual([
			{ kind: "append", path: ["a", 1, "b", 1], text: "z" },
			{ kind: "set", path: ["a"], value: "again" },
		]);
	});

	it("hold split escapes back and report their decoded text once complete", () => {
		const text = String.raw`{"a":"x\u00e9\n\\\"\ud83d\ude00\q"}`;
		const expected = (JSON.parse(String.raw`{"a":"x\u00e9\n\\\"\ud83d\ude00\\q"}`) as { a: string }).a;
		for (let first = 1; first < text.length; first++) {
			for (let second = first; second < text.length; second++) {
				const parser = new StreamingJsonParser();
				const mirror = new Mirror();
				for (const piece of [text.slice(0, first), text.slice(first, second), text.slice(second)]) {
					mirror.apply(parser.append(piece));
				}
				expect(mirror.value).toEqual({ a: expected });
			}
		}
		const parser = new StreamingJsonParser();
		parser.append('{"a":"x');
		expect(parser.append("\\u00")).toEqual([]);
		expect(parser.append("e9")).toEqual([{ kind: "append", path: ["a"], text: "é" }]);
	});

	it("report a container nested deeper than 32 levels once, whole, when it closes", () => {
		const depth = 40;
		const text = `${'{"a":'.repeat(depth)}"deep"${"}".repeat(depth)}`;
		const parser = new StreamingJsonParser();
		const mirror = new Mirror();
		for (let index = 0; index < text.length; index += 3) mirror.apply(parser.append(text.slice(index, index + 3)));
		expect(mirror.value).toEqual(JSON.parse(text));
		const changes = new StreamingJsonParser().append(text);
		// The containers down to path length 32, then the one at length 32 again, whole, as it closes.
		expect(changes).toHaveLength(34);
		const last = changes.at(-1)!;
		expect(last.kind === "set" && last.path.length).toBe(32);
		expect(last.kind === "set" && last.value).toEqual(JSON.parse(text.slice(32 * 5, -32)));
	});

	it("report nothing for values in invalid positions and text after the root", () => {
		const parser = new StreamingJsonParser();
		expect(parser.append('{"a":1 2, "b" "x"}')).toEqual([
			{ kind: "set", path: [], value: {} },
			{ kind: "set", path: ["a"], value: 1 },
			{ kind: "set", path: ["b"], value: "x" },
		]);
		expect(parser.append('{"c":3}')).toEqual([]);
	});
});

describe("StreamingJsonParser cost", () => {
	const content = Array.from(
		{ length: 20_000 },
		(_, line) => `const line${line} = "value ${line}"; // \\ done\n`,
	).join("");

	/** `write`-style arguments with `size` characters of file content, streamed in 32-character deltas. */
	const writeArguments = (size: number) => JSON.stringify({ path: "/src/file.ts", content: content.slice(0, size) });

	async function streamAllocation(text: string, delta: number): Promise<number> {
		return allocatedBytes(() => {
			const args = new ToolCallArgumentsStream();
			for (let index = 0; index < text.length; index += delta) args.append(text.slice(index, index + delta));
			return args.finish();
		});
	}

	it("allocates linearly in the streamed text, never per accumulated text", async () => {
		const small = writeArguments(50_000);
		const large = writeArguments(500_000);
		const smallBytes = await streamAllocation(small, 32);
		const largeBytes = await streamAllocation(large, 32);
		// Measured about 15 bytes per character; re-parsing the accumulated text cost about 1 MB per character.
		expect(largeBytes / large.length).toBeLessThan(200);
		// Ten times the text: linear growth is about 10x, quadratic about 100x.
		expect(largeBytes / smallBytes).toBeLessThan(20);
	});

	it("keeps very large open arrays linear by letting their preview lag", async () => {
		const elements = (count: number) => JSON.stringify({ items: Array.from({ length: count }, (_, index) => index) });
		const small = elements(10_000);
		const large = elements(100_000);
		const smallBytes = await streamAllocation(small, 16);
		const largeBytes = await streamAllocation(large, 16);
		expect(largeBytes / large.length).toBeLessThan(2000);
		expect(largeBytes / smallBytes).toBeLessThan(20);

		const parser = new StreamingJsonParser();
		let shown = 0;
		for (let index = 0; index < large.length; index += 16) {
			parser.append(large.slice(index, index + 16));
			const items = (parser.snapshot() as { items?: number[] } | undefined)?.items ?? [];
			// The preview only moves forward.
			expect(items.length).toBeGreaterThanOrEqual(shown);
			shown = items.length;
		}
		expect(parser.snapshot()).toEqual(JSON.parse(large));
	});

	it("reads deep nesting without recursion and in linear time", () => {
		const depth = 200_000;
		const text = `${"[".repeat(depth)}1${"]".repeat(depth)}`;
		const started = performance.now();
		const parser = new StreamingJsonParser();
		for (let index = 0; index < text.length; index += 7) {
			parser.append(text.slice(index, index + 7));
			parser.snapshot();
		}
		let value = parser.snapshot();
		for (let level = 0; level < depth; level++) value = (value as JsonValue[])[0]!;
		expect(value).toBe(1);
		expect(performance.now() - started).toBeLessThan(5_000);
	});

	it("reads one huge piece, such as a provider's complete arguments, in linear time", async () => {
		const text = writeArguments(500_000);
		const bytes = await allocatedBytes(() => {
			const parser = new StreamingJsonParser();
			parser.append(text);
			return parser.snapshot();
		});
		expect(bytes / text.length).toBeLessThan(100);
	});
});

describe("ToolCallArgumentsStream", () => {
	it("shows partial arguments as an object and finishes with one full parse", () => {
		const args = new ToolCallArgumentsStream();
		expect(args.append("  ")).toEqual({});
		expect(args.append('{"path":"a.ts","content":"x')).toEqual({ path: "a.ts", content: "x" });
		const before = args.append("y");
		expect(args.append("")).toBe(before);
		expect(args.text).toBe('  {"path":"a.ts","content":"xy');
		expect(args.finish()).toEqual(parseToolCallArguments('  {"path":"a.ts","content":"xy'));
		args.append('"}');
		expect(args.finish()).toEqual({ arguments: { path: "a.ts", content: "xy" } });
	});

	it("shows non-object roots as no arguments yet", () => {
		const args = new ToolCallArgumentsStream();
		expect(args.append("[1,2")).toEqual({});
		args.append("]");
		expect(args.finish().argumentsError).toMatch(/^Tool arguments must be a JSON object/);
	});

	it("replaces the text with the provider's complete text, returning the missing piece", () => {
		const args = new ToolCallArgumentsStream();
		args.append('{"a":"x');
		expect(args.replace('{"a":"xyz"}')).toEqual({ delta: 'yz"}', arguments: { a: "xyz" } });
		expect(args.replace('{"b":2}')).toEqual({ delta: undefined, arguments: { b: 2 } });
		expect(args.text).toBe('{"b":2}');
	});

	it("is collected with its snapshots once the stream is dropped", async () => {
		const references: WeakRef<object>[] = [];
		(() => {
			const args = new ToolCallArgumentsStream();
			for (let index = 0; index < 100; index++) references.push(new WeakRef(args.append(`{"a${index}":"${index}`)));
			references.push(new WeakRef(args));
		})();
		await collectGarbage();
		expect(references.filter((reference) => reference.deref() !== undefined)).toEqual([]);
	});
});

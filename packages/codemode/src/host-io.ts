// A script's output and store, kept on the host: what `text()`, `image()`, `console.*`, `store()`, and `load()` do,
// with their checks, limits, and messages. These are sync host functions of the VM, so none of this code runs in it.
// They get the script's values plainly (outside the JSON boundary) and turn objects into JSON here.
import { RunExit } from "@earendil-works/djs";
import { MAX_OUTPUT_CHARS, MAX_OUTPUT_ITEMS, MAX_STORE_TOTAL_CHARS, MAX_STORE_VALUE_CHARS } from "./limits.ts";
import { consoleText, toJson } from "./script-values.ts";
import type { CodemodeOutputItem, CodemodeStoreWrites } from "./types.ts";

/** `store()` writes in order: `[key, json]`, `[key]` for a deletion. */
export type StoreWrite = [string, string] | [string];

/** Output and store of one script; a saved run carries `output` and `writes`, and a resumed one starts from them. */
export class ScriptIo {
	readonly output: CodemodeOutputItem[];
	/** Set once the output passed its limits: the run ended at once (the script cannot catch it) and fails with it. */
	failure: RangeError | undefined;
	private outputChars = 0;
	/** key -> JSON text written by the script, `undefined` for a deletion. */
	private readonly writes: Map<string, string | undefined>;
	/** key -> JSON text, as `load()` sees it. */
	private readonly stored: Map<string, string>;
	private storedChars = 0;

	constructor(
		store: Readonly<Record<string, unknown>>,
		output: readonly CodemodeOutputItem[],
		writes: readonly StoreWrite[],
	) {
		this.output = [...output];
		for (const item of this.output) this.outputChars += item.type === "text" ? item.text.length : item.data.length;
		this.writes = new Map(writes.map((write) => [write[0], write[1]]));
		this.stored = new Map();
		for (const [key, value] of Object.entries(store)) {
			const json = JSON.stringify(value);
			if (json !== undefined) this.stored.set(key, json);
		}
		for (const [key, json] of this.writes) {
			if (json === undefined) this.stored.delete(key);
			else this.stored.set(key, json);
		}
		for (const [key, json] of this.stored) this.storedChars += key.length + json.length;
	}

	/** `text(value)`: primitives as their string form, everything else as JSON. */
	text(value: unknown): void {
		this.add({ type: "text", text: outputText(value) });
	}

	/** `console.*(...args)`: one text item marked as console output. */
	console(args: readonly unknown[]): void {
		this.add({ type: "text", text: args.map(consoleText).join(" "), console: true });
	}

	/** `image(urlOrItem)`: a base64 `data:` URL, `{ image_url }`, or an image block, checked as providers would. */
	image(value: unknown): void {
		this.add(imageItem(value));
	}

	/** `store(key, value)`; `undefined` deletes the key. */
	store(key: unknown, value: unknown): void {
		if (typeof key !== "string") throw new TypeError("store() key must be a string");
		const previous = this.stored.get(key);
		const previousChars = previous === undefined ? 0 : key.length + previous.length;
		if (value === undefined) {
			this.stored.delete(key);
			this.storedChars -= previousChars;
			this.writes.set(key, undefined);
			return;
		}
		let json: string | undefined;
		try {
			json = toJson(value);
		} catch (error) {
			throw new TypeError(`store(${JSON.stringify(key)}) value is not JSON-serializable: ${consoleText(error)}`);
		}
		if (json === undefined) throw new TypeError(`store(${JSON.stringify(key)}) value is not JSON-serializable`);
		if (json.length > MAX_STORE_VALUE_CHARS) {
			throw new RangeError(
				`store(${JSON.stringify(key)}) value has ${json.length} characters of JSON, more than the limit of ${MAX_STORE_VALUE_CHARS}. ${STORE_HINT}`,
			);
		}
		const next = this.storedChars - previousChars + key.length + json.length;
		if (next > MAX_STORE_TOTAL_CHARS) {
			throw new RangeError(
				`store is full: stored values would exceed ${MAX_STORE_TOTAL_CHARS} characters of JSON. Delete keys with store(key, undefined). ${STORE_HINT}`,
			);
		}
		this.stored.set(key, json);
		this.storedChars = next;
		this.writes.set(key, json);
	}

	/** `load(key)`: a copy of the stored value. */
	load(key: unknown): unknown {
		if (typeof key !== "string") throw new TypeError("load() key must be a string");
		const json = this.stored.get(key);
		return json === undefined ? undefined : JSON.parse(json);
	}

	/** The writes in order, for a saved run. */
	savedWrites(): StoreWrite[] {
		return [...this.writes].map(([key, json]): StoreWrite => (json === undefined ? [key] : [key, json]));
	}

	/** The writes as a successful result reports them. */
	storeWrites(): CodemodeStoreWrites {
		const writes: CodemodeStoreWrites = { set: {}, delete: [] };
		for (const [key, json] of this.writes) {
			if (json === undefined) writes.delete.push(key);
			else writes.set[key] = JSON.parse(json);
		}
		return writes;
	}

	/** Past the limits the run ends at once and fails with `failure`: a script that catches errors cannot print on. */
	private add(item: CodemodeOutputItem): void {
		if (this.failure !== undefined) throw new RunExit();
		const chars = this.outputChars + (item.type === "text" ? item.text.length : item.data.length);
		if (chars > MAX_OUTPUT_CHARS || this.output.length + 1 > MAX_OUTPUT_ITEMS) {
			this.failure = new RangeError(
				`script output exceeded the limit of ${MAX_OUTPUT_CHARS} characters or ${MAX_OUTPUT_ITEMS} text(), image(), and console calls. Print a summary instead, or write large data to a file with a tool.`,
			);
			throw new RunExit();
		}
		this.outputChars = chars;
		this.output.push(item);
	}
}

const STORE_HINT =
	"store() is for small state such as IDs or summaries. Show images with image(), keep large data in variables, or write it to a file with a tool.";

/** Primitives become their string form, everything else JSON. */
function outputText(value: unknown): string {
	if (value === undefined || value === null || (typeof value !== "object" && typeof value !== "function")) {
		return String(value);
	}
	return toJson(value) ?? String(value);
}

const IMAGE_HELPER_EXPECTS =
	'image expects a non-empty image URL string, an object with image_url, or an image block { type: "image", data, mimeType }';

/** Base64 of the signatures of the formats providers accept inline (PNG, JPEG except JPEG-LS, GIF, "RIFF....WEBP"). */
const IMAGE_SIGNATURES: readonly [string, RegExp][] = [
	["image/png", /^iVBORw0KGg/],
	["image/jpeg", /^[/]9j[/](?!9)/],
	["image/gif", /^R0lGOD[dl]h/],
	["image/webp", /^UklG.{8}RUJQ/],
];

/**
 * The image item of what `image()` got. Providers reject the whole request on a bad image, and a persisted image block
 * would be resent on every later turn, so the data must be base64 of a known format. Line breaks from wrapped base64
 * are dropped; the declared type is ignored in favor of the detected one, as providers also reject mismatches.
 */
function imageItem(value: unknown): CodemodeOutputItem {
	const url = imageUrl(value);
	if (url === "") throw new TypeError(IMAGE_HELPER_EXPECTS);
	const colon = url.indexOf(":");
	const scheme = colon === -1 ? "" : url.slice(0, colon).toLowerCase();
	if (scheme === "http" || scheme === "https") {
		throw new TypeError("remote image URLs are not supported in tool outputs. Pass a base64 data URI instead");
	}
	const comma = url.indexOf(",");
	const header = comma === -1 ? [] : url.slice(colon + 1, comma).split(";");
	if (scheme !== "data" || comma === -1 || header.slice(1).every((part) => part.toLowerCase() !== "base64")) {
		throw new TypeError("invalid image output. Pass a base64 data URI instead");
	}
	const data = url.slice(comma + 1).replace(/\s+/g, "");
	if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
		throw new TypeError("invalid image output. The image data is not valid base64 (truncated or corrupted?)");
	}
	const head = data.slice(0, 16);
	const signature = IMAGE_SIGNATURES.find(([, pattern]) => pattern.test(head));
	if (signature === undefined) {
		throw new TypeError("invalid image output. The image data is not a PNG, JPEG, GIF, or WebP image");
	}
	return { type: "image", data, mimeType: signature[0] };
}

/** The data URL of `image()`'s argument. Script input: checked field by field. */
function imageUrl(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(IMAGE_HELPER_EXPECTS);
	const block = value as { image_url?: unknown; type?: unknown; data?: unknown };
	if (block.image_url !== undefined) {
		if (typeof block.image_url !== "string") throw new TypeError(IMAGE_HELPER_EXPECTS);
		return block.image_url;
	}
	if (typeof block.type !== "string") throw new TypeError(IMAGE_HELPER_EXPECTS);
	if (block.type !== "image") throw new TypeError(`image only accepts image blocks, got "${block.type}"`);
	if (typeof block.data !== "string" || block.data === "") throw new TypeError("image expected image block data");
	if (block.data.toLowerCase().startsWith("data:")) return block.data;
	return `data:;base64,${block.data}`;
}

/**
 * JavaScript evaluated inside the QuickJS VM before the script runs.
 *
 * The VM is its own wasm instance, so nothing here guards a realm boundary.
 * The prelude keeps the host bridge in a closure so the script cannot call it
 * directly, and builds `tools`, `ALL_TOOLS`, the output helpers (`text`, `image`,
 * `exit`, `console`), and globals on top of it. Tool arguments and results cross
 * as JSON strings and are parsed on this side.
 *
 * Output helpers: `text(value)` appends a text item (non-strings are
 * JSON-stringified), `image(urlOrItem)` appends an image from a base64 `data:` URL, an
 * `{ image_url }` object, or an MCP `ImageContent` block, and `exit()` ends the script
 * successfully. `console.*` appends text items like `text()`.
 *
 * `store(key, value)` and `load(key)` are synchronous: they work on a snapshot of
 * JSON text passed in as `storeJson`, and the keys the script wrote are reported
 * with a successful "done".
 *
 * Evaluates to a function `(bridge, toolsJson, globalsJson, storeJson) => { settle, run, stalled }`.
 * `toolsJson` lists `{ name, jsName, description }`: `tools[jsName]` and `tools[name]` call the
 * tool, and `ALL_TOOLS` lists `{ name: jsName, description }`.
 * `stalled()` reports a script that has not finished while no host call is pending: with no timers
 * or I/O in the VM, nothing can ever resume it.
 * `globalsJson` lists `{ name, spread }`; `a.b` names are grouped into a frozen `a` object.
 * `bridge(kind, a, b, c)` with kind "call" or "global" (id, name, argsJson),
 * "output" ("text", text) or ("image", data, mimeType), or "done" (ok, valueJsonOrErrorJson, writesJson).
 *
 * Before anything else the prelude freezes the built-ins and makes the built-in globals read-only.
 * The prelude shares them with the script, so a script that patched one (for example
 * `Array.prototype.toJSON`) could otherwise corrupt what the prelude reports to the host.
 */
export const MAX_STORE_VALUE_CHARS = 256 * 1024;
export const MAX_STORE_TOTAL_CHARS = 1024 * 1024;
/**
 * Output one script may produce with `text()`, `image()`, and `console.*`: characters of text and
 * base64 image data, and items. The host keeps all output until the script ends, so without a
 * limit a script that prints in a loop grows the host's memory until it crashes. The item limit
 * covers loops that print empty strings.
 */
export const MAX_OUTPUT_CHARS = 16 * 1024 * 1024;
export const MAX_OUTPUT_ITEMS = 100_000;

const IMAGE_HELPER_EXPECTS =
	"image expects a non-empty image URL string, an object with image_url, or a raw MCP image block";

export const PRELUDE_SOURCE: string = `(function (bridge, toolsJson, globalsJson, storeJson) {
	"use strict";

	// Freeze every object reachable from the built-in globals, plus the intrinsics that are only
	// reachable from instances (iterator and generator prototypes, %TypedArray%).
	//
	// Freezing alone breaks ordinary code through the "override mistake": a data property that is
	// read-only on a prototype cannot be assigned on an instance either, so
	// this.name = "MyError" in an Error subclass would throw. Commonly overridden properties
	// become accessors whose setter defines an own property on the instance instead.
	(function lockdown() {
		const OVERRIDABLE = new Set(["constructor", "name", "message", "toString", "toLocaleString", "valueOf", "toJSON"]);
		const seen = new Set([globalThis]);
		const queue = [];
		const add = (value) => {
			if ((typeof value === "object" && value !== null) || typeof value === "function") {
				if (!seen.has(value)) {
					seen.add(value);
					queue.push(value);
				}
			}
		};

		// Accessors from an object literal have no own prototype object, unlike function expressions,
		// whose prototype.constructor would be converted again without end.
		function allowOverride(object, key, value, enumerable) {
			const { get, set } = Object.getOwnPropertyDescriptor(
				{
					get accessor() {
						return value;
					},
					set accessor(next) {
						if (this === object) {
							throw new TypeError("Cannot assign to read only property '" + String(key) + "' of a built-in");
						}
						if ((typeof this !== "object" || this === null) && typeof this !== "function") return;
						Object.defineProperty(this, key, { value: next, writable: true, enumerable: true, configurable: true });
					},
				},
				"accessor",
			);
			Object.defineProperty(object, key, { get, set, enumerable, configurable: false });
			add(get);
			add(set);
		}

		for (const key of Reflect.ownKeys(globalThis)) {
			const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
			add(descriptor.value);
			add(descriptor.get);
			add(descriptor.set);
			if ("value" in descriptor && descriptor.configurable) {
				Object.defineProperty(globalThis, key, { writable: false, configurable: false });
			}
		}
		add(Object.getPrototypeOf(function* () {}));
		add(Object.getPrototypeOf(async function () {}));
		add(Object.getPrototypeOf(async function* () {}));
		add(Object.getPrototypeOf(Int8Array));
		add(Object.getPrototypeOf([][Symbol.iterator]()));
		add(Object.getPrototypeOf(new Map()[Symbol.iterator]()));
		add(Object.getPrototypeOf(new Set()[Symbol.iterator]()));
		add(Object.getPrototypeOf(""[Symbol.iterator]()));
		add(Object.getPrototypeOf(/a/[Symbol.matchAll]("")));
		if (typeof Iterator === "function") {
			if (typeof Iterator.prototype.map === "function") add(Object.getPrototypeOf([].values().map((x) => x)));
			if (typeof Iterator.from === "function") add(Object.getPrototypeOf(Iterator.from({ next() {} })));
		}

		while (queue.length > 0) {
			const object = queue.pop();
			add(Object.getPrototypeOf(object));
			const descriptors = Object.getOwnPropertyDescriptors(object);
			for (const key of Reflect.ownKeys(descriptors)) {
				const descriptor = descriptors[key];
				if ("value" in descriptor) {
					add(descriptor.value);
					if (
						descriptor.writable &&
						descriptor.configurable &&
						(object === Object.prototype || OVERRIDABLE.has(key))
					) {
						allowOverride(object, key, descriptor.value, descriptor.enumerable);
					}
				} else {
					add(descriptor.get);
					add(descriptor.set);
				}
			}
			Object.freeze(object);
		}
	})();
	const stringify = JSON.stringify;
	const parse = JSON.parse;
	const promiseThen = Promise.prototype.then;
	const ErrorCtor = Error;
	const TypeErrorCtor = TypeError;
	const RangeErrorCtor = RangeError;
	const pending = new Map();
	let nextId = 1;
	let finished = false;
	// Thrown by exit() to unwind the script after it already reported success.
	const EXIT = Object.freeze({});

	function done(ok, payload, writes) {
		if (finished) return;
		finished = true;
		bridge("done", ok, payload, writes);
	}

	function serialize(value) {
		return value === undefined ? undefined : stringify(value);
	}

	// QuickJS stacks list frames only. Prefix "Name: message" like V8 so the
	// text reads the same as a Node error, and drop this prelude's frames.
	function errorText(error) {
		const head = error.message ? error.name + ": " + error.message : String(error.name);
		const frames =
			typeof error.stack === "string"
				? error.stack.split("\\n").filter((line) => line.trim() && !line.includes("codemode-prelude.js"))
				: [];
		return [head, ...frames].join("\\n");
	}

	function format(value) {
		if (typeof value === "string") return value;
		if (value instanceof ErrorCtor) return errorText(value);
		try {
			const json = stringify(value);
			return json === undefined ? String(value) : json;
		} catch {
			return String(value);
		}
	}

	// The host requires string fields. A script can set an error's name or message to anything, so
	// they are coerced, and a value whose coercion throws gets a placeholder.
	function describeError(error) {
		try {
			if (error instanceof ErrorCtor) {
				return stringify({ name: String(error.name), message: String(error.message), stack: errorText(error) });
			}
			return stringify({ message: String(format(error)) });
		} catch {
			return stringify({ message: "The script threw a value that cannot be described" });
		}
	}

	function caller(kind, name, spread) {
		return (...args) =>
			new Promise((resolve, reject) => {
				let json;
				try {
					json = serialize(spread ? args : args[0]);
				} catch (error) {
					reject(error);
					return;
				}
				const id = nextId++;
				pending.set(id, { resolve, reject });
				bridge(kind, id, name, json);
			});
	}

	const tools = Object.create(null);
	const allTools = [];
	for (const { name, jsName, description } of parse(toolsJson)) {
		const fn = caller("call", name);
		// The first tool wins when two names normalize to the same identifier.
		if (!(jsName in tools)) {
			tools[jsName] = fn;
			allTools.push(Object.freeze({ name: jsName, description }));
		}
		if (!(name in tools)) tools[name] = fn;
	}
	Object.freeze(tools);
	Object.freeze(allTools);

	// Reading a member that does not exist throws an error that names the close matches, instead of
	// a later "not a function". \`in\` checks still work.
	const comparable = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
	function guard(target, label, names, hint) {
		return new Proxy(target, {
			get(object, property, receiver) {
				if (typeof property !== "string" || property in object || property in Object.prototype || property === "then" || property === "toJSON") {
					return Reflect.get(object, property, receiver);
				}
				const wanted = comparable(property);
				const exact = names.filter((name) => comparable(name) === wanted);
				const close = exact.length > 0 ? exact : names.filter((name) => wanted && (comparable(name).includes(wanted) || wanted.includes(comparable(name))));
				let message = label + "." + property + " does not exist.";
				if (close.length > 0) message += " Did you mean " + close.slice(0, 5).map((name) => label + "." + name).join(", ") + "?";
				else if (names.length <= 20) message += " Available: " + names.join(", ") + ".";
				if (hint) message += " " + hint;
				message += ' Check for a member with "' + property + '" in ' + label + ".";
				throw new TypeErrorCtor(message);
			},
		});
	}
	const toolsProxy = guard(
		tools,
		"tools",
		allTools.map((tool) => tool.name),
		"ALL_TOOLS lists every tool; searchTools(query) finds tools by topic.",
	);

	const namespaces = new Map();
	for (const { name, spread } of parse(globalsJson)) {
		const fn = caller("global", name, spread);
		const dot = name.indexOf(".");
		if (dot === -1) {
			Object.defineProperty(globalThis, name, { value: fn, enumerable: true });
			continue;
		}
		const namespace = name.slice(0, dot);
		if (!namespaces.has(namespace)) namespaces.set(namespace, Object.create(null));
		namespaces.get(namespace)[name.slice(dot + 1)] = fn;
	}
	for (const [namespace, members] of namespaces) {
		Object.freeze(members);
		const value = guard(members, namespace, Object.keys(members));
		Object.defineProperty(globalThis, namespace, { value, enumerable: true });
	}

	// key -> JSON text. Sizes count key and JSON characters.
	const stored = new Map(Object.entries(parse(storeJson)));
	const writes = new Map();
	let storedChars = 0;
	for (const [key, json] of stored) storedChars += key.length + json.length;

	const STORE_HINT =
		"store() is for small state such as IDs or summaries. Show images with image(), keep large data in variables, or write it to a file with a tool.";

	function checkKey(name, key) {
		if (typeof key !== "string") throw new TypeError(name + "() key must be a string");
	}

	function store(key, value) {
		checkKey("store", key);
		const previous = stored.has(key) ? key.length + stored.get(key).length : 0;
		if (value === undefined) {
			stored.delete(key);
			storedChars -= previous;
			writes.set(key, undefined);
			return;
		}
		let json;
		try {
			json = stringify(value);
		} catch (error) {
			throw new TypeError("store(" + stringify(key) + ") value is not JSON-serializable: " + format(error));
		}
		if (json === undefined) {
			throw new TypeError("store(" + stringify(key) + ") value is not JSON-serializable");
		}
		if (json.length > ${MAX_STORE_VALUE_CHARS}) {
			throw new RangeError(
				"store(" + stringify(key) + ") value has " + json.length + " characters of JSON, more than the limit of ${MAX_STORE_VALUE_CHARS}. " +
					STORE_HINT,
			);
		}
		const next = storedChars - previous + key.length + json.length;
		if (next > ${MAX_STORE_TOTAL_CHARS}) {
			throw new RangeError(
				"store is full: stored values would exceed ${MAX_STORE_TOTAL_CHARS} characters of JSON. Delete keys with store(key, undefined). " +
					STORE_HINT,
			);
		}
		stored.set(key, json);
		storedChars = next;
		writes.set(key, json);
	}

	function load(key) {
		checkKey("load", key);
		const json = stored.get(key);
		return json === undefined ? undefined : parse(json);
	}

	function serializeWrites() {
		const entries = [];
		for (const [key, json] of writes) entries.push(json === undefined ? [key] : [key, json]);
		return stringify(entries);
	}

	Object.defineProperty(globalThis, "store", { value: store, enumerable: true });
	Object.defineProperty(globalThis, "load", { value: load, enumerable: true });

	let outputChars = 0;
	let outputItems = 0;

	// Past the output limits the script fails: done() reports the error, so catching it does not
	// resume output, and the host ends the script.
	function output(kind, data, mimeType) {
		if (finished) return;
		outputChars += data.length;
		outputItems++;
		if (outputChars > ${MAX_OUTPUT_CHARS} || outputItems > ${MAX_OUTPUT_ITEMS}) {
			const error = new RangeErrorCtor(
				"script output exceeded the limit of ${MAX_OUTPUT_CHARS} characters or ${MAX_OUTPUT_ITEMS} text(), image(), and console calls. " +
					"Print a summary instead, or write large data to a file with a tool.",
			);
			done(false, describeError(error));
			throw error;
		}
		bridge("output", kind, data, mimeType);
	}

	// Primitives become their string form, everything else JSON.
	function outputText(value) {
		if (value === undefined || value === null || typeof value !== "object" && typeof value !== "function") {
			return String(value);
		}
		const json = stringify(value);
		return json === undefined ? String(value) : json;
	}

	function text(value) {
		let rendered;
		try {
			rendered = outputText(value);
		} catch (error) {
			throw new TypeErrorCtor(error instanceof ErrorCtor ? error.message : String(error));
		}
		output("text", rendered);
	}

	function imageUrl(value) {
		if (typeof value === "string") return value;
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new TypeErrorCtor(${JSON.stringify(IMAGE_HELPER_EXPECTS)});
		}
		if (value.image_url !== undefined) {
			if (typeof value.image_url !== "string") throw new TypeErrorCtor(${JSON.stringify(IMAGE_HELPER_EXPECTS)});
			return value.image_url;
		}
		if (typeof value.type !== "string") throw new TypeErrorCtor(${JSON.stringify(IMAGE_HELPER_EXPECTS)});
		if (value.type !== "image") {
			throw new TypeErrorCtor('image only accepts MCP image blocks, got "' + value.type + '"');
		}
		if (typeof value.data !== "string" || value.data === "") throw new TypeErrorCtor("image expected MCP image data");
		if (value.data.toLowerCase().startsWith("data:")) return value.data;
		return "data:;base64," + value.data;
	}

	// Base64 of the signatures of the formats providers accept inline (PNG, JPEG except
	// JPEG-LS, GIF, "RIFF....WEBP"). Signatures start at byte 0, so their encodings are prefixes.
	const IMAGE_SIGNATURES = [
		["image/png", /^iVBORw0KGg/],
		["image/jpeg", /^[/]9j[/](?!9)/],
		["image/gif", /^R0lGOD[dl]h/],
		["image/webp", /^UklG.{8}RUJQ/],
	];

	function image(value) {
		const url = imageUrl(value);
		if (url === "") throw new TypeErrorCtor(${JSON.stringify(IMAGE_HELPER_EXPECTS)});
		const colon = url.indexOf(":");
		const scheme = colon === -1 ? "" : url.slice(0, colon).toLowerCase();
		if (scheme === "http" || scheme === "https") {
			throw new TypeErrorCtor("remote image URLs are not supported in tool outputs. Pass a base64 data URI instead");
		}
		const comma = url.indexOf(",");
		const header = comma === -1 ? [] : url.slice(colon + 1, comma).split(";");
		if (scheme !== "data" || comma === -1 || header.slice(1).every((part) => part.toLowerCase() !== "base64")) {
			throw new TypeErrorCtor("invalid image output. Pass a base64 data URI instead");
		}
		// Providers reject the whole request on a bad image, and a persisted image block would be
		// resent on every later turn. Line breaks from wrapped base64 are dropped. The declared type
		// is ignored in favor of the detected one, as providers also reject mismatches.
		const data = url.slice(comma + 1).replace(/\\s+/g, "");
		if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
			throw new TypeErrorCtor("invalid image output. The image data is not valid base64 (truncated or corrupted?)");
		}
		const head = data.slice(0, 16);
		const signature = IMAGE_SIGNATURES.find(([, pattern]) => pattern.test(head));
		if (!signature) {
			throw new TypeErrorCtor("invalid image output. The image data is not a PNG, JPEG, GIF, or WebP image");
		}
		output("image", data, signature[0]);
	}

	function exit() {
		let writesJson;
		try {
			writesJson = serializeWrites();
		} catch (error) {
			done(false, describeError(error));
			throw EXIT;
		}
		done(true, undefined, writesJson);
		throw EXIT;
	}

	const console = {};
	for (const level of ["log", "info", "warn", "error", "debug"]) {
		console[level] = (...args) => {
			output("text", args.map(format).join(" "));
		};
	}
	Object.freeze(console);

	Object.defineProperty(globalThis, "tools", { value: toolsProxy, enumerable: true });
	Object.defineProperty(globalThis, "ALL_TOOLS", { value: allTools, enumerable: true });
	Object.defineProperty(globalThis, "console", { value: console, enumerable: true });
	Object.defineProperty(globalThis, "text", { value: text, enumerable: true });
	Object.defineProperty(globalThis, "image", { value: image, enumerable: true });
	Object.defineProperty(globalThis, "exit", { value: exit, enumerable: true });

	return {
		settle(id, ok, payload) {
			const entry = pending.get(id);
			if (!entry) return;
			pending.delete(id);
			if (!ok) {
				entry.reject(new ErrorCtor(payload));
				return;
			}
			let value;
			try {
				value = payload === undefined ? undefined : parse(payload);
			} catch (error) {
				entry.reject(error);
				return;
			}
			entry.resolve(value);
		},
		run(fn) {
			let promise;
			try {
				promise = fn(toolsProxy, console);
			} catch (error) {
				done(false, describeError(error));
				return;
			}
			promiseThen.call(
				promise,
				(value) => {
					let json;
					try {
						json = serialize(value);
					} catch (error) {
						done(false, describeError(error));
						return;
					}
					done(true, json, serializeWrites());
				},
				(error) => {
					done(false, describeError(error));
				},
			);
		},
		stalled() {
			if (finished || pending.size > 0) return false;
			done(
				false,
				stringify({
					name: "Error",
					message:
						"The script is waiting on a promise that can never settle: no tool call is pending, and timers do not exist here.",
				}),
			);
			return true;
		},
	};
})`;

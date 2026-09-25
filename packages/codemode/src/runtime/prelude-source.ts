/**
 * JavaScript evaluated inside the QuickJS VM before the script runs.
 *
 * The VM is its own wasm instance, so nothing here guards a realm boundary.
 * The prelude keeps the host bridge in a closure so the script cannot call it
 * directly, and builds `tools`, `console`, and globals on top of it. Tool
 * arguments and results cross as JSON strings and are parsed on this side.
 *
 * Evaluates to a function `(bridge, toolNamesJson, globalNamesJson) => { settle, run }`.
 * `bridge(kind, a, b, c)` with kind "call" or "global" (id, name, argsJson),
 * "log" (level, message) or "done" (ok, valueJsonOrErrorJson).
 */
export const PRELUDE_SOURCE: string = `(function (bridge, toolNamesJson, globalNamesJson) {
	"use strict";
	const stringify = JSON.stringify;
	const parse = JSON.parse;
	const promiseThen = Promise.prototype.then;
	const ErrorCtor = Error;
	const pending = new Map();
	let nextId = 1;

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

	function describeError(error) {
		if (error instanceof ErrorCtor) {
			return stringify({ name: error.name, message: error.message, stack: errorText(error) });
		}
		return stringify({ message: format(error) });
	}

	function caller(kind, name) {
		return (args) =>
			new Promise((resolve, reject) => {
				let json;
				try {
					json = serialize(args);
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
	for (const name of parse(toolNamesJson)) {
		tools[name] = caller("call", name);
	}
	Object.freeze(tools);

	for (const name of parse(globalNamesJson)) {
		Object.defineProperty(globalThis, name, { value: caller("global", name), enumerable: true });
	}

	const console = {};
	for (const level of ["log", "info", "warn", "error", "debug"]) {
		console[level] = (...args) => {
			bridge("log", level, args.map(format).join(" "));
		};
	}
	Object.freeze(console);

	Object.defineProperty(globalThis, "tools", { value: tools, enumerable: true });
	Object.defineProperty(globalThis, "console", { value: console, enumerable: true });

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
				promise = fn(tools, console);
			} catch (error) {
				bridge("done", false, describeError(error));
				return;
			}
			promiseThen.call(
				promise,
				(value) => {
					let json;
					try {
						json = serialize(value);
					} catch (error) {
						bridge("done", false, describeError(error));
						return;
					}
					bridge("done", true, json);
				},
				(error) => {
					bridge("done", false, describeError(error));
				},
			);
		},
	};
})`;

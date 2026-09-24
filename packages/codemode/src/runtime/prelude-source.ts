/**
 * JavaScript evaluated inside the vm context before the script runs.
 *
 * Boundary rule: nothing from the worker realm may become reachable from the
 * script, because a worker-realm function's `constructor` is a `Function`
 * that is not subject to the context's code-generation ban and can reach
 * `process`. The single crossing is `bridge`, which this prelude keeps in a
 * closure. It is only ever called with primitives and returns undefined.
 *
 * Everything the script can touch (`tools`, `console`, promises, errors) is
 * created here, in the context realm. Tool arguments and results cross as JSON
 * strings and are parsed on this side.
 *
 * Evaluates to a function `(bridge, toolNamesJson, globalNamesJson) => { settle, run }`.
 * `bridge(kind, a, b, c)` with kind "call" or "global" (id, name, argsJson),
 * "log" (level, message) or "done" (ok, valueJsonOrErrorJson).
 */
export const PRELUDE_SOURCE: string = `(function (bridge, toolNamesJson, globalNamesJson) {
	"use strict";
	// Works on Node. Bun's vm global re-materializes these, so the script
	// wrapper additionally shadows them with parameters. Wasm compilation is
	// blocked by codeGeneration.wasm on both runtimes regardless.
	delete globalThis.WebAssembly;
	delete globalThis.SharedArrayBuffer;
	delete globalThis.Atomics;

	const stringify = JSON.stringify;
	const parse = JSON.parse;
	const promiseThen = Promise.prototype.then;
	const ErrorCtor = Error;
	const pending = new Map();
	let nextId = 1;

	function serialize(value) {
		return value === undefined ? undefined : stringify(value);
	}

	function format(value) {
		if (typeof value === "string") return value;
		if (value instanceof ErrorCtor) return value.stack || String(value);
		try {
			const json = stringify(value);
			return json === undefined ? String(value) : json;
		} catch {
			return String(value);
		}
	}

	function describeError(error) {
		if (error instanceof ErrorCtor) {
			return stringify({ name: error.name, message: error.message, stack: error.stack });
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

	// console is only bound as a parameter of the script wrapper: Bun's vm
	// global has a lazily installed no-op console that ignores every override.
	Object.defineProperty(globalThis, "tools", { value: tools, enumerable: true });

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

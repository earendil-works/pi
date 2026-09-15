import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { CodemodeSandbox, type CodemodeTool } from "../src/index.ts";
import { PRELUDE_SOURCE } from "../src/runtime/prelude-source.ts";
import { WORKER_SOURCE } from "../src/runtime/worker-source.ts";

const sandboxes: CodemodeSandbox[] = [];

function createSandbox(tools: CodemodeTool[] = [], timeoutMs = 10_000): CodemodeSandbox {
	const sandbox = new CodemodeSandbox({ tools, timeoutMs });
	sandboxes.push(sandbox);
	return sandbox;
}

afterEach(async () => {
	await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.close()));
});

const echo: CodemodeTool = { name: "echo", execute: (args) => args };

describe("embedded sources", () => {
	it("parse as JavaScript", () => {
		expect(() => new vm.Script(PRELUDE_SOURCE, { filename: "prelude.js" })).not.toThrow();
		expect(() => new vm.Script(WORKER_SOURCE, { filename: "worker.js" })).not.toThrow();
	});
});

describe("script execution", () => {
	it("returns the script's return value after a JSON round trip", async () => {
		const sandbox = createSandbox();
		expect(await sandbox.execute("return { a: 1, b: [true, 'x'] }")).toMatchObject({
			ok: true,
			value: { a: 1, b: [true, "x"] },
			logs: [],
			calls: [],
		});
		expect(await sandbox.execute("return 'plain'")).toMatchObject({ ok: true, value: "plain" });
		expect(await sandbox.execute("")).toMatchObject({ ok: true, value: undefined });
	});

	it("supports top-level await", async () => {
		const sandbox = createSandbox();
		const result = await sandbox.execute("const x = await Promise.resolve(41); return x + 1");
		expect(result).toMatchObject({ ok: true, value: 42 });
	});

	it("captures console output in order", async () => {
		const sandbox = createSandbox();
		const result = await sandbox.execute(`
			console.log("hello", 1, { a: 1 });
			console.warn("careful");
			console.error(new Error("bad"));
			return null;
		`);
		expect(result.ok).toBe(true);
		expect(result.logs.map((log) => log.level)).toEqual(["log", "warn", "error"]);
		expect(result.logs[0].message).toBe('hello 1 {"a":1}');
		expect(result.logs[1].message).toBe("careful");
		expect(result.logs[2].message).toMatch(/^Error: bad/);
	});

	it("reports syntax errors with the script's line number", async () => {
		const sandbox = createSandbox();
		const result = await sandbox.execute("const a = 1;\nconst b = ;\nreturn a");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe("script");
		expect(result.error.name).toBe("SyntaxError");
		expect(result.error.stack).toMatch(/codemode\.js:2/);
	});

	it("reports thrown errors with the script's line number", async () => {
		const sandbox = createSandbox();
		const result = await sandbox.execute("const a = 1;\nthrow new TypeError('boom ' + a)");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatchObject({ kind: "script", name: "TypeError", message: "boom 1" });
		expect(result.error.stack).toMatch(/codemode\.js:2/);
	});

	it("reports non-Error throws", async () => {
		const sandbox = createSandbox();
		const result = await sandbox.execute("throw { code: 7 }");
		expect(result).toMatchObject({ ok: false, error: { kind: "script", message: '{"code":7}' } });
	});

	it("reports a non-serializable return value as a script error", async () => {
		const sandbox = createSandbox();
		const result = await sandbox.execute("return 10n");
		expect(result).toMatchObject({ ok: false, error: { kind: "script", name: "TypeError" } });
	});
});

describe("tools", () => {
	it("exposes tools as async functions and records calls", async () => {
		const seen: unknown[] = [];
		const sandbox = createSandbox([
			{
				name: "add",
				execute: (args) => {
					seen.push(args);
					const { a, b } = args as { a: number; b: number };
					return { sum: a + b };
				},
			},
		]);
		const result = await sandbox.execute(`
			const first = await tools.add({ a: 1, b: 2 });
			const second = await tools.add({ a: first.sum, b: 10 });
			return second.sum;
		`);
		expect(result).toMatchObject({ ok: true, value: 13 });
		expect(seen).toEqual([
			{ a: 1, b: 2 },
			{ a: 3, b: 10 },
		]);
		expect(result.calls.map((call) => [call.name, call.status])).toEqual([
			["add", "ok"],
			["add", "ok"],
		]);
		expect(result.calls.every((call) => call.durationMs >= 0)).toBe(true);
	});

	it("runs concurrent calls and lists tool names", async () => {
		const sandbox = createSandbox([
			echo,
			{ name: "delay", execute: (args) => new Promise((resolve) => setTimeout(() => resolve(args), 20)) },
		]);
		const result = await sandbox.execute(`
			const [a, b, c] = await Promise.all([tools.delay(1), tools.delay(2), tools.echo(3)]);
			return { values: [a, b, c], names: Object.keys(tools) };
		`);
		expect(result).toMatchObject({ ok: true, value: { values: [1, 2, 3], names: ["echo", "delay"] } });
	});

	it("passes undefined arguments and results through", async () => {
		const sandbox = createSandbox([{ name: "noop", execute: (args) => args }]);
		const result = await sandbox.execute("return [await tools.noop(), await tools.noop(null)]");
		expect(result).toMatchObject({ ok: true, value: [null, null] });
	});

	it("turns tool errors into catchable Errors in the script", async () => {
		const sandbox = createSandbox([
			{
				name: "fail",
				execute: () => {
					throw new Error("tool exploded");
				},
			},
		]);
		const result = await sandbox.execute(`
			try {
				await tools.fail();
				return "no error";
			} catch (error) {
				return { isError: error instanceof Error, message: error.message };
			}
		`);
		expect(result).toMatchObject({ ok: true, value: { isError: true, message: "tool exploded" } });
		expect(result.calls).toMatchObject([{ name: "fail", status: "error" }]);
	});

	it("rejects calls to unknown tools", async () => {
		const sandbox = createSandbox();
		const result = await sandbox.execute("return await tools.missing()");
		expect(result).toMatchObject({ ok: false, error: { kind: "script", name: "TypeError" } });
	});

	it("aborts unawaited calls when the script returns", async () => {
		let aborted = false;
		const sandbox = createSandbox([
			{
				name: "slow",
				execute: (_args, { signal }) =>
					new Promise((_resolve, reject) => {
						signal.addEventListener("abort", () => {
							aborted = true;
							reject(new Error("aborted"));
						});
					}),
			},
		]);
		const result = await sandbox.execute("tools.slow(); return 'early'");
		expect(result).toMatchObject({ ok: true, value: "early" });
		expect(result.calls).toMatchObject([{ name: "slow", status: "cancelled" }]);
		expect(aborted).toBe(true);
	});

	it("supports register and unregister between executions", async () => {
		const sandbox = createSandbox();
		sandbox.registerTool(echo);
		expect(() => sandbox.registerTool(echo)).toThrow(/already registered/);
		expect(sandbox.tools.map((tool) => tool.name)).toEqual(["echo"]);
		expect(await sandbox.execute("return await tools.echo('a')")).toMatchObject({ ok: true, value: "a" });
		expect(sandbox.unregisterTool("echo")).toBe(true);
		expect(await sandbox.execute("return typeof tools.echo")).toMatchObject({ ok: true, value: "undefined" });
	});
});

describe("limits and lifetime", () => {
	it("terminates a synchronous infinite loop on timeout", async () => {
		const sandbox = createSandbox();
		const started = performance.now();
		const result = await sandbox.execute("while (true) {}", { timeoutMs: 200 });
		expect(result).toMatchObject({ ok: false, error: { kind: "timeout" } });
		expect(performance.now() - started).toBeLessThan(5_000);
	});

	it("terminates a microtask-spinning loop on timeout", async () => {
		const sandbox = createSandbox();
		const result = await sandbox.execute("while (true) await null", { timeoutMs: 200 });
		expect(result).toMatchObject({ ok: false, error: { kind: "timeout" } });
	});

	it("aborts via signal and cancels in-flight calls", async () => {
		const controller = new AbortController();
		let toolSignal: AbortSignal | undefined;
		const sandbox = createSandbox([
			{
				name: "hang",
				execute: (_args, { signal }) => {
					toolSignal = signal;
					return new Promise(() => {});
				},
			},
		]);
		const promise = sandbox.execute("await tools.hang(); return 'never'");
		await new Promise((resolve) => setTimeout(resolve, 50));
		controller.abort(new Error("user cancelled"));
		expect(toolSignal?.aborted).toBe(false);
		const result = await sandbox.execute("await tools.hang()", { signal: controller.signal });
		expect(result).toMatchObject({ ok: false, error: { kind: "aborted", message: "user cancelled" } });

		const second = new AbortController();
		const pending = sandbox.execute("await tools.hang(); return 'never'", { signal: second.signal });
		await new Promise((resolve) => setTimeout(resolve, 50));
		second.abort();
		const aborted = await pending;
		expect(aborted).toMatchObject({ ok: false, error: { kind: "aborted" } });
		expect(aborted.calls).toMatchObject([{ name: "hang", status: "cancelled" }]);
		expect(toolSignal?.aborted).toBe(true);

		await sandbox.close();
		expect(await promise).toMatchObject({ ok: false, error: { kind: "aborted", message: "Sandbox closed" } });
	});

	it("rejects execute after close", async () => {
		const sandbox = createSandbox();
		await sandbox.close();
		await expect(sandbox.execute("return 1")).rejects.toThrow(/closed/);
	});

	it("runs executions in parallel without sharing state", async () => {
		const sandbox = createSandbox();
		const results = await Promise.all([
			sandbox.execute("globalThis.shared = 'a'; await null; return globalThis.shared"),
			sandbox.execute("globalThis.shared = 'b'; await null; return globalThis.shared"),
			sandbox.execute("return typeof globalThis.shared"),
		]);
		expect(results.map((result) => (result.ok ? result.value : result.error))).toEqual(["a", "b", "undefined"]);
	});

	it.skipIf(typeof process.versions.bun === "string")(
		"reports an out-of-memory worker as a sandbox error",
		async () => {
			const sandbox = new CodemodeSandbox({ timeoutMs: 20_000, maxOldGenerationSizeMb: 32 });
			sandboxes.push(sandbox);
			const result = await sandbox.execute("const a = []; while (true) a.push(new Array(1e5).fill('x'))");
			expect(result).toMatchObject({ ok: false, error: { kind: "sandbox" } });
		},
	);
});

describe("escape hatches", () => {
	it("has no host globals", async () => {
		const sandbox = createSandbox();
		const result = await sandbox.execute(`
			return [
				typeof process, typeof require, typeof module, typeof setTimeout, typeof fetch,
				typeof WebAssembly, typeof SharedArrayBuffer, typeof Atomics, typeof globalThis.constructor,
			]
		`);
		expect(result).toMatchObject({
			ok: true,
			value: [
				"undefined",
				"undefined",
				"undefined",
				"undefined",
				"undefined",
				"undefined",
				"undefined",
				"undefined",
				"function",
			],
		});
	});

	it("blocks code generation from strings and dynamic import", async () => {
		const sandbox = createSandbox([echo]);
		const result = await sandbox.execute(`
			const attempts = [
				() => eval("1"),
				() => new Function("return process")(),
				() => this.constructor.constructor("return process")(),
				() => tools.echo.constructor("return process")(),
				() => (async () => {}).constructor("return process")(),
				() => Object.getPrototypeOf(async function () {}).constructor("return process")(),
			];
			const outcomes = [];
			for (const attempt of attempts) {
				try { outcomes.push(typeof attempt()); } catch (error) { outcomes.push(error.constructor.name); }
			}
			try { await import("node:fs"); outcomes.push("imported"); } catch (error) { outcomes.push(error.constructor.name); }
			return outcomes;
		`);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const outcomes = result.value as string[];
		expect(outcomes.slice(0, 6).every((outcome) => outcome === "EvalError" || outcome === "TypeError")).toBe(true);
		expect(outcomes[6]).not.toBe("imported");
	});

	it("blocks WebAssembly even through globalThis", async () => {
		// Bun's vm global re-materializes WebAssembly after deletion, so the
		// embedder flag is the real barrier.
		const sandbox = createSandbox();
		const result = await sandbox.execute(`
			if (typeof globalThis.WebAssembly === "undefined") return "absent";
			try {
				new globalThis.WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
				return "compiled";
			} catch (error) {
				return error.constructor.name;
			}
		`);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(["absent", "CompileError"]).toContain(result.value);
	});

	it("never hands worker-realm functions to a patched Promise.prototype.then", async () => {
		// If the worker ever awaited a context promise directly, the patched
		// `then` would receive worker-realm callbacks whose `constructor` is not
		// subject to the context's code-generation ban. Exiting the worker makes
		// that observable here as a sandbox error.
		const sandbox = createSandbox([echo]);
		const result = await sandbox.execute(`
			const originalThen = Promise.prototype.then;
			Promise.prototype.then = function (onFulfilled, onRejected) {
				for (const callback of [onFulfilled, onRejected]) {
					try { callback.constructor("return process")().exit(42); } catch {}
				}
				return originalThen.call(this, onFulfilled, onRejected);
			};
			await tools.echo(1);
			return "clean";
		`);
		expect(result).toMatchObject({ ok: true, value: "clean" });
	});

	it("keeps tools and console frozen", async () => {
		const sandbox = createSandbox([echo]);
		const result = await sandbox.execute(`
			try { tools.echo = () => 'nope'; } catch {}
			try { tools.extra = () => 'nope'; } catch {}
			try { globalThis.tools = null; } catch {}
			return [typeof tools.extra, await tools.echo('still')];
		`);
		expect(result).toMatchObject({ ok: true, value: ["undefined", "still"] });
	});
});

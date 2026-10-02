import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { CodemodeSandbox, type CodemodeTool } from "../src/index.ts";
import { PRELUDE_SOURCE } from "../src/runtime/prelude-source.ts";

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

// Base64 of the leading bytes of each format. image() only inspects the signature.
const PNG = "iVBORw0KGgo=";
const JPEG = "/9j/4A==";
const GIF = "R0lGODlh";
const WEBP = "UklGRgAAAABXRUJQ";

describe("embedded sources", () => {
	it("parse as JavaScript", () => {
		expect(() => new vm.Script(PRELUDE_SOURCE, { filename: "prelude.js" })).not.toThrow();
	});
});

describe("script execution", () => {
	it("returns the script's return value after a JSON round trip", async () => {
		const sandbox = createSandbox();
		expect(await sandbox.execute("return { a: 1, b: [true, 'x'] }")).toMatchObject({
			ok: true,
			value: { a: 1, b: [true, "x"] },
			output: [],
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

	it("collects text(), image(), and console output in order", async () => {
		const sandbox = createSandbox();
		const result = await sandbox.execute(`
			console.log("hello", 1, { a: 1 });
			text({ json: true });
			text(undefined);
			text(7);
			image("data:image/png;base64,${PNG}");
			image({ image_url: "data:image/jpeg;base64,${JPEG}" });
			image({ type: "image", data: "${GIF}", mimeType: "image/gif" });
			image("data:image/png;base64,${WEBP}");
			image({ type: "image", data: "${PNG}" });
			console.error(new Error("bad"));
			return null;
		`);
		expect(result.ok).toBe(true);
		expect(result.output.slice(0, -1)).toEqual([
			{ type: "text", text: 'hello 1 {"a":1}' },
			{ type: "text", text: '{"json":true}' },
			{ type: "text", text: "undefined" },
			{ type: "text", text: "7" },
			{ type: "image", data: PNG, mimeType: "image/png" },
			{ type: "image", data: JPEG, mimeType: "image/jpeg" },
			{ type: "image", data: GIF, mimeType: "image/gif" },
			// The MIME type comes from the data, not from the declared type.
			{ type: "image", data: WEBP, mimeType: "image/webp" },
			{ type: "image", data: PNG, mimeType: "image/png" },
		]);
		expect(result.output.at(-1)).toMatchObject({ type: "text", text: expect.stringMatching(/^Error: bad/) });
	});

	it("rejects invalid text() and image() arguments", async () => {
		const sandbox = createSandbox();
		const result = await sandbox.execute(`
			const errors = [];
			const circular = {};
			circular.self = circular;
			for (const run of [
				() => text(circular),
				() => image(""),
				() => image("https://example.com/a.png"),
				() => image("data:image/png,raw"),
				() => image({ type: "text", text: "x" }),
				() => image({ type: "image", data: "" }),
				() => image(42),
				() => image("data:image/png;base64,AAAA!"),
				() => image("data:image/png;base64,AAAAA"),
				() => image("data:image/png;base64,AA=A"),
				() => image("data:image/png;base64,"),
				() => image("data:image/png;base64,AAAA\\n[Output truncated]"),
				() => image({ type: "image", data: "AAAA!", mimeType: "image/png" }),
				() => image("data:image/png;base64,AAAA"),
				() => image("data:image/png;base64,QUJD"),
				() => image("data:image/jpeg;base64,/9j/9w=="),
			]) {
				try { run(); errors.push("no error"); } catch (error) { errors.push(error.name + ": " + error.message); }
			}
			return errors;
		`);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.output).toEqual([]);
		const errors = result.value as string[];
		expect(errors[0]).toMatch(/^TypeError: .*circular/);
		expect(errors.slice(1)).toEqual([
			"TypeError: image expects a non-empty image URL string, an object with image_url, or a raw MCP image block",
			"TypeError: remote image URLs are not supported in tool outputs. Pass a base64 data URI instead",
			"TypeError: invalid image output. Pass a base64 data URI instead",
			'TypeError: image only accepts MCP image blocks, got "text"',
			"TypeError: image expected MCP image data",
			"TypeError: image expects a non-empty image URL string, an object with image_url, or a raw MCP image block",
			...Array(6).fill(
				"TypeError: invalid image output. The image data is not valid base64 (truncated or corrupted?)",
			),
			...Array(3).fill("TypeError: invalid image output. The image data is not a PNG, JPEG, GIF, or WebP image"),
		]);
	});

	// https://github.com/earendil-works/pi/issues/10215
	it("accepts wrapped and large base64 image data", async () => {
		const sandbox = createSandbox();
		const large = `iVBORw0KGgoA${"QUJD".repeat(256 * 1024)}`;
		const result = await sandbox.execute(`
			image("data:image/png;base64,iVBORw0K\\r\\nGgo=\\n");
			image("data:image/png;base64,${large}");
		`);
		expect(result.ok).toBe(true);
		expect(result.output).toEqual([
			{ type: "image", data: PNG, mimeType: "image/png" },
			{ type: "image", data: large, mimeType: "image/png" },
		]);
	});

	it("ends the script successfully on exit(), keeping output and store writes", async () => {
		const sandbox = createSandbox([echo]);
		const result = await sandbox.execute(`
			text("before");
			store("k", 1);
			await tools.echo(1);
			try { exit(); } catch {}
			text("after");
			return "unreachable";
		`);
		expect(result).toMatchObject({
			ok: true,
			value: undefined,
			output: [{ type: "text", text: "before" }],
			storeWrites: { set: { k: 1 }, delete: [] },
		});
	});

	it("keeps output produced before a failure", async () => {
		const sandbox = createSandbox();
		const result = await sandbox.execute('text("partial");\nthrow new Error("boom")');
		expect(result).toMatchObject({ ok: false, output: [{ type: "text", text: "partial" }] });
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

	it("formats stacks like V8 without prelude frames", async () => {
		const sandbox = createSandbox();
		const result = await sandbox.execute("console.log(new Error('inner'));\nthrow new RangeError('outer')");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.stack).toMatch(/^RangeError: outer\n {4}at .*codemode\.js:2/);
		expect(result.error.stack).not.toContain("codemode-prelude.js");
		expect(result.output[0]).toMatchObject({
			type: "text",
			text: expect.stringMatching(/^Error: inner\n {4}at .*codemode\.js:1/),
		});
		expect(JSON.stringify(result.output)).not.toContain("codemode-prelude.js");
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

	it("exposes tools under normalized identifiers and lists them in ALL_TOOLS", async () => {
		const sandbox = createSandbox([
			{ name: "my-tool", description: "Dashes", execute: () => "dash" },
			{ name: "my_tool", description: "Shadowed", execute: () => "underscore" },
			{ name: "mcp__docs__search", execute: () => "mcp" },
		]);
		const result = await sandbox.execute(`
			try { ALL_TOOLS.push({}); } catch {}
			return {
				all: ALL_TOOLS,
				calls: [await tools.my_tool(), await tools["my-tool"](), await tools.mcp__docs__search()],
			};
		`);
		expect(result).toMatchObject({
			ok: true,
			value: {
				all: [
					{ name: "my_tool", description: "Dashes" },
					{ name: "mcp__docs__search", description: "" },
				],
				calls: ["dash", "dash", "mcp"],
			},
		});
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

	it("names close matches when a script reads a tool that does not exist", async () => {
		const sandbox = createSandbox([echo, { name: "web-search", execute: () => "" }]);
		const attempt = async (expression: string) => {
			const result = await sandbox.execute(`return ${expression};`);
			return result.ok ? result.value : result.error.message;
		};
		expect(await attempt("tools.Echo")).toBe(
			'tools.Echo does not exist. Did you mean tools.echo? ALL_TOOLS lists every tool; searchTools(query) finds tools by topic. Check for a member with "Echo" in tools.',
		);
		expect(await attempt("tools.websearch")).toContain("Did you mean tools.web_search?");
		expect(await attempt("tools.nothing")).toContain("Available: echo, web_search.");
		expect(
			await attempt("['echo' in tools, 'nothing' in tools, String(tools.toString), JSON.stringify(tools)]"),
		).toEqual([true, false, "undefined", "{}"]);
	});

	it("supports register and unregister between executions", async () => {
		const sandbox = createSandbox();
		sandbox.registerTool(echo);
		expect(() => sandbox.registerTool(echo)).toThrow(/already registered/);
		expect(sandbox.tools.map((tool) => tool.name)).toEqual(["echo"]);
		expect(await sandbox.execute("return await tools.echo('a')")).toMatchObject({ ok: true, value: "a" });
		expect(sandbox.unregisterTool("echo")).toBe(true);
		expect(await sandbox.execute("return 'echo' in tools")).toMatchObject({ ok: true, value: false });
	});
});

describe("store and load", () => {
	it("reads the snapshot and reports writes", async () => {
		const sandbox = createSandbox();
		const result = await sandbox.execute(
			`
			const seen = load("counter");
			store("counter", seen + 1);
			store("list", [1, { a: null }]);
			store("old", undefined);
			return [seen, load("counter"), load("missing"), load("old")];
		`,
			{ store: { counter: 41, old: "x" } },
		);
		expect(result).toMatchObject({
			ok: true,
			// undefined array elements become null in the JSON round trip of the return value.
			value: [41, 42, null, null],
			storeWrites: { set: { counter: 42, list: [1, { a: null }] }, delete: ["old"] },
		});
	});

	it("returns copies, so mutating a loaded value does not change the store", async () => {
		const sandbox = createSandbox();
		const result = await sandbox.execute(
			`const value = load("obj"); value.a = 2; const kept = { b: 1 }; store("kept", kept); kept.b = 2;
			return [load("obj").a, load("kept").b];`,
			{ store: { obj: { a: 1 } } },
		);
		expect(result).toMatchObject({ ok: true, value: [1, 1], storeWrites: { set: { kept: { b: 1 } } } });
	});

	it("rejects invalid keys, values, and oversized writes inside the script", async () => {
		const sandbox = createSandbox();
		const result = await sandbox.execute(`
			const attempt = (fn) => { try { fn(); return "ok"; } catch (error) { return error.name; } };
			return [
				attempt(() => store(1, "x")),
				attempt(() => load({})),
				attempt(() => store("fn", () => 1)),
				attempt(() => store("big", "x".repeat(300 * 1024))),
				attempt(() => { for (let i = 0; i < 8; i++) store("k" + i, "x".repeat(200 * 1024)); }),
			];
		`);
		expect(result).toMatchObject({
			ok: true,
			value: ["TypeError", "TypeError", "TypeError", "RangeError", "RangeError"],
		});
	});

	it("explains oversized writes", async () => {
		const sandbox = createSandbox();
		const result = await sandbox.execute(`store("img", "x".repeat(300 * 1024));`);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toContain('store("img") value has 307202 characters of JSON');
		expect(result.error.message).toContain("Show images with image()");
	});

	it("reserves the store and load names", () => {
		const execute = () => undefined;
		expect(() => new CodemodeSandbox({ globals: [{ name: "store", execute }] })).toThrow(/Invalid global/);
		expect(() => new CodemodeSandbox({ globals: [{ name: "load", execute }] })).toThrow(/Invalid global/);
	});
});

describe("globals", () => {
	it("exposes globals as top-level functions without recording them as calls", async () => {
		const seen: unknown[] = [];
		const sandbox = new CodemodeSandbox({
			tools: [echo],
			globals: [{ name: "attach", execute: (args) => void seen.push(args) }],
		});
		sandboxes.push(sandbox);
		const result = await sandbox.execute(`
			await attach({ ref: 1 });
			attach("not awaited");
			return [typeof attach, typeof globalThis.attach, await tools.echo(2)];
		`);
		expect(result).toMatchObject({ ok: true, value: ["function", "function", 2] });
		expect(result.calls.map((call) => call.name)).toEqual(["echo"]);
		// Messages are handled in order, so an unawaited global still runs before the script settles.
		expect(seen).toEqual([{ ref: 1 }, "not awaited"]);
	});

	it("groups namespaced globals and spreads arguments on request", async () => {
		const seen: unknown[] = [];
		const sandbox = new CodemodeSandbox({
			globals: [
				{ name: "models.list", spread: true, execute: (args) => void seen.push(args) },
				{ name: "models.first", execute: (args) => args },
			],
		});
		sandboxes.push(sandbox);
		const result = await sandbox.execute(`
			await models.list("classifier", undefined, 3);
			await models.list();
			try { models.extra = 1; } catch {}
			return [Object.keys(models), await models.first("a", "ignored"), "extra" in models];
		`);
		expect(result).toMatchObject({ ok: true, value: [["list", "first"], "a", false] });
		// undefined array elements become null in the JSON round trip.
		expect(seen).toEqual([["classifier", null, 3], []]);
	});

	it("names the members of a namespace when a script reads one that does not exist", async () => {
		const execute = () => undefined;
		const sandbox = new CodemodeSandbox({
			globals: [
				{ name: "models.classify", execute },
				{ name: "models.generateImages", execute },
			],
		});
		sandboxes.push(sandbox);
		const result = await sandbox.execute("await models.generateImage();");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toBe(
			'models.generateImage does not exist. Did you mean models.generateImages? Check for a member with "generateImage" in models.',
		);
	});

	it("rejects invalid and reserved global names", () => {
		const execute = () => undefined;
		for (const name of ["a.b.c", "a.", ".a", "tools.x", "store.x", "a.not-valid"]) {
			expect(() => new CodemodeSandbox({ globals: [{ name, execute }] }), name).toThrow(/Invalid global/);
		}
		expect(
			() =>
				new CodemodeSandbox({
					globals: [
						{ name: "models", execute },
						{ name: "models.list", execute },
					],
				}),
		).toThrow(/conflicts with the namespace/);
		expect(() => new CodemodeSandbox({ globals: [{ name: "not-valid", execute }] })).toThrow(/Invalid global/);
		expect(() => new CodemodeSandbox({ globals: [{ name: "tools", execute }] })).toThrow(/Invalid global/);
		expect(() => new CodemodeSandbox({ globals: [{ name: "console", execute }] })).toThrow(/Invalid global/);
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

	it("runs without a deadline when timeoutMs is Infinity", async () => {
		const sandbox = createSandbox([
			{ name: "wait", execute: () => new Promise((r) => setTimeout(() => r("late"), 50)) },
		]);
		const result = await sandbox.execute("return await tools.wait()", { timeoutMs: Number.POSITIVE_INFINITY });
		expect(result).toMatchObject({ ok: true, value: "late" });
	});

	it("fails a script that waits on a promise nothing can settle", async () => {
		const sandbox = createSandbox([{ name: "echo", execute: (args) => args }]);
		const result = await sandbox.execute("await tools.echo(1); await new Promise(() => {}); return 'never'", {
			timeoutMs: Number.POSITIVE_INFINITY,
		});
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "script", message: expect.stringContaining("can never settle") },
		});
		// Returning while a call is still pending is not a stall.
		const returned = await sandbox.execute("tools.echo(2); return 'early'", { timeoutMs: Number.POSITIVE_INFINITY });
		expect(returned).toMatchObject({ ok: true, value: "early" });
	});

	it("terminates a microtask-spinning loop on timeout", async () => {
		const sandbox = createSandbox();
		const result = await sandbox.execute("while (true) await null", { timeoutMs: 200 });
		expect(result).toMatchObject({ ok: false, error: { kind: "timeout" } });
	});

	it("aborts via signal and cancels in-flight calls", async () => {
		const controller = new AbortController();
		let toolSignal: AbortSignal | undefined;
		// Resolves on each call, so the test waits for the worker instead of a fixed delay.
		let called: () => void = () => {};
		const nextCall = () =>
			new Promise<void>((resolve) => {
				called = resolve;
			});
		const sandbox = createSandbox([
			{
				name: "hang",
				execute: (_args, { signal }) => {
					toolSignal = signal;
					called();
					return new Promise(() => {});
				},
			},
		]);
		const firstCall = nextCall();
		const promise = sandbox.execute("await tools.hang(); return 'never'");
		await firstCall;
		controller.abort(new Error("user cancelled"));
		expect(toolSignal?.aborted).toBe(false);
		const result = await sandbox.execute("await tools.hang()", { signal: controller.signal });
		expect(result).toMatchObject({ ok: false, error: { kind: "aborted", message: "user cancelled" } });

		const second = new AbortController();
		const secondCall = nextCall();
		const pending = sandbox.execute("await tools.hang(); return 'never'", { signal: second.signal });
		await secondCall;
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

	it("turns deep recursion into a catchable RangeError", async () => {
		const sandbox = createSandbox();
		const result = await sandbox.execute(`
			let depth = 0;
			function dive() { depth++; dive(); }
			try { dive(); } catch (error) { return [error.name, depth > 1000]; }
		`);
		expect(result).toMatchObject({ ok: true, value: ["RangeError", true] });
	});

	it("accepts a worker path string", async () => {
		const workerPath = fileURLToPath(new URL("../src/runtime/worker.ts", import.meta.url));
		const sandbox = new CodemodeSandbox({ workerUrl: workerPath });
		sandboxes.push(sandbox);
		expect(await sandbox.execute("return 1")).toMatchObject({ ok: true, value: 1 });
	});

	it("reports a missing worker file as a sandbox error", async () => {
		const sandbox = new CodemodeSandbox({ workerUrl: new URL("./does-not-exist.js", import.meta.url) });
		sandboxes.push(sandbox);
		expect(await sandbox.execute("return 1")).toMatchObject({ ok: false, error: { kind: "sandbox" } });
	});

	it("reports a failing wasm module as a sandbox error", async () => {
		const sandbox = new CodemodeSandbox({ wasm: Promise.reject(new Error("no wasm")) });
		sandboxes.push(sandbox);
		expect(await sandbox.execute("return 1")).toMatchObject({
			ok: false,
			error: { kind: "sandbox", message: "Failed to load QuickJS: no wasm" },
		});
	});
});

describe("escape hatches", () => {
	it("has no host globals", async () => {
		const sandbox = createSandbox();
		const result = await sandbox.execute(`
			return [
				typeof process, typeof require, typeof module, typeof setTimeout, typeof fetch,
				typeof WebAssembly, typeof std, typeof os, typeof globalThis.constructor,
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

	it("keeps eval and Function inside the VM", async () => {
		// Code generation is allowed: it can only produce more code in the same wasm instance.
		const sandbox = createSandbox([echo]);
		const result = await sandbox.execute(`
			return [
				eval("typeof process"),
				new Function("return typeof process")(),
				tools.echo.constructor("return typeof require")(),
				(async () => {}).constructor("return typeof setTimeout")() instanceof Promise,
			];
		`);
		expect(result).toMatchObject({ ok: true, value: ["undefined", "undefined", "undefined", true] });
	});

	it("rejects dynamic import", async () => {
		const sandbox = createSandbox();
		const result = await sandbox.execute(`
			try { await import("node:fs"); return "imported"; } catch (error) { return error.constructor.name; }
		`);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).not.toBe("imported");
	});

	it("keeps tools and console frozen", async () => {
		const sandbox = createSandbox([echo]);
		const result = await sandbox.execute(`
			try { tools.echo = () => 'nope'; } catch {}
			try { tools.extra = () => 'nope'; } catch {}
			try { globalThis.tools = null; } catch {}
			return ["extra" in tools, await tools.echo('still')];
		`);
		expect(result).toMatchObject({ ok: true, value: [false, "still"] });
	});
});

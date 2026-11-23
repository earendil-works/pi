import { describe, expect, it } from "vitest";
import { CodemodeSandbox, loadCodemodeWasm, RemoteCodemodeSandbox } from "../src/portable.ts";
import { inProcessRemote } from "./remote-support.ts";

const wasm = loadCodemodeWasm();

describe("CodemodeSandbox with a fuel budget", () => {
	it("fails a script that computes past its fuel as a timeout", async () => {
		const sandbox = new CodemodeSandbox({ wasm, fuel: 10_000_000 });
		for (const code of ["while (true) {}", "while (true) await null"]) {
			const result = await sandbox.execute(code, { timeoutMs: Number.POSITIVE_INFINITY });
			expect(result).toMatchObject({
				ok: false,
				error: {
					kind: "timeout",
					message: expect.stringContaining("The script used its CPU budget (about 0.02 s of computation)"),
				},
			});
		}
	});

	it("counts the fuel across waits on tools", async () => {
		const sandbox = new CodemodeSandbox({ wasm, fuel: 10_000_000, tools: [{ name: "tick", execute: () => 1 }] });
		const result = await sandbox.execute("for (;;) { for (let i = 0; i < 1e5; i++); await tools.tick(); }", {
			timeoutMs: 1000,
		});
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "timeout", message: expect.stringContaining("CPU budget") },
		});
		expect(result.calls.length).toBeGreaterThan(1);
	});
});

describe("RemoteCodemodeSandbox", () => {
	it("runs tools in the caller and the script on the remote", async () => {
		const { remote, served } = inProcessRemote();
		const seen: unknown[] = [];
		const sandbox = new RemoteCodemodeSandbox({
			remote: () => remote,
			tools: [
				{
					name: "add",
					execute: (args) => {
						seen.push(args);
						return (args as { a: number }).a + 1;
					},
				},
			],
		});
		const result = await sandbox.execute("text('hi'); return await tools.add({ a: 1 })", { store: { k: 1 } });
		expect(result).toMatchObject({ ok: true, value: 2, output: [{ type: "text", text: "hi" }] });
		expect(seen).toEqual([{ a: 1 }]);
		expect(result.calls).toMatchObject([{ name: "add", status: "ok" }]);
		await Promise.all(served);
	});

	it("batches output instead of making one exchange per line", async () => {
		const { remote, exchanges } = inProcessRemote();
		const sandbox = new RemoteCodemodeSandbox({ remote: () => remote, tools: [{ name: "tick", execute: () => 1 }] });
		const result = await sandbox.execute(
			"for (let i = 0; i < 5000; i++) console.log(i); await tools.tick(); text('after'); return 'ok'",
		);
		expect(result).toMatchObject({ ok: true, value: "ok" });
		expect(result.output).toHaveLength(5001);
		expect(result.output[4999]).toEqual({ type: "text", text: "4999", console: true });
		expect(result.output.at(-1)).toEqual({ type: "text", text: "after" });
		// Five batches of 1,000 lines on their own, the call, then the last line with the result.
		expect(exchanges).toEqual([1, 1, 1, 1, 1, 1, 2]);
	});

	it("caps the fuel and memory at the remote's limits", async () => {
		const { remote } = inProcessRemote({ maxFuel: 10_000_000, maxMemoryLimitBytes: 8 * 1024 * 1024 });
		const sandbox = new RemoteCodemodeSandbox({ remote: () => remote, fuel: 1e12 });
		expect(await sandbox.execute("while (true) {}")).toMatchObject({
			ok: false,
			error: {
				kind: "timeout",
				message: expect.stringContaining("The script used its CPU budget (about 0.02 s of computation)"),
			},
		});
		const memory = await sandbox.execute(
			"const parts = []; for (;;) parts.push('x'.repeat(1 << 20) + parts.length);",
		);
		expect(memory).toMatchObject({ ok: false });
		expect(JSON.stringify(memory)).toContain("out of memory");
	});

	it("tells the remote to stop when the caller aborts", async () => {
		const { remote, served } = inProcessRemote();
		let started: () => void = () => {};
		const call = new Promise<void>((resolve) => {
			started = resolve;
		});
		const sandbox = new RemoteCodemodeSandbox({
			remote: () => remote,
			tools: [
				{
					name: "hang",
					execute: () => {
						started();
						return new Promise(() => {});
					},
				},
			],
		});
		const controller = new AbortController();
		const pending = sandbox.execute("await tools.hang(); return 'never'", { signal: controller.signal });
		await call;
		controller.abort();
		expect(await pending).toMatchObject({ ok: false, error: { kind: "aborted" } });
		// The remote's pending exchange is answered with "stop", so its VM is disposed and execute() returns.
		await Promise.all(served);
	});

	it("reports a failing or vanishing remote as a sandbox error", async () => {
		const reset = () => Promise.reject(new Error("object reset"));
		const failing = new RemoteCodemodeSandbox({ remote: () => ({ execute: reset, step: reset }) });
		expect(await failing.execute("return 1")).toMatchObject({
			ok: false,
			error: { kind: "sandbox", message: "Remote sandbox failed: object reset" },
		});
		// A run the client drives ends the same way when its step fails.
		const run = await failing.begin("return 1", { tools: [], globals: [], store: {} });
		await run.advance();
		expect(run.result).toMatchObject({
			ok: false,
			error: { kind: "sandbox", message: "Remote sandbox failed: object reset" },
		});

		const silent = new RemoteCodemodeSandbox({
			remote: () => ({ execute: () => Promise.resolve(), step: () => Promise.reject(new Error("unused")) }),
		});
		expect(await silent.execute("return 1")).toMatchObject({
			ok: false,
			error: { kind: "sandbox", message: "Remote sandbox returned before the script settled" },
		});

		const unreachable = new RemoteCodemodeSandbox({
			remote: () => {
				throw new Error("no binding");
			},
		});
		expect(await unreachable.execute("return 1")).toMatchObject({
			ok: false,
			error: { kind: "sandbox", message: "Remote sandbox failed: no binding" },
		});
	});
});

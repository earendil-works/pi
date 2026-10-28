import { describe, expect, it } from "vitest";
import {
	type CodemodeRemote,
	type CodemodeRemoteExchange,
	type CodemodeRemoteRequest,
	type CodemodeServeOptions,
	InlineCodemodeSandbox,
	loadQuickJSWasm,
	RemoteCodemodeSandbox,
	serveCodemodeRemote,
} from "../src/index.ts";

const wasm = loadQuickJSWasm();

/** An in-process remote that records what crosses the boundary, cloned as Workers RPC would. */
function recordingRemote(options: Partial<CodemodeServeOptions> = {}) {
	const exchanges: number[] = [];
	const served: Promise<void>[] = [];
	const remote: CodemodeRemote = {
		execute(request: CodemodeRemoteRequest, exchange: CodemodeRemoteExchange) {
			const done = serveCodemodeRemote(
				structuredClone(request),
				async (messages) => {
					exchanges.push(messages.length);
					return structuredClone(await exchange(structuredClone(messages)));
				},
				{ wasm, ...options },
			);
			served.push(done);
			return done;
		},
	};
	return { remote, exchanges, served };
}

describe("InlineCodemodeSandbox", () => {
	it("fails a script that computes past its interrupt budget as a timeout", async () => {
		const sandbox = new InlineCodemodeSandbox({ wasm, interruptBudget: 1_000 });
		for (const code of ["while (true) {}", "while (true) await null"]) {
			const result = await sandbox.execute(code, { timeoutMs: Number.POSITIVE_INFINITY });
			expect(result).toMatchObject({
				ok: false,
				error: { kind: "timeout", message: "Execution exceeded its interrupt budget of 1000" },
			});
		}
	});

	it("counts the budget across waits on tools", async () => {
		const sandbox = new InlineCodemodeSandbox({
			wasm,
			interruptBudget: 1_000,
			tools: [{ name: "tick", execute: () => 1 }],
		});
		const result = await sandbox.execute("for (;;) { for (let i = 0; i < 1e5; i++); await tools.tick(); }");
		expect(result).toMatchObject({ ok: false, error: { kind: "timeout" } });
		expect(result.calls.length).toBeGreaterThan(1);
	});
});

describe("RemoteCodemodeSandbox", () => {
	it("runs tools in the caller and the script on the remote", async () => {
		const { remote, served } = recordingRemote();
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
		const { remote, exchanges } = recordingRemote();
		const sandbox = new RemoteCodemodeSandbox({ remote: () => remote });
		const result = await sandbox.execute("for (let i = 0; i < 5000; i++) console.log(i); return 'ok'");
		expect(result).toMatchObject({ ok: true, value: "ok" });
		expect(result.output).toHaveLength(5000);
		expect(result.output[4999]).toEqual({ type: "text", text: "4999", console: true });
		expect(exchanges.length).toBeLessThanOrEqual(6);
	});

	it("caps the interrupt budget and memory at the remote's limits", async () => {
		const { remote } = recordingRemote({ maxInterruptBudget: 1_000, maxMemoryLimitBytes: 8 * 1024 * 1024 });
		const sandbox = new RemoteCodemodeSandbox({ remote: () => remote, interruptBudget: 1e9 });
		expect(await sandbox.execute("while (true) {}")).toMatchObject({
			ok: false,
			error: { kind: "timeout", message: "Execution exceeded its interrupt budget of 1000" },
		});
		const memory = await sandbox.execute(
			"const parts = []; for (;;) parts.push('x'.repeat(1 << 20) + parts.length);",
		);
		expect(memory).toMatchObject({ ok: false });
		expect(JSON.stringify(memory)).toContain("out of memory");
	});

	it("tells the remote to stop when the caller aborts", async () => {
		const { remote, served } = recordingRemote();
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
		const failing = new RemoteCodemodeSandbox({
			remote: () => ({ execute: () => Promise.reject(new Error("object reset")) }),
		});
		expect(await failing.execute("return 1")).toMatchObject({
			ok: false,
			error: { kind: "sandbox", message: "Remote sandbox failed: object reset" },
		});

		const silent = new RemoteCodemodeSandbox({ remote: () => ({ execute: () => Promise.resolve() }) });
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
			error: { kind: "sandbox", message: "Failed to reach the remote sandbox: no binding" },
		});
	});
});

import { afterEach, describe, expect, it } from "vitest";
import {
	type CodemodeHostCall,
	type CodemodeOutcome,
	type CodemodeRemoteExchange,
	type CodemodeRun,
	type CodemodeRunOptions,
	CodemodeSandbox,
	type CodemodeSandboxBase,
	type CodemodeSandboxBaseOptions,
	loadQuickJSWasm,
	RemoteCodemodeSandbox,
	serveCodemodeRemote,
} from "../src/index.ts";

/**
 * `start()` runs a script deterministically with the caller answering its calls, so a durable host can replay it
 * after a restart. Every test runs on the worker sandbox (Node) and the remote sandbox (Cloudflare), whose transport
 * clones every message as Workers RPC would.
 */
const BUDGET = 50_000;
/** `delayFirst` holds the reply to the first result back, so later results reach the VM before it. */
function remote(options: CodemodeSandboxBaseOptions, delayFirst = false): RemoteCodemodeSandbox {
	return new RemoteCodemodeSandbox({
		...options,
		remote: () => ({
			execute: (request, exchange) => {
				const wrapped: CodemodeRemoteExchange = async (messages) => {
					const reply = structuredClone(await exchange(structuredClone(messages)));
					if (delayFirst && reply?.type === "result" && reply.seq === 1) {
						await new Promise((resolve) => setTimeout(resolve, 30));
					}
					return reply;
				};
				return serveCodemodeRemote(structuredClone(request), wrapped, {
					wasm: loadQuickJSWasm(),
					maxInterruptBudget: BUDGET,
				});
			},
		}),
	});
}
const BACKENDS: Record<string, (options?: CodemodeSandboxBaseOptions) => CodemodeSandboxBase> = {
	worker: (options = {}) => new CodemodeSandbox(options),
	remote: (options = {}) => remote(options),
};

const STARTED_AT = Date.UTC(2026, 0, 15, 10, 0, 0);

type Recorded = {
	run: CodemodeRun;
	calls: CodemodeHostCall[];
	idles: [seq: number, issued: number][];
	events: string[];
	fingerprint: () => string | undefined;
};

/**
 * Start `code` with tools `echo` and `wait`. Every call but `wait` is answered at once, by default with its argument,
 * as result number 1, 2, ... with the clock at `STARTED_AT + 1000 * seq`; `wait` is left for the test to answer.
 */
function start(
	sandbox: CodemodeSandboxBase,
	code: string,
	options: Partial<CodemodeRunOptions> & { answer?: (call: CodemodeHostCall) => CodemodeOutcome } = {},
): Recorded {
	const calls: CodemodeHostCall[] = [];
	const idles: [number, number][] = [];
	const events: string[] = [];
	let fingerprint: string | undefined;
	let seq = 0;
	const answer = options.answer ?? ((call: CodemodeHostCall) => ({ ok: true, value: call.args }));
	const run: CodemodeRun = sandbox.start(code, {
		startedAt: STARTED_AT,
		seed: 1,
		tools: [{ name: "echo" }, { name: "wait" }],
		timeoutMs: 20_000,
		...options,
		onStarted: (value) => {
			fingerprint = value;
			events.push("started");
		},
		onCall: (call) => {
			calls.push(call);
			events.push(`call ${call.id}`);
			if (call.name === "wait") return;
			queueMicrotask(() => {
				seq++;
				run.deliver(seq, STARTED_AT + 1000 * seq, call.id, answer(call));
			});
		},
		onIdle: (seq, issued) => {
			idles.push([seq, issued]);
			events.push(`idle ${seq}`);
		},
	});
	return { run, calls, idles, events, fingerprint: () => fingerprint };
}

const savedTimezone = process.env.TZ;
afterEach(() => {
	if (savedTimezone === undefined) delete process.env.TZ;
	else process.env.TZ = savedTimezone;
});

for (const [backend, create] of Object.entries(BACKENDS)) {
	describe(`deterministic runs (${backend})`, () => {
		it("makes the same calls and output for the same start, seed, and results", async () => {
			const code = `
				const values = [Date.now(), performance.now(), Math.random(), Math.random(), new Date().toISOString()];
				const first = await tools.echo(values);
				text(JSON.stringify([Date.now(), performance.now(), Math.random()]));
				return await tools.echo(first.concat(Math.random()));
			`;
			const sandbox = create();
			const one = start(sandbox, code);
			const two = start(sandbox, code);
			const [a, b] = await Promise.all([one.run.result, two.run.result]);
			// Call durations are wall-clock time; everything else is the same.
			const timeless = (result: typeof a) => ({
				...result,
				calls: result.calls.map(({ name, status }) => ({ name, status })),
			});
			expect(timeless(a)).toEqual(timeless(b));
			expect(one.calls).toEqual(two.calls);
			// The clock: startedAt, then the time of the result being processed; performance.now() counts from startedAt.
			const [now, elapsed, random] = one.calls[0]!.args as number[];
			expect([now, elapsed]).toEqual([STARTED_AT, 0]);
			expect((one.calls[0]!.args as unknown[])[4]).toBe("2026-01-15T10:00:00.000Z");
			const printed = JSON.parse(a.ok ? (a.output[0] as { text: string }).text : "[]") as number[];
			expect(printed.slice(0, 2)).toEqual([STARTED_AT + 1000, 1000]);
			// Pinned: a change here changes what replayed scripts see, so it must change the fingerprint too.
			expect(random).toBe(PINNED_FIRST_RANDOM);

			// The seed decides the random values, not the start time.
			const later = start(sandbox, code, { startedAt: STARTED_AT + 5000 });
			const reseeded = start(sandbox, code, { seed: 2 });
			await Promise.all([later.run.result, reseeded.run.result]);
			expect((later.calls[0]!.args as number[])[2]).toBe(random);
			expect((reseeded.calls[0]!.args as number[])[2]).not.toBe(random);
			// Seed 0 has its own values: QuickJS turns a zero state into 1, which must not make it seed 1's.
			const zero = start(sandbox, "return [Math.random(), Math.random()]", { seed: 0 });
			const zeroResult = await zero.run.result;
			expect(zeroResult).toMatchObject({ ok: true, value: PINNED_SEED_ZERO });
			expect((zeroResult.ok ? zeroResult.value : []) as number[]).not.toContain(random);
		});

		it("runs in UTC whatever the host's timezone, and without WeakRef or FinalizationRegistry", async () => {
			process.env.TZ = "Asia/Kolkata";
			const code =
				"return [new Date(0).getHours(), new Date(0).getTimezoneOffset(), typeof WeakRef, typeof FinalizationRegistry]";
			const sandbox = create();
			const { run } = start(sandbox, code);
			expect(await run.result).toMatchObject({ ok: true, value: [0, 0, "undefined", "undefined"] });
			// execute() is unchanged: the host's timezone and every intrinsic.
			expect(await sandbox.execute(code)).toMatchObject({ ok: true, value: [5, -330, "function", "function"] });
		});

		it("applies results in seq order, whatever order they are delivered in", async () => {
			const sandbox = create();
			const recorded = start(
				sandbox,
				`const order = [];
				await Promise.all([tools.wait("a").then(() => order.push("a")), tools.wait("b").then(() => order.push("b"))]);
				return order;`,
			);
			await waitFor(() => recorded.calls.length === 2 && recorded.idles.length === 1);
			const [a, b] = recorded.calls;
			// b is result 1 and a result 2, but a arrives first.
			recorded.run.deliver(2, STARTED_AT + 2000, a!.id, { ok: true, value: null });
			recorded.run.deliver(1, STARTED_AT + 1000, b!.id, { ok: true, value: null });
			expect(await recorded.run.result).toMatchObject({ ok: true, value: ["b", "a"] });
			// No idle after the last result: the script finished in that drain, and the host stopped the VM.
			expect(recorded.idles).toEqual([
				[0, 2],
				[1, 2],
			]);
		});

		it("reports the fingerprint before any call and the calls issued after each result", async () => {
			const sandbox = create({ memoryLimitBytes: 64 * 1024 * 1024 });
			const recorded = start(sandbox, "await tools.echo(1); await Promise.all([tools.echo(2), tools.echo(3)]);");
			expect(await recorded.run.result).toMatchObject({ ok: true });
			expect(recorded.events.slice(0, 3)).toEqual(["started", "call 1", "idle 0"]);
			expect(recorded.idles).toEqual([
				[0, 1],
				[1, 3],
				[2, 3],
			]);
			expect(recorded.calls.map((call) => [call.id, call.target, call.name, call.args])).toEqual([
				[1, "tool", "echo", 1],
				[2, "tool", "echo", 2],
				[3, "tool", "echo", 3],
			]);
			const fingerprint = recorded.fingerprint()!;
			expect(fingerprint).toMatch(
				/^quickjs-wasi \S+, quickjs \S+, prelude [0-9a-f]{8}, deterministic \d+, stack \d+, heap 67108864, budget \S+$/,
			);
			if (backend === "remote") expect(fingerprint).toContain(`budget ${BUDGET}`);
			else expect(fingerprint).toContain("budget none");

			const same = start(sandbox, "return 1");
			const other = start(create({ memoryLimitBytes: 32 * 1024 * 1024 }), "return 1");
			await Promise.all([same.run.result, other.run.result]);
			expect(same.fingerprint()).toBe(fingerprint);
			expect(other.fingerprint()).not.toBe(fingerprint);
		});

		it("numbers calls to globals with tools, and answers errors as rejections", async () => {
			const sandbox = create();
			const recorded = start(
				sandbox,
				`const found = await search("x", 2);
				try { await tools.echo("fail"); } catch (error) { text(error.message); }
				return found;`,
				{
					globals: [{ name: "search", spread: true }],
					answer: (call) =>
						call.args === "fail"
							? { ok: false, message: "no" }
							: { ok: true, value: call.name === "search" ? ["found"] : call.args },
				},
			);
			const result = await recorded.run.result;
			expect(recorded.calls[0]).toEqual({ id: 1, target: "global", name: "search", args: ["x", 2] });
			expect(result).toMatchObject({ ok: true, value: ["found"], output: [{ type: "text", text: "no" }] });
			expect(recorded.calls[1]).toMatchObject({ id: 2, target: "tool", name: "echo" });
			// Calls to globals count as issued calls too.
			expect(recorded.idles.slice(0, 2)).toEqual([
				[0, 1],
				[1, 2],
			]);
			expect(result.calls).toMatchObject([{ name: "echo", status: "error" }]);
		});

		it("keeps the clock monotonic and rejects a clock value that is not finite", async () => {
			const sandbox = create();
			const recorded = start(
				sandbox,
				"const before = Date.now(); await tools.wait(1); return [before, Date.now(), performance.now()]",
			);
			await waitFor(() => recorded.calls.length === 1);
			expect(() => recorded.run.deliver(1, Number.NaN, 1, { ok: true, value: null })).toThrow("not a finite number");
			// A resumed host whose clock is behind the run's start.
			recorded.run.deliver(1, STARTED_AT - 2000, 1, { ok: true, value: null });
			expect(await recorded.run.result).toMatchObject({ ok: true, value: [STARTED_AT, STARTED_AT, 0] });
		});

		it("reports the result the VM was processing when the script ended", async () => {
			const sandbox = create();
			const returned = start(sandbox, "await tools.echo(1); return await tools.echo(2)");
			const thrown = start(
				sandbox,
				"await tools.echo(1); await Promise.all([tools.echo(2), tools.echo(3)]); throw new Error('x')",
			);
			const first = start(sandbox, "return 1");
			expect(await returned.run.result).toMatchObject({ ok: true, value: 2, during: { seq: 2, issued: 2 } });
			expect(await thrown.run.result).toMatchObject({ ok: false, during: { seq: 3, issued: 3 } });
			expect(await first.run.result).toMatchObject({ ok: true, during: { seq: 0, issued: 0 } });
			expect(await sandbox.execute("return 1")).not.toHaveProperty("during");
		});

		it("leaves a call waiting when its answer cannot be serialized", async () => {
			const sandbox = create();
			const recorded = start(sandbox, "return await tools.wait(1)");
			await waitFor(() => recorded.calls.length === 1);
			expect(() => recorded.run.deliver(1, STARTED_AT, 1, { ok: true, value: 1n })).toThrow();
			expect(() =>
				recorded.run.deliver(1, STARTED_AT, 1, { ok: false, message: "x", properties: { big: 1n } }),
			).toThrow();
			recorded.run.deliver(1, STARTED_AT, 1, { ok: true, value: "fine" });
			expect(await recorded.run.result).toMatchObject({ ok: true, value: "fine" });
		});

		it("rejects with an Error carrying the answer's properties", async () => {
			const sandbox = create();
			const recorded = start(
				sandbox,
				"try { await tools.echo(1); } catch (e) { return [e instanceof Error, e.message, e.name, e.structuredOutput]; }",
				{
					answer: () => ({
						ok: false,
						message: "denied",
						properties: { structuredOutput: { code: 7 }, name: "Ignored", message: "ignored" },
					}),
				},
			);
			expect(await recorded.run.result).toMatchObject({ ok: true, value: [true, "denied", "Error", { code: 7 }] });
		});

		it("rejects rejection properties that are not an object, and tools sharing a script name", async () => {
			const sandbox = create();
			const recorded = start(sandbox, "return await tools.wait(1)");
			await waitFor(() => recorded.calls.length === 1);
			for (const properties of [null, [1]] as unknown as Record<string, unknown>[]) {
				expect(() => recorded.run.deliver(1, STARTED_AT, 1, { ok: false, message: "x", properties })).toThrow(
					"not an object",
				);
			}
			recorded.run.deliver(1, STARTED_AT, 1, { ok: true, value: 1 });
			expect(await recorded.run.result).toMatchObject({ ok: true, value: 1 });
			expect(() =>
				sandbox.start("", {
					startedAt: STARTED_AT,
					seed: 1,
					tools: [{ name: "a-b" }, { name: "a_b" }],
					onCall: () => {},
				}),
			).toThrow("script names must be unique");
		});

		it("uses the script names the run passes", async () => {
			const sandbox = create();
			const recorded = start(
				sandbox,
				"return [typeof tools.renamed, Object.keys(tools), ALL_TOOLS.map((tool) => tool.name)]",
				{
					tools: [{ name: "my-tool", jsName: "renamed" }],
				},
			);
			expect(await recorded.run.result).toMatchObject({
				ok: true,
				value: ["function", ["renamed", "my-tool"], ["renamed"]],
			});
		});

		it("ends with an error the script cannot catch when the caller aborts", async () => {
			const sandbox = create();
			const controller = new AbortController();
			const recorded = start(
				sandbox,
				`try { await tools.wait(1); } catch { text("caught"); }
				text("after");`,
				{ signal: controller.signal },
			);
			await waitFor(() => recorded.calls.length === 1);
			controller.abort(new Error("diverged"));
			const result = await recorded.run.result;
			expect(result).toMatchObject({ ok: false, error: { kind: "aborted", message: "diverged" }, output: [] });
			expect(() => recorded.run.deliver(1, STARTED_AT, 1, { ok: true, value: null })).not.toThrow();
		});

		it("is finished once it has its outcome", async () => {
			const sandbox = create();
			const recorded = start(sandbox, "await tools.wait(1); return 2");
			await waitFor(() => recorded.calls.length === 1);
			expect(recorded.run.finished).toBe(false);
			recorded.run.deliver(1, STARTED_AT, 1, { ok: true, value: null });
			await recorded.run.result;
			expect(recorded.run.finished).toBe(true);
		});

		it("rejects a call that is not waiting and a result number used twice", async () => {
			const sandbox = create();
			const recorded = start(sandbox, "await Promise.all([tools.wait(1), tools.wait(2)])");
			await waitFor(() => recorded.calls.length === 2);
			const { run } = recorded;
			expect(() => run.deliver(1, STARTED_AT, 99, { ok: true, value: null })).toThrow("Call 99 is not waiting");
			run.deliver(1, STARTED_AT, 1, { ok: true, value: null });
			expect(() => run.deliver(1, STARTED_AT, 2, { ok: true, value: null })).toThrow("used once");
			expect(() => run.deliver(0, STARTED_AT, 2, { ok: true, value: null })).toThrow("used once");
			run.deliver(2, STARTED_AT, 2, { ok: true, value: null });
			expect(await run.result).toMatchObject({ ok: true });
		});
	});
}

describe("deterministic runs (remote transport)", () => {
	it("applies results in seq order when the transport reorders replies sent in order", async () => {
		const sandbox = remote({}, true);
		const recorded = start(
			sandbox,
			`const order = [];
			await Promise.all([tools.wait("a").then(() => order.push("a")), tools.wait("b").then(() => order.push("b"))]);
			return order;`,
		);
		await waitFor(() => recorded.calls.length === 2);
		const [a, b] = recorded.calls;
		recorded.run.deliver(1, STARTED_AT + 1000, a!.id, { ok: true, value: null });
		recorded.run.deliver(2, STARTED_AT + 2000, b!.id, { ok: true, value: null });
		expect(await recorded.run.result).toMatchObject({ ok: true, value: ["a", "b"] });
	});
});

describe("execute() is not deterministic", () => {
	it("reads the real clock and real randomness", async () => {
		const sandbox = new CodemodeSandbox();
		const before = Date.now();
		const first = await sandbox.execute("return [Date.now(), Math.random()]");
		const second = await sandbox.execute("return [Date.now(), Math.random()]");
		const [now, random] = (first.ok ? first.value : []) as number[];
		expect(now).toBeGreaterThanOrEqual(before);
		expect(now).toBeLessThanOrEqual(Date.now());
		expect((second.ok ? second.value : []) as number[]).not.toContain(random);
	});
});

async function waitFor(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("Condition was not reached");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** The first two `Math.random()` values with seed 0. */
const PINNED_SEED_ZERO = [0.6711372530266764, 0.7258461452833667];

/** The first `Math.random()` with seed 1. */
const PINNED_FIRST_RANDOM = 0.34227450605335275;

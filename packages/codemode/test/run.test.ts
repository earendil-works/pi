import { beforeEach, describe, expect, it } from "vitest";
import {
	CodemodeSandbox,
	type CodemodeSandboxBase,
	type CodemodeScope,
	DEFAULT_FUEL,
	FUEL_PER_SECOND,
	loadCodemodeWasm,
	RemoteCodemodeSandbox,
} from "../src/index.ts";
import { inProcessRemote } from "./remote-support.ts";

const wasm = await loadCodemodeWasm();
const scope: CodemodeScope = { tools: [{ name: "ask", jsName: "ask", description: "" }], globals: [], store: {} };

/** Runs the host drives, on the calling thread or step by step on an in-process remote. */
const BACKENDS: Record<string, (options: { fuel?: number }) => CodemodeSandboxBase> = {
	local: (options) => new CodemodeSandbox({ wasm, ...options }),
	remote: (options) => {
		const { remote } = inProcessRemote({ maxFuel: 1e12 });
		return new RemoteCodemodeSandbox({ ...options, remote: () => remote });
	},
};
let backend = "local";
const sandboxOf = (options: { fuel?: number } = {}) => BACKENDS[backend]!(options);

describe.each(Object.keys(BACKENDS))("%s backend", (name) => {
	beforeEach(() => {
		backend = name;
	});

	describe("runs the host drives", () => {
		it("passes values as JSON, ends the script at exit(), and bounds a runaway step", async () => {
			const sandbox = sandboxOf({ fuel: 100_000_000 });
			const vm = await sandbox.begin(
				`const r = await tools.ask({ when: new Date(0), m: new Map([[1, 2]]) });
				try { exit(); } catch { store("caught", true); }
				text("unreachable");`,
				scope,
			);
			await vm.advance();
			expect(vm.calls.map((call) => call.args)).toEqual([{ when: "1970-01-01T00:00:00.000Z", m: {} }]);
			vm.settle(vm.calls[0]!.id, { ok: true, value: "x" });
			await vm.advance();
			expect(vm.result).toMatchObject({
				ok: true,
				value: undefined,
				output: [],
				storeWrites: { set: {}, delete: [] },
			});
			vm.dispose();

			const spin = await sandbox.begin("while (true) {}", scope);
			let ticks = 0;
			const timer = setInterval(() => ticks++, 1);
			await spin.advance();
			clearInterval(timer);
			expect(spin.result).toMatchObject({ ok: false, error: { kind: "timeout" } });
			// The event loop ran while the script computed.
			expect(ticks).toBeGreaterThan(0);
			spin.dispose();
		});

		it("lists the calls a script no longer awaits when it ends", async () => {
			const vm = await sandboxOf().begin("tools.ask({}); return 'early';", scope);
			await vm.advance();
			expect(vm.result).toMatchObject({ ok: true, value: "early" });
			expect(vm.dropped).toMatchObject([{ identity: "tools.ask", kind: "tool", name: "ask", args: {} }]);
			vm.dispose();
		});

		it("continues a saved run in a new VM, with its output, store writes, and fuel", async () => {
			const sandbox = sandboxOf({ fuel: 1_000_000_000 });
			const vm = await sandbox.begin(
				`text("before"); store("k", 1); for (let i = 0; i < 1e5; i++); return await tools.ask({});`,
				scope,
			);
			await vm.advance();
			const saved = vm.save();
			vm.dispose();
			expect(saved).toMatchObject({
				output: [{ type: "text", text: "before" }],
				writes: { set: { k: 1 }, delete: [] },
			});
			expect(saved.fuelUsed).toBeGreaterThan(0);
			const resumed = await sandboxOf({ fuel: saved.fuelUsed }).resume(scope, saved);
			resumed.settle(resumed.calls[0]!.id, { ok: true, value: "answer" });
			await resumed.advance();
			// The fuel used before the save counts: the resumed run has none left.
			expect(resumed.result).toMatchObject({ ok: false, error: { kind: "timeout" } });
			resumed.dispose();
		});

		it("begins the script again from its results when its snapshot does not load", async () => {
			const sandbox = sandboxOf();
			const code = `text("start " + Math.random().toFixed(6));
				const a = await tools.ask({ n: 1 });
				store("a", a);
				const b = await tools.ask({ n: 2, a, at: Date.now() }).catch((e) => "failed " + e.message + " " + e.code);
				text("got " + b);
				return [a, b, await tools.ask({ n: 3 })];`;
			const vm = await sandbox.begin(code, scope);
			await vm.advance();
			vm.settle(vm.calls[0]!.id, { ok: true, value: "A" });
			await vm.advance();
			// One save, a resume, a second save: the results applied before and after the load all count.
			const first = vm.save();
			vm.dispose();
			const middle = await sandbox.resume(scope, first);
			middle.settle(middle.calls[0]!.id, { ok: false, message: "B", properties: { code: 7 } });
			await middle.advance();
			const saved = middle.save();
			const open = middle.calls;
			middle.dispose();
			expect(
				JSON.parse(JSON.stringify(saved.rerun.deliveries)).map((delivery: { ok: boolean }) => delivery.ok),
			).toEqual([true, false]);

			// A newer djs refuses the snapshot: the script runs again from its results, to where it was.
			const refused = { ...saved, snapshot: btoa("not a snapshot") };
			const rerun = await sandbox.resume(scope, refused);
			expect(rerun.calls).toEqual(open);
			expect(rerun.output).toEqual(saved.output);
			rerun.settle(rerun.calls[0]!.id, { ok: true, value: "C" });
			await rerun.advance();
			expect(rerun.result).toMatchObject({
				ok: true,
				value: ["A", "failed B 7", "C"],
				storeWrites: { set: { a: "A" } },
			});
			rerun.dispose();

			// A script that takes another path when run again ends with an error instead of making other calls.
			const other = { ...refused, rerun: { ...refused.rerun, code: code.replace("n: 2", "n: 22") } };
			const diverged = await sandbox.resume(scope, other);
			expect(diverged.result).toMatchObject({ ok: false, error: { kind: "sandbox" } });
			expect(JSON.stringify(diverged.result)).toContain("running the script again from its results failed");
			diverged.dispose();
		});
	});

	describe("imports from virtual modules", () => {
		const modules: CodemodeScope = {
			tools: [],
			globals: [],
			store: {},
			modules: [{ specifier: "@mcp/github", exports: [{ name: "search_issues", tool: "search-issues" }] }],
		};

		it("binds named and namespace imports by identity, across a save and a resume", async () => {
			const sandbox = sandboxOf();
			const vm = await sandbox.begin(
				`import { search_issues as search } from "@mcp/github";
				import * as gh from "@mcp/github";
				const a = await search({ q: "a" });
				return [a, await gh.search_issues({ q: "b" }), gh.search_issues === search];`,
				modules,
			);
			await vm.advance();
			expect(vm.calls).toMatchObject([
				{ identity: "@mcp/github#search-issues", kind: "tool", name: "search-issues", args: { q: "a" } },
			]);
			vm.settle(vm.calls[0]!.id, { ok: true, value: "A" });
			await vm.advance();
			const saved = vm.save();
			vm.dispose();
			const resumed = await sandbox.resume(modules, saved);
			expect(resumed.calls).toMatchObject([{ identity: "@mcp/github#search-issues", args: { q: "b" } }]);
			resumed.settle(resumed.calls[0]!.id, { ok: true, value: "B" });
			await resumed.advance();
			expect(resumed.result).toMatchObject({ ok: true, value: ["A", "B", true] });
			resumed.dispose();
		});

		it("reports an unknown module as a syntax error", async () => {
			const vm = await sandboxOf().begin(`import { x } from "@mcp/nope"; return x;`, modules);
			await vm.advance();
			expect(vm.result).toMatchObject({ ok: false, error: { kind: "script", name: "SyntaxError" } });
			expect(JSON.stringify(vm.result)).toContain("@mcp/nope");
			vm.dispose();
		});
	});

	describe("the CPU budget", () => {
		/** The fuel `work` uses before the script waits on its next call. */
		async function fuelOf(work: string): Promise<number> {
			const run = await sandboxOf().begin(`${work}\nawait tools.ask({});`, scope);
			await run.advance();
			// The work may call tools itself: answer them until the script waits on the last one.
			for (let i = 0; i < 2000 && run.calls.length > 0; i++) {
				const fuel = run.save().fuelUsed;
				const [call] = run.calls;
				run.settle(call!.id, { ok: true, value: { a: 1, b: "x".repeat(100) } });
				await run.advance();
				if (run.result !== undefined) {
					run.dispose();
					return fuel;
				}
			}
			const fuel = run.save().fuelUsed;
			run.dispose();
			return fuel;
		}

		it("lets heavy scripts use a small part of the default budget", async () => {
			const sort = await fuelOf(
				"const a = Array.from({ length: 1e6 }, (_, i) => (i * 7919) % 1000003); a.sort((x, y) => x - y);",
			);
			const json = await fuelOf(
				"const t = JSON.stringify(Array.from({ length: 1e5 }, (_, i) => ({ i, s: 'item ' + i, t: [i, i + 1] }))); JSON.parse(t);",
			);
			const calls = await fuelOf("for (let i = 0; i < 1000; i++) await tools.ask({ i });");
			for (const used of [sort, json, calls]) expect(used).toBeLessThan(DEFAULT_FUEL / 100);
		});

		it("does not count waiting on calls", async () => {
			const run = await sandboxOf().begin("await tools.ask({}); await tools.ask({});", scope);
			await run.advance();
			const before = run.save().fuelUsed;
			await new Promise((resolve) => setTimeout(resolve, 200));
			run.settle(run.calls[0]!.id, { ok: true, value: 1 });
			await run.advance();
			expect(run.save().fuelUsed - before).toBeLessThan(100_000);
			run.dispose();
		});

		it("ends a runaway script with the budget in its message", async () => {
			const run = await sandboxOf({ fuel: FUEL_PER_SECOND / 10 }).begin("for (;;) {}", scope);
			await run.advance();
			expect(run.result).toMatchObject({
				ok: false,
				error: {
					kind: "timeout",
					message: expect.stringMatching(/^The script used its CPU budget \(about 0\.1 s of computation\)/),
				},
			});
			run.dispose();
		});
	});
});

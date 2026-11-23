import { describe, expect, it } from "vitest";
import { type CodemodeScope, DjsCodemode } from "../src/djs.ts";
import { loadDjsWasm } from "../src/wasm.ts";

const module = await loadDjsWasm();
const scope: CodemodeScope = { tools: [{ name: "ask", jsName: "ask", description: "" }], globals: [], store: {} };

describe("host-driven runs", () => {
	it("passes values as JSON, ends the script at exit(), and bounds a runaway step", async () => {
		const djs = new DjsCodemode({ module, stepFuel: 100_000_000 });
		const vm = djs.begin(
			`const r = await tools.ask({ when: new Date(0), m: new Map([[1, 2]]) });
			try { exit(); } catch { store("caught", true); }
			text("unreachable");`,
			scope,
		);
		await vm.advance();
		expect(vm.calls.map((call) => call.args)).toEqual([[{ when: "1970-01-01T00:00:00.000Z", m: {} }]]);
		vm.settle(vm.calls[0]!.id, { ok: true, value: "x" });
		await vm.advance();
		expect(vm.result).toMatchObject({ ok: true, value: undefined, output: [], storeWrites: { set: {}, delete: [] } });
		vm.dispose();

		const spin = djs.begin("while (true) {}", scope);
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
		const vm = new DjsCodemode({ module }).begin("tools.ask({}); return 'early';", scope);
		await vm.advance();
		expect(vm.result).toMatchObject({ ok: true, value: "early" });
		expect(vm.dropped).toMatchObject([{ identity: "tools.ask", args: [{}] }]);
		vm.dispose();
	});

	it("continues a saved run in another engine, with its output, store writes, and fuel", async () => {
		const djs = new DjsCodemode({ module, fuel: 1_000_000_000 });
		const vm = djs.begin(
			`text("before"); store("k", 1); for (let i = 0; i < 1e5; i++); return await tools.ask({});`,
			scope,
		);
		await vm.advance();
		const saved = vm.save();
		vm.dispose();
		expect(saved).toMatchObject({
			v: 1,
			engine: "djs",
			output: [{ type: "text", text: "before" }],
			writes: [["k", "1"]],
		});
		expect(saved.fuelUsed).toBeGreaterThan(0);
		const resumed = new DjsCodemode({ module, fuel: saved.fuelUsed! }).resume(scope, saved);
		resumed.settle(resumed.calls[0]!.id, { ok: true, value: "answer" });
		await resumed.advance();
		// The fuel used before the save counts: the resumed run has none left.
		expect(resumed.result).toMatchObject({ ok: false, error: { kind: "timeout" } });
		resumed.dispose();
	});
});

describe("imports from virtual modules", () => {
	const modules: CodemodeScope = {
		tools: [],
		globals: [],
		store: {},
		modules: [
			{ specifier: "@mcp/github", exports: [{ name: "search_issues", identity: "@mcp/github#search-issues" }] },
		],
	};

	it("binds named and namespace imports by identity, across a save and a resume", async () => {
		const djs = new DjsCodemode({ module });
		const vm = djs.begin(
			`import { search_issues as search } from "@mcp/github";
			import * as gh from "@mcp/github";
			const a = await search({ q: "a" });
			return [a, await gh.search_issues({ q: "b" }), gh.search_issues === search];`,
			modules,
		);
		await vm.advance();
		expect(vm.calls).toMatchObject([{ identity: "@mcp/github#search-issues", args: [{ q: "a" }] }]);
		vm.settle(vm.calls[0]!.id, { ok: true, value: "A" });
		await vm.advance();
		const saved = vm.save();
		vm.dispose();
		const resumed = djs.resume(modules, saved);
		expect(resumed.calls).toMatchObject([{ identity: "@mcp/github#search-issues", args: [{ q: "b" }] }]);
		resumed.settle(resumed.calls[0]!.id, { ok: true, value: "B" });
		await resumed.advance();
		expect(resumed.result).toMatchObject({ ok: true, value: ["A", "B", true] });
		resumed.dispose();
	});

	it("reports an unknown module as a syntax error", async () => {
		const vm = new DjsCodemode({ module }).begin(`import { x } from "@mcp/nope"; return x;`, modules);
		await vm.advance();
		expect(vm.result).toMatchObject({ ok: false, error: { kind: "script", name: "SyntaxError" } });
		expect(JSON.stringify(vm.result)).toContain("@mcp/nope");
		vm.dispose();
	});
});

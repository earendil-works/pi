// Tests of the terminal's sandbox (slice 11 §4, decision "Slice 11, P8"; fix rounds 1 to 3: a child process, every
// way to modules and descriptors closed). The operating system's layer alone: no terminal descriptor, no `/dev/tty`,
// no file, no SQLite, no network, no child process, worker, addon or inspector, no environment (signals, machine
// details and whether a path exists are its known gaps). The whole sandbox, from the app's terminal code and from a
// plugin: no builtin past the allowlist (shared prototypes changed first included), no getter on a prototype of Node's
// process, no `import()`, no Node `process`. Run under Node 26.5.1 or later (`TUI_NODE`), on a pseudo-terminal;
// skipped without.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { SANDBOX_PROCESS } from "../../../src/node/tui/sandbox.ts";
import { MARK } from "../fixtures/tui/escapes.ts";
import { Launched, TUI_NODE, tuiApp } from "./support.ts";

const RUN = fileURLToPath(new URL("../fixtures/tui/sandbox-run.ts", import.meta.url));
const OS_LAYER = fileURLToPath(new URL("../fixtures/tui/os-layer.ts", import.meta.url));

describe.skipIf(TUI_NODE === undefined)("the sandbox", () => {
	it("as a process reaches no terminal, file, SQLite, network or environment, past any JavaScript (Opus E1, E2)", () => {
		// On a pseudo-terminal, as a launcher runs: the child's descriptors are pipes all the same.
		const command = [TUI_NODE!, "--no-warnings", OS_LAYER].map((arg) => `'${arg}'`).join(" ");
		const output = execFileSync("script", ["-qefc", command, "/dev/null"], { encoding: "utf8", timeout: 30_000 });
		const outcomes = JSON.parse(output.slice(output.indexOf("{"))) as Record<string, string>;
		expect(outcomes).toEqual({
			"a terminal descriptor": "none",
			"open /dev/tty": "ERR_ACCESS_DENIED",
			"read a file": "ERR_ACCESS_DENIED",
			"list its directory": "ERR_ACCESS_DENIED",
			"write a file": "ERR_ACCESS_DENIED",
			"node:sqlite": "absent",
			"require sqlite": "ERR_UNKNOWN_BUILTIN_MODULE",
			"net.connect": "ERR_ACCESS_DENIED",
			fetch: expect.not.stringMatching(/^ok$/),
			"a child process": "ERR_ACCESS_DENIED",
			"a worker": "ERR_ACCESS_DENIED",
			"an addon": "ERR_DLOPEN_DISABLED",
			"the inspector": "ERR_ACCESS_DENIED",
			"an environment": "empty",
			// Known gaps: Node has no permission for signals, and the machine's details need none.
			"signal the launcher": "ok",
			"os details": "ok",
			"whether a path exists": "ok",
		});
	});

	it("closes every escape to the app's code and to plugins, on a real terminal (Fable C1, Opus H1, E1, E2)", async () => {
		const { app, port } = await tuiApp();
		const launched = new Launched([`http://127.0.0.1:${port}`, "token", app.ownerTokenFile], "pty");
		try {
			// A plugin's own attempts, at its evaluation: none got through.
			const [, tried] = await launched.waitFor(/lines: \["plugin v1 tried=(\d+) escaped=none"\]/);
			expect(Number(tried)).toBeGreaterThan(80);
			launched.type("p");
			const [, json] = await launched.waitFor(/probes: (\{[^\r]*\})/);
			const found = JSON.parse(json!) as Record<string, string>;
			expect(Object.keys(found).length).toBeGreaterThan(80);
			expect(Object.entries(found).filter(([, outcome]) => outcome === "ok")).toEqual([]);
			expect(found).toMatchObject({
				"getBuiltinModule tty": "node:tty: unavailable in the terminal's sandbox",
				"require sqlite": "node:sqlite: unavailable in the terminal's sandbox",
				"process.binding('tty_wrap')": expect.stringMatching(/is not a function$/),
				"Set.prototype.has patched": "node:tty: unavailable in the terminal's sandbox",
				"String.prototype.slice patched": "node:events: unavailable in the terminal's sandbox",
				emitter: "not reached",
				"a getter on Object.prototype": "Cannot define property noDeprecation, object is not extensible",
				"a getter on EventEmitter.prototype": "Cannot define property noDeprecation, object is not extensible",
				"a prototype under EventEmitter.prototype": "#<EventEmitter> is not extensible",
				getter: "Cannot define property noDeprecation, object is not extensible",
				import: "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING",
				env: "empty",
			});
			// The process the sandbox's code sees: exactly the allowed properties, a frozen plain object (a new property
			// fails here until it is judged and allowed).
			launched.type("s");
			const [, shape] = await launched.waitFor(/process: (\{[^\r]*\})/);
			expect(JSON.parse(shape!)).toEqual({ own: [...SANDBOX_PROCESS].sort(), plain: true, frozen: true });
			launched.type("q");
			expect(await launched.exited).toBe(3);
			expect(launched.output).not.toContain(MARK);
		} finally {
			launched.kill();
			await app.close(context);
		}
	}, 60_000);

	it("gives raw downloaded code no builtin and no import(), whatever it puts on Object.prototype", () => {
		const script = [
			"const bridge = globalThis.chordBridge;",
			'try { require("node:tty"); bridge.send({ kind: "write", data: "require ok" }); } catch (error) { bridge.send({ kind: "write", data: error.message }); }',
			// Opus: an option on Object.prototype was read by the bridge's evaluation.
			'Object.prototype.importModuleDynamically = () => process.getBuiltinModule("node:events");',
			'globalThis.report = (outcome) => bridge.send({ kind: "write", data: "evaluated import " + outcome });',
			"bridge.evaluate(\"import('node:fs').then(() => 'ok', (error) => error.code).then(report)\", \"probe.js\");",
			'import("node:fs").then(() => "ok", (error) => error.code).then((outcome) => {',
			'	bridge.send({ kind: "write", data: "import " + outcome });',
			'	bridge.send({ kind: "exit", code: 0 });',
			"});",
		].join("\n");
		const lines = execFileSync(TUI_NODE!, ["--no-warnings", RUN, script], { encoding: "utf8", timeout: 30_000 })
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { kind: string; data?: string });
		expect(lines.map(({ kind, data }) => [kind, data])).toEqual([
			["write", "node:tty: unavailable in the terminal's sandbox"],
			["write", "evaluated import ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING"],
			["write", "import ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING"],
			["exit", undefined],
		]);
	});
});

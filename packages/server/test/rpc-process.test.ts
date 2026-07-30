import { describe, expect, it } from "vitest";
import { parseRpcLine, RpcProcessInstance } from "../src/rpc-process.ts";

// Test-only subclass that overrides the protected spawn hook so integration
// tests can drive the real stdout parsing path without needing a built
// @earendil-works/pi-coding-agent RPC entry on disk. The command to spawn is
// carried through module-scoped state because the super constructor invokes
// getSpawnCommand before the subclass body runs (fields aren't initialized
// yet).
//
// NOTE: Non-reentrant. If more than one test constructs TestRpcProcessInstance,
// serialize them or refactor.
let pendingTestCommand: { command: string; args: string[] } | null = null;

class TestRpcProcessInstance extends RpcProcessInstance {
	constructor(options: { cwd: string; command: string; args: string[] }) {
		pendingTestCommand = { command: options.command, args: options.args };
		try {
			super({ cwd: options.cwd });
		} finally {
			pendingTestCommand = null;
		}
	}

	protected override getSpawnCommand(): { command: string; args: string[] } {
		if (!pendingTestCommand) {
			throw new Error("TestRpcProcessInstance: no pending spawn command");
		}
		return pendingTestCommand;
	}
}

describe("parseRpcLine", () => {
	it("returns the parsed value for valid JSON", () => {
		const result = parseRpcLine('{"type":"response","id":"abc"}');
		expect(result).toEqual({ type: "response", id: "abc" });
	});

	it("returns undefined for malformed JSON instead of throwing", () => {
		expect(parseRpcLine("not json")).toBeUndefined();
		expect(parseRpcLine("{unterminated")).toBeUndefined();
		expect(parseRpcLine("")).toBeUndefined();
	});
});

describe("RpcProcessInstance stdout handling", () => {
	it("does not throw an uncaught exception when the child writes a non-JSON line and still dispatches valid events after", async () => {
		const script = [
			// A stray non-JSON line the child might emit (log line, node warning, partial line).
			'process.stdout.write("not json\\n");',
			// Followed by a valid event that must still reach eventListeners.
			'process.stdout.write(JSON.stringify({ type: "custom_event", value: 42 }) + "\\n");',
			// Keep the child alive briefly so the parent can observe both lines.
			"setTimeout(() => process.exit(0), 200);",
		].join("");

		const uncaughtErrors: Error[] = [];
		const onUncaught = (err: Error) => {
			uncaughtErrors.push(err);
		};
		process.on("uncaughtException", onUncaught);

		try {
			let exitError: Error | undefined;
			const rpc = new TestRpcProcessInstance({
				cwd: process.cwd(),
				command: process.execPath,
				args: ["-e", script],
			});

			const events: unknown[] = [];
			rpc.onEvent((event) => events.push(event));
			await new Promise<void>((resolve) => {
				rpc.onExit((err) => {
					exitError = err;
					resolve();
				});
			});
			// Two setImmediate ticks so any uncaughtException from the (unfixed)
			// baseline can propagate through the microtask queue and into the
			// process-level listener registered above.
			await new Promise((resolve) => setImmediate(resolve));
			await new Promise((resolve) => setImmediate(resolve));

			expect(uncaughtErrors).toEqual([]);
			expect(exitError?.message).toContain("discarded malformed stdout line: not json");
			expect(events).toEqual([{ type: "custom_event", value: 42 }]);

			await rpc.dispose();
		} finally {
			process.off("uncaughtException", onUncaught);
		}
	});
});

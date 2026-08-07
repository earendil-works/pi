import { describe, expect, it } from "vitest";
import { VERSION } from "../src/config.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import type { SessionManager } from "../src/core/session-manager.ts";

function createRunner(): ExtensionRunner {
	const runtime = createExtensionRuntime();
	return new ExtensionRunner([], runtime, process.cwd(), {} as SessionManager, {} as ModelRegistry);
}

describe("setExitForegroundTask", () => {
	it("throws while no command context actions are bound", () => {
		const runner = createRunner();
		expect(() => runner.createCommandContext().setExitForegroundTask(() => {})).toThrow(/only available in TUI mode/);
	});

	it("throws in RPC/print/json mode even when a throwing action is bound", () => {
		// print-mode.ts and rpc-mode.ts bind a throwing action for
		// setExitForegroundTask; the rejection must persist across calls.
		const runner = createRunner();
		runner.bindCommandContext({
			setExitForegroundTask: () => {
				throw new Error("setExitForegroundTask is only available in TUI mode");
			},
		} as never);
		const ctx = runner.createCommandContext();
		expect(() => ctx.setExitForegroundTask(() => {})).toThrow(/only available in TUI mode/);
		expect(() => ctx.setExitForegroundTask(() => {})).toThrow(/only available in TUI mode/);
	});

	it("wires the task handler and rejects a second registration", () => {
		const runner = createRunner();
		const tasks: Array<(code: number) => Promise<void> | void> = [];
		runner.bindCommandContext({
			setExitForegroundTask: (task: (code: number) => Promise<void> | void) => {
				tasks.push(task);
			},
		} as never);
		const ctx = runner.createCommandContext();
		ctx.setExitForegroundTask(async () => {});
		expect(tasks).toHaveLength(1);
		expect(() => ctx.setExitForegroundTask(async () => {})).toThrow(/already registered/);
	});

	it("keeps rejecting after command context actions are unbound", () => {
		const runner = createRunner();
		const tasks: Array<(code: number) => Promise<void> | void> = [];
		runner.bindCommandContext({
			setExitForegroundTask: (task: (code: number) => Promise<void> | void) => {
				tasks.push(task);
			},
		} as never);
		runner.createCommandContext().setExitForegroundTask(() => {});
		runner.bindCommandContext(undefined);
		// Per-process semantics: a registration stays registered even if the
		// command context actions are later unbound.
		expect(() => runner.createCommandContext().setExitForegroundTask(() => {})).toThrow(/already registered/);
	});

	it("throws when the command context is stale", () => {
		const runner = createRunner();
		runner.bindCommandContext({ setExitForegroundTask: () => {} } as never);
		const ctx = runner.createCommandContext();
		runner.invalidate("stale test context");
		expect(() => ctx.setExitForegroundTask(() => {})).toThrow(/stale test context/);
	});
});

describe("ctx.version", () => {
	it("exposes the package version in event and command contexts", () => {
		const runner = createRunner();
		expect(runner.createContext().version).toBe(VERSION);
		expect(runner.createCommandContext().version).toBe(VERSION);
	});

	it("uses the version provided by the host via bindCore", () => {
		const runtime = createExtensionRuntime();
		const runner = new ExtensionRunner([], runtime, process.cwd(), {} as SessionManager, {} as ModelRegistry);
		runner.bindCore({} as never, { getVersion: () => "1.2.3-test" } as never);
		expect(runner.createContext().version).toBe("1.2.3-test");
		expect(runner.createCommandContext().version).toBe("1.2.3-test");
		expect(runtime.version).toBe("1.2.3-test");
	});
});

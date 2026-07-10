import { describe, expect, it } from "vitest";
import { createEventBus } from "../../../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../../../src/core/extensions/runner.ts";

describe("regression #6101: reused extension runtime is reactivated on bindCore()", () => {
	it("clears the stale marker when a new session rebinds the same runtime", async () => {
		let captured: { getFlag: (name: string) => unknown } | undefined;
		const factory = (pi: {
			on: (event: string, handler: () => Promise<unknown>) => void;
			getFlag: (name: string) => unknown;
		}) => {
			captured = pi;
			pi.on("session_start", async () => captured!.getFlag("foo"));
		};

		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			factory as never,
			process.cwd(),
			createEventBus(),
			runtime,
			"<inline:test>",
		);
		const handler = extension.handlers.get("session_start")![0] as () => Promise<unknown>;

		// session 1: runtime is active
		await expect(handler()).resolves.toBeUndefined();

		// dispose session 1 poisons the shared runtime
		runtime.invalidate();
		expect(() => runtime.assertActive()).toThrow(/stale/);

		// session 2 reuses the same runtime; bindCore() must reactivate it
		const runner = new ExtensionRunner(
			[extension],
			runtime,
			process.cwd(),
			{} as never,
			{} as never,
		);
		runner.bindCore({} as never, {} as never, undefined);
		await expect(handler()).resolves.toBeUndefined();
	});

	it("still throws when invalidated and never rebinded", () => {
		const runtime = createExtensionRuntime();
		runtime.invalidate();
		expect(() => runtime.assertActive()).toThrow(/stale/);
	});
});

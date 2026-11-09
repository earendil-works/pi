import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../../../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../../src/core/extensions/loader.ts";
import type { ExtensionError, ExtensionFactory } from "../../../src/index.ts";
import { createTestResourceLoader } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

// #11264: while the interactive TUI draws on the terminal, any direct write to stdout or stderr lands at the
// cursor and corrupts its screen. Errors from extension event-bus handlers must reach the UI instead.
describe("issue #11264 extension event-bus errors under the TUI", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("reports a throwing pi.events handler to the extension error listener instead of stderr", async () => {
		const eventBus = createEventBus();
		const factory: ExtensionFactory = (pi) => {
			pi.events.on("test:boom", () => {
				throw new Error("handler failed");
			});
		};
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(factory, process.cwd(), eventBus, runtime, "<boom>");
		const resourceLoader = createTestResourceLoader({
			extensionsResult: { extensions: [extension], errors: [], runtime },
		});
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		const errors: ExtensionError[] = [];
		await harness.session.bindExtensions({ onError: (error) => errors.push(error) });
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		eventBus.emit("test:boom", undefined);
		await new Promise((resolve) => setImmediate(resolve));

		expect(errors).toEqual([
			expect.objectContaining({ extensionPath: "<boom>", event: "events:test:boom", error: "handler failed" }),
		]);
		expect(consoleError).not.toHaveBeenCalled();
	});
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../../../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../../src/core/extensions/loader.ts";
import type { ExtensionError, ExtensionFactory } from "../../../src/index.ts";
import { createTestResourceLoader } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

// #11264: the event bus printed a throwing pi.events handler with console.error, which draws over the
// interactive TUI. Such errors now go to the extension error listener like other extension errors.
describe("issue #11264 pi.events handler errors", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function setup() {
		const eventBus = createEventBus();
		let release: () => void = () => {};
		const factory: ExtensionFactory = (pi) => {
			pi.events.on("test:boom", () => {
				throw new Error("handler failed");
			});
			pi.events.on("test:late", async () => {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				throw new Error("late failure");
			});
		};
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(factory, process.cwd(), eventBus, runtime, "<boom>");
		const harness = await createHarness({
			resourceLoader: createTestResourceLoader({
				extensionsResult: { extensions: [extension], errors: [], runtime },
			}),
		});
		harnesses.push(harness);
		const errors: ExtensionError[] = [];
		await harness.session.bindExtensions({ onError: (error) => errors.push(error) });
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		return { eventBus, harness, errors, consoleError, release: () => release() };
	}

	const settle = () => new Promise((resolve) => setImmediate(resolve));

	it("reports a throwing handler to the extension error listener instead of stderr", async () => {
		const { eventBus, errors, consoleError } = await setup();

		eventBus.emit("test:boom", undefined);
		await settle();

		expect(errors).toEqual([
			expect.objectContaining({ extensionPath: "<boom>", event: "events:test:boom", error: "handler failed" }),
		]);
		expect(consoleError).not.toHaveBeenCalled();
	});

	it("drops an error from a handler that fails after its session was disposed", async () => {
		const { eventBus, harness, errors, consoleError, release } = await setup();

		eventBus.emit("test:late", undefined);
		await settle();
		harness.session.dispose();
		release();
		await settle();

		expect(errors).toEqual([]);
		expect(consoleError).not.toHaveBeenCalled();
	});
});

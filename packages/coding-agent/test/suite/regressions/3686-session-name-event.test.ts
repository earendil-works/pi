import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("regression #3686: session name changes emit an event", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("emits session_info_changed when AgentSession.setSessionName is called", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.session.setSessionName("hello world");

		expect(harness.sessionManager.getSessionName()).toBe("hello world");
		expect(harness.eventsOfType("session_info_changed").map((event) => event.name)).toEqual(["hello world"]);
	});

	it("emits session_info_changed when an extension calls pi.setSessionName", async () => {
		let api: ExtensionAPI | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					api = pi;
				},
			],
		});
		harnesses.push(harness);

		api?.setSessionName("from extension");

		expect(harness.sessionManager.getSessionName()).toBe("from extension");
		expect(harness.eventsOfType("session_info_changed").map((event) => event.name)).toEqual(["from extension"]);
	});

	it("emits session_info_changed to extensions", async () => {
		let api: ExtensionAPI | undefined;
		const events: Array<{ name: string | undefined }> = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.on("session_info_changed", (event) => {
						events.push({ name: event.name });
					});
				},
			],
		});
		harnesses.push(harness);

		api?.setSessionName("first");
		harness.session.setSessionName("second");

		expect(events).toEqual([{ name: "first" }, { name: "second" }]);
	});
});

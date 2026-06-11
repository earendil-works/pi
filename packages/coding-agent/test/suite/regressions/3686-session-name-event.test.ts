import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, SessionInfoChangedEvent } from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("regression #3686: session name changes emit an event", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("emits session_info_changed when AgentSession.setSessionName is called", async () => {
		const extensionEvents: SessionInfoChangedEvent[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_info_changed", (event) => {
						extensionEvents.push(event);
					});
				},
			],
		});
		harnesses.push(harness);

		harness.session.setSessionName("hello world");
		await tick();

		expect(harness.sessionManager.getSessionName()).toBe("hello world");
		expect(harness.eventsOfType("session_info_changed").map((event) => event.name)).toEqual(["hello world"]);
		expect(extensionEvents.map((event) => event.name)).toEqual(["hello world"]);
	});

	it("emits session_info_changed when an extension calls pi.setSessionName", async () => {
		let api: ExtensionAPI | undefined;
		const extensionEvents: SessionInfoChangedEvent[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.on("session_info_changed", (event) => {
						extensionEvents.push(event);
					});
				},
			],
		});
		harnesses.push(harness);

		api?.setSessionName("from extension");
		await tick();

		expect(harness.sessionManager.getSessionName()).toBe("from extension");
		expect(harness.eventsOfType("session_info_changed").map((event) => event.name)).toEqual(["from extension"]);
		expect(extensionEvents.map((event) => event.name)).toEqual(["from extension"]);
	});
});

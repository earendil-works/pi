import { afterEach, describe, expect, it } from "vitest";
import { createEventBus } from "../../../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../../src/core/extensions/loader.ts";
import type { ExtensionAPI, ExtensionFactory, ResourceLoader } from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("issue #7193 extension event-bus lifecycle", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("removes extension-owned event-bus listeners on reload and dispose", async () => {
		const eventBus = createEventBus();
		let extensionCalls = 0;
		let hostCalls = 0;
		let firstApi: ExtensionAPI | undefined;
		const factory: ExtensionFactory = (pi) => {
			firstApi ??= pi;
			pi.events.on("reload:test", () => extensionCalls++);
		};
		eventBus.on("reload:test", () => hostCalls++);

		const loadExtensions = async () => {
			const runtime = createExtensionRuntime();
			const extension = await loadExtensionFromFactory(factory, process.cwd(), eventBus, runtime);
			return { extensions: [extension], errors: [], runtime };
		};
		let extensionsResult = await loadExtensions();
		const resourceLoader: ResourceLoader = {
			getExtensions: () => extensionsResult,
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => undefined,
			getSystemPromptSource: () => undefined,
			getAppendSystemPrompt: () => [],
			getAppendSystemPromptSources: () => [],
			extendResources: () => {},
			reload: async () => {
				extensionsResult = await loadExtensions();
			},
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		await harness.session.bindExtensions({ shutdownHandler: () => {} });

		const emit = async () => {
			const extensionBefore = extensionCalls;
			const hostBefore = hostCalls;
			eventBus.emit("reload:test", undefined);
			await new Promise((resolve) => setImmediate(resolve));
			return { extension: extensionCalls - extensionBefore, host: hostCalls - hostBefore };
		};

		expect(await emit()).toEqual({ extension: 1, host: 1 });
		await harness.session.reload();
		expect(() => firstApi?.getCommands()).toThrow("stale after session replacement or reload");
		expect(await emit()).toEqual({ extension: 1, host: 1 });
		await harness.session.reload();
		expect(await emit()).toEqual({ extension: 1, host: 1 });

		harness.session.dispose();
		expect(await emit()).toEqual({ extension: 0, host: 1 });
	});
});

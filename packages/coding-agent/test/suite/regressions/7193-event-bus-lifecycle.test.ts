import { afterEach, describe, expect, it } from "vitest";
import { createEventBus } from "../../../src/core/event-bus.ts";
import type { ExtensionAPI, LoadExtensionsResult } from "../../../src/core/extensions/index.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../../src/core/extensions/loader.ts";
import type { ResourceLoader } from "../../../src/core/resource-loader.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("issue #7193 extension event-bus lifecycle", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("removes only stale extension listeners on reload and dispose", async () => {
		const eventBus = createEventBus();
		const extensionApis: ExtensionAPI[] = [];
		const extensionCalls: number[] = [];
		let hostCalls = 0;
		let generation = 0;

		eventBus.on("issue-7193", () => {
			hostCalls++;
		});

		const loadExtensions = async (): Promise<LoadExtensionsResult> => {
			const runtime = createExtensionRuntime();
			const currentGeneration = generation++;
			const extension = await loadExtensionFromFactory(
				(pi) => {
					extensionApis.push(pi);
					extensionCalls[currentGeneration] = 0;
					pi.events.on("issue-7193", () => {
						extensionCalls[currentGeneration] = (extensionCalls[currentGeneration] ?? 0) + 1;
					});
				},
				process.cwd(),
				eventBus,
				runtime,
				`<issue-7193:${currentGeneration}>`,
			);
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
			getAppendSystemPrompt: () => [],
			extendResources: () => {},
			reload: async () => {
				extensionsResult = await loadExtensions();
			},
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);

		eventBus.emit("issue-7193", undefined);
		expect(extensionCalls).toEqual([1]);
		expect(hostCalls).toBe(1);

		const initialApi = extensionApis[0]!;
		await harness.session.reload();
		expect(() => initialApi.events.emit("issue-7193", undefined)).toThrow(/stale/);

		eventBus.emit("issue-7193", undefined);
		expect(extensionCalls).toEqual([1, 1]);
		expect(hostCalls).toBe(2);

		await harness.session.reload();
		eventBus.emit("issue-7193", undefined);
		expect(extensionCalls).toEqual([1, 1, 1]);
		expect(hostCalls).toBe(3);

		harness.session.dispose();
		eventBus.emit("issue-7193", undefined);
		expect(extensionCalls).toEqual([1, 1, 1]);
		expect(hostCalls).toBe(4);
	});
});

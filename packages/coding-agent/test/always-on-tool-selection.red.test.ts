import { getModel } from "@kennyfrc/mu-ai";
import { afterEach, describe, expect, it } from "vitest";

import {
	createAlwaysOnTestHarness,
	createLoadedExtensionManager,
	loadAlwaysOnToolSelectionModule,
} from "./fixtures/always-on-harness.js";

describe("always-on tool selection (red)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("excludes ask_user even when built-in extensions are loaded", async () => {
		const harness = createAlwaysOnTestHarness("mu-always-on-tool-selection-red-");
		cleanups.push(() => harness.cleanup());

		const extensionManager = await createLoadedExtensionManager(harness);
		const { resolveAlwaysOnToolSelection } = await loadAlwaysOnToolSelectionModule();
		const model = getModel("openai-codex", "gpt-5.4");

		const selection = resolveAlwaysOnToolSelection({
			model,
			extensionManager,
		});

		expect(selection.toolNames).toContain("bash");
		expect(selection.toolNames).toContain("list_threads");
		expect(selection.toolNames).not.toContain("ask_user");
		expect(selection.tools.map((tool) => tool.name)).not.toContain("ask_user");
	});
});

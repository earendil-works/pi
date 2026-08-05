import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

describe("model selector", () => {
	let harness: Harness | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("sorts all-model variants naturally", async () => {
		harness = await createHarness({
			models: [
				{ id: "gpt-5.6-luna@1m", name: "Luna 1M" },
				{ id: "gpt-5.6-luna@200k", name: "Luna 200K" },
				{ id: "gpt-5.6-luna", name: "Luna" },
				{ id: "gpt-5.6-sol@272k", name: "Sol 272K" },
				{ id: "gpt-5.5", name: "GPT-5.5" },
			],
		});

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		const provider = harness.models[0]!.provider;
		const renderedIds = stripAnsi(selector.render(120).join("\\n"))
			.split("\\n")
			.filter((line) => line.includes(`[${provider}]`))
			.map((line) => line.trim().replace(/^→\s*/, "").split(" [")[0]);

		expect(renderedIds).toEqual([
			"gpt-5.5",
			"gpt-5.6-luna",
			"gpt-5.6-luna@200k",
			"gpt-5.6-luna@1m",
			"gpt-5.6-sol@272k",
		]);
		selector.dispose();
	});

	it("lists every catalog that failed to refresh", async () => {
		harness = await createHarness();
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({
			aborted: false,
			errors: new Map([
				["openai", new Error("unavailable")],
				["anthropic", new Error("unavailable")],
			]),
		});

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel(),
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		await vi.waitFor(() => {
			const rendered = stripAnsi(selector.render(120).join("\n"));
			expect(rendered).toContain("Could not refresh 2 model catalogs (openai, anthropic); showing cached models.");
		});
	});
});

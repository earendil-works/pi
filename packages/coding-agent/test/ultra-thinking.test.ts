import { describe, expect, it } from "vitest";
import { isValidThinkingLevel } from "../src/cli/args.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

describe("ultra thinking level", () => {
	it("is accepted by CLI and settings", async () => {
		expect(isValidThinkingLevel("ultra")).toBe(true);

		const settings = SettingsManager.inMemory();
		settings.setDefaultThinkingLevel("ultra");
		await settings.flush();
		expect(settings.getDefaultThinkingLevel()).toBe("ultra");
	});

	it("uses the max thinking border color", () => {
		initTheme("dark");
		expect(theme.getThinkingBorderColor("ultra")("border")).toBe(theme.getThinkingBorderColor("max")("border"));
	});
});

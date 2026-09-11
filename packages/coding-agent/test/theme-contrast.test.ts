import { describe, expect, it } from "vitest";
import { getResolvedThemeColors, getThemeExportColors } from "../src/modes/interactive/theme/theme.ts";

function relativeLuminance(color: string): number {
	const channels = color
		.slice(1)
		.match(/.{2}/g)
		?.map((channel) => Number.parseInt(channel, 16) / 255)
		.map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
	if (!channels || channels.length !== 3) throw new Error(`Expected a six-digit hex color, got ${color}`);
	return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(first: string, second: string): number {
	const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
	const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
	return (lighter + 0.05) / (darker + 0.05);
}

describe("built-in theme contrast", () => {
	it("keeps light-theme warnings readable on built-in light backgrounds", () => {
		const colors = getResolvedThemeColors("light");
		const exportColors = getThemeExportColors("light");
		const backgrounds = ["#ffffff", exportColors.pageBg, exportColors.cardBg, exportColors.infoBg];

		for (const background of backgrounds) {
			if (!background) throw new Error("Built-in light export backgrounds must be defined");
			expect(contrastRatio(colors.warning, background)).toBeGreaterThanOrEqual(4.5);
		}
	});
});

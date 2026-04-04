import { afterEach, describe, expect, it, vi } from "vitest";
import { FooterDataProvider } from "../src/core/footer-data-provider.js";
import { FooterComponent } from "../src/modes/interactive/components/footer.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

describe("FooterComponent footer segments", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders registered footer segments after built-in footer lines", () => {
		initTheme("dark");
		const provider = new FooterDataProvider(process.cwd());
		provider.registerFooterSegment({
			key: "segment-a",
			priority: 5,
			render: () => "segment line",
		});
		provider.registerFooterSegment({
			key: "segment-b",
			priority: 10,
			render: () => ["segment extra 1", "segment extra 2"],
		});

		const session = {
			state: {
				model: { id: "model", provider: "provider", reasoning: false, contextWindow: 200_000 },
				thinkingLevel: "off",
			},
			sessionManager: {
				getEntries: () => [],
				getCwd: () => process.cwd(),
				getSessionName: () => undefined,
			},
			getContextUsage: () => ({ tokens: 1000, contextWindow: 200_000, percent: 0.5 }),
			modelRegistry: {
				isUsingOAuth: () => false,
			},
		} as any;

		const footer = new FooterComponent(session, provider);
		const lines = footer.render(120);

		expect(lines.some((line) => line.includes("segment line"))).toBe(true);
		expect(lines.some((line) => line.includes("segment extra 1"))).toBe(true);
		expect(lines.some((line) => line.includes("segment extra 2"))).toBe(true);

		provider.dispose();
	});

	it("disposes replaced footer segments when overwritten or cleared", () => {
		const provider = new FooterDataProvider(process.cwd());
		const firstDispose = vi.fn();
		const secondDispose = vi.fn();
		provider.registerFooterSegment({
			key: "segment-a",
			priority: 0,
			render: () => "one",
			dispose: firstDispose,
		});
		provider.registerFooterSegment({
			key: "segment-a",
			priority: 0,
			render: () => "two",
			dispose: secondDispose,
		});

		expect(firstDispose).toHaveBeenCalledTimes(1);
		provider.unregisterFooterSegment("segment-a");
		expect(secondDispose).toHaveBeenCalledTimes(1);

		provider.dispose();
	});
});

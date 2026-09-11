import type { Usage } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { EarendilAnnouncementComponent } from "../../../src/modes/interactive/components/earendil-announcement.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme, onThemeChange, setTheme, theme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness } from "../harness.ts";

type CompactionNoticeContext = {
	chatContainer: Container;
	settingsManager: { getShowCacheMissNotices(): boolean };
};

const addCompactionCostNotice = Reflect.get(InteractiveMode.prototype, "addCompactionCostNotice") as (
	this: CompactionNoticeContext,
	notice: {
		type: "compaction_cost";
		kind: "compaction" | "branch_summary";
		usage: Usage;
	},
) => void;

describe("regression #8212: theme invalidation", () => {
	afterEach(() => {
		onThemeChange(() => {});
		initTheme("dark");
	});

	it("removes the old palette from persistent built-in transcript text", async () => {
		const harness = await createHarness({ settings: { showCacheMissNotices: true } });
		const usage: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
		};

		try {
			initTheme("dark");
			const root = new Container();
			root.addChild(new EarendilAnnouncementComponent());
			addCompactionCostNotice.call(
				{ chatContainer: root, settingsManager: harness.settingsManager },
				{ type: "compaction_cost", kind: "compaction", usage },
			);

			const oldPalette = [
				theme.getFgAnsi("accent"),
				theme.getFgAnsi("muted"),
				theme.getFgAnsi("mdLink"),
				theme.getFgAnsi("warning"),
			];
			const visibleFrame = stripAnsi(root.render(120).join("\n"));

			onThemeChange(() => root.invalidate());
			expect(setTheme("light").success).toBe(true);
			const newFrame = root.render(120).join("\n");

			for (const color of oldPalette) {
				expect(newFrame).not.toContain(color);
			}
			expect(newFrame).toContain(theme.getFgAnsi("accent"));
			expect(newFrame).toContain(theme.getFgAnsi("muted"));
			expect(newFrame).toContain(theme.getFgAnsi("mdLink"));
			expect(newFrame).toContain(theme.getFgAnsi("warning"));
			expect(stripAnsi(newFrame)).toBe(visibleFrame);
		} finally {
			harness.cleanup();
		}
	});
});

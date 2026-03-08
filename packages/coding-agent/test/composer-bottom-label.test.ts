import assert from "node:assert";
import { Text } from "@kennyfrc/mu-tui";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { initTheme } from "../src/theme/theme.js";
import { ChatLayoutComponent } from "../src/tui/chat-layout.js";

describe("ChatLayoutComponent composer bottom label", () => {
	it("renders usage info on the composer bottom-right border", () => {
		initTheme("dark");
		const layout = new ChatLayoutComponent({
			chatContent: new Text("chat", 0, 0),
			composerContent: new Text("composer", 0, 0),
			inputTarget: new Text("", 0, 0),
			footer: new Text("footer line 1\nfooter line 2", 0, 0),
			getComposerLabel: () => "gpt-5.1 • medium [openai-codex]",
			getComposerMetaLabel: () => "(sub) 10% of 272k • 5h 75% • weekly 15%",
			getComposerBorderColor: () => (text: string) => text,
			updateComposerViewport: () => {},
		});

		const rows = layout.render(90).map((row) => stripAnsi(row));
		const composerStart = rows.findIndex((row) => row.startsWith("╭─ gpt-5.1 • medium [openai-codex]"));
		assert.notEqual(composerStart, -1, "expected composer border to be present");
		const bottomBorder = rows[composerStart + 3] ?? "";

		expect(bottomBorder).toContain("(sub) 10% of 272k • 5h 75% • weekly 15%");
		expect(bottomBorder.endsWith("weekly 15% ╯")).toBe(true);
	});
});

import { visibleWidth } from "@kennyfrc/mu-tui";
import { describe, expect, it } from "vitest";
import { formatQueuedMessagePreview } from "../src/tui/queued-message-preview.js";
import { QueuedMessagePreviewComponent } from "../src/tui/queued-message-preview-component.js";

describe("QueuedMessagePreviewComponent", () => {
	it("clamps long queued previews to four visual lines", () => {
		const raw = [
			"ok given this, please implement the fix. do not stop until you have verified with xtui that you can text select stuff and then copy it and stuff",
			"**Your Task: Test-Driven Implementation Loop with Backpressure**",
			"First, do a task breakdown where each task represents an iteration that addresses",
			"there is currently no truncation. we must truncate to about 4 lines at least on a preview in the tui. obv, it should show the whole thing.",
			"## Problem Discovery Notes:",
			"1. Problem Statement",
		].join("\n");

		const component = new QueuedMessagePreviewComponent(formatQueuedMessagePreview(raw, "by-end"));
		const rendered = component.render(60);

		expect(rendered).toHaveLength(4);
		expect(rendered[3]).toContain("…");
		expect(rendered.join("\n")).not.toContain("Problem Discovery Notes");
		for (const line of rendered) {
			expect(visibleWidth(line)).toBe(60);
		}
	});

	it("keeps short queued previews intact", () => {
		const component = new QueuedMessagePreviewComponent(formatQueuedMessagePreview("line 1\nline 2", "next"));
		const rendered = component.render(60);

		expect(rendered).toHaveLength(2);
		expect(rendered.join("\n")).toContain("Queued next: line 1");
		expect(rendered.join("\n")).toContain("line 2");
	});
});

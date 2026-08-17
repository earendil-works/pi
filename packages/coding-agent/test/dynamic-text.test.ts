import { describe, expect, it } from "vitest";
import { ExpandableText } from "../src/modes/interactive/components/dynamic-text.ts";

describe("ExpandableText", () => {
	it("recomputes the selected text while preserving expansion state", () => {
		let presentation = "old";
		const text = new ExpandableText(
			() => `collapsed:${presentation}`,
			() => `expanded:${presentation}`,
			true,
			0,
			0,
		);

		expect(text.render(40).join("\n")).toContain("expanded:old");

		presentation = "new";
		text.invalidate();
		const expanded = text.render(40).join("\n");
		expect(expanded).toContain("expanded:new");
		expect(expanded).not.toContain("collapsed:");

		text.setExpanded(false);
		expect(text.render(40).join("\n")).toContain("collapsed:new");
	});
});

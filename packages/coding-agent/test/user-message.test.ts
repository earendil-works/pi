import { beforeAll, describe, expect, it } from "vitest";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

describe("UserMessageComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("does not emit inline OSC 133 prompt markers", () => {
		const component = new UserMessageComponent("hi there");
		const rendered = component.render(40).join("\n");

		expect(rendered).not.toContain(OSC133_ZONE_START);
		expect(rendered).not.toContain(OSC133_ZONE_END);
		expect(rendered).not.toContain(OSC133_ZONE_FINAL);
	});

	it("does not emit inline OSC 133 prompt markers for multi-line messages", () => {
		const component = new UserMessageComponent("hello\nworld");
		const rendered = component.render(40).join("\n");

		expect(rendered).not.toContain(OSC133_ZONE_START);
		expect(rendered).not.toContain(OSC133_ZONE_END);
		expect(rendered).not.toContain(OSC133_ZONE_FINAL);
	});
});

import { describe, expect, it } from "vitest";

import { initTheme } from "../theme/theme.js";
import { UserMessageComponent } from "./user-message.js";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

describe("UserMessageComponent timestamp parsing", () => {
	it("hides embedded user_message_time XML even when the timestamp block is adjacent to the prompt", () => {
		initTheme("dark");
		const component = new UserMessageComponent(
			"<user_message_time>Thursday, March 19, 2026 at 10:38 PM GMT+8</user_message_time>compact this\nfor me.",
			true,
		);

		const rendered = component.render(80).map(stripAnsi).join("\n");

		expect(rendered).toContain("Thursday, March 19, 2026 at 10:38 PM GMT+8");
		expect(rendered).toContain("compact this");
		expect(rendered).not.toContain("<user_message_time>");
		expect(rendered).not.toContain("</user_message_time>");
	});
});

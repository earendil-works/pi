import { visibleWidth } from "@kennyfrc/mu-tui";
import { describe, expect, it } from "vitest";
import { setTheme } from "../src/theme/theme.js";
import { SessionSelectorComponent } from "../src/tui/session-selector.js";

describe("SessionSelectorComponent width safety", () => {
	it("keeps rendered lines within the viewport width", () => {
		setTheme("dark");
		const sessionManager = {
			loadAllSessions: () => [
				{
					path: "/tmp/session.jsonl",
					id: "s1",
					created: new Date("2026-04-01T00:00:00Z"),
					modified: new Date("2026-04-01T00:00:00Z"),
					messageCount: 3,
					firstMessage: "你好你好你好你好你好",
					allMessagesText: "你好你好你好你好你好",
				},
			],
		};

		const component = new SessionSelectorComponent(
			sessionManager as never,
			() => {},
			() => {},
		);
		const lines = component.render(12);

		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(12);
		}
	});
});

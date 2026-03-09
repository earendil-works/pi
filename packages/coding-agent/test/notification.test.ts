import { describe, expect, it } from "vitest";

import { buildTerminalNotificationSequence, detectTerminalNotificationBackend } from "../src/notification.js";

describe("notification terminal backends", () => {
	it("does not use terminal-native notifications for Ghostty", () => {
		expect(detectTerminalNotificationBackend({ TERM_PROGRAM: "ghostty" }, true)).toBeNull();
	});

	it("uses osc9 for iTerm", () => {
		expect(detectTerminalNotificationBackend({ ITERM_SESSION_ID: "abc" }, true)).toBe("osc9");
	});

	it("uses osc9 for WezTerm TERM fallback", () => {
		expect(detectTerminalNotificationBackend({ TERM: "wezterm" }, true)).toBe("osc9");
	});

	it("uses osc9 for iTerm TERM_PROGRAM", () => {
		expect(detectTerminalNotificationBackend({ TERM_PROGRAM: "iTerm.app" }, true)).toBe("osc9");
	});

	it("disables terminal notifications for non-tty output", () => {
		expect(detectTerminalNotificationBackend({ TERM_PROGRAM: "ghostty" }, false)).toBeNull();
	});

	it("builds an osc777 title + body sequence", () => {
		expect(buildTerminalNotificationSequence("osc777", "AI Response", "Finished working")).toBe(
			"\u001b]777;notify;AI Response;Finished working\u0007",
		);
	});

	it("builds an osc9 fallback sequence with combined title and body", () => {
		expect(buildTerminalNotificationSequence("osc9", "Mu - repo", "Finished working")).toBe(
			"\u001b]9;Mu - repo: Finished working\u0007",
		);
	});

	it("sanitizes control characters and semicolons for terminal sequences", () => {
		expect(buildTerminalNotificationSequence("osc777", "AI;Response", "Done\u0007\u001bnow")).toBe(
			"\u001b]777;notify;AI:Response;Done  now\u0007",
		);
	});
});

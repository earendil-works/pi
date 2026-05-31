import { describe, expect, it } from "vitest";
import { MAX_SESSION_NAME_LENGTH, normalizeSessionName, SessionManager } from "../../src/core/session-manager.ts";

describe("normalizeSessionName", () => {
	it("normalizes whitespace and control characters", () => {
		expect(normalizeSessionName("  hello\n\tworld\ragain  ")).toBe("hello world again");
	});

	it("normalizes whitespace-only names to an empty string", () => {
		expect(normalizeSessionName(" \t\n  \r\t ")).toBe("");
	});

	it("caps names to a bounded metadata length", () => {
		const name = normalizeSessionName("a".repeat(MAX_SESSION_NAME_LENGTH + 1));

		expect(name).toHaveLength(MAX_SESSION_NAME_LENGTH);
		expect(name.endsWith("...")).toBe(true);
	});
});

describe("SessionManager session names", () => {
	it("stores normalized session names", () => {
		const session = SessionManager.inMemory();

		session.appendSessionInfo("  hello\n\tworld\ragain  ");

		expect(session.getSessionName()).toBe("hello world again");
	});
});

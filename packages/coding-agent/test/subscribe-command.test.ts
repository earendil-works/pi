import { describe, expect, test } from "vitest";
import { parseSubscribeCommand } from "../src/subscriptions/subscribe-command.js";

describe("parseSubscribeCommand", () => {
	test("returns session id for valid command", () => {
		const sessionId = "123e4567-e89b-12d3-a456-426614174000";
		const result = parseSubscribeCommand(`/subscribe ${sessionId}`);
		expect(result).not.toBeNull();
		expect(result?.sessionId).toBe(sessionId);
	});

	test("returns null for missing or invalid id", () => {
		expect(parseSubscribeCommand("/subscribe")).toBeNull();
		expect(parseSubscribeCommand("/subscribe not-a-uuid")).toBeNull();
	});
});

import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.js";

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("SessionManager.newSession with custom id", () => {
	it("uses the provided id instead of generating one", () => {
		const session = SessionManager.inMemory();
		session.newSession({ id: "my-custom-id" });
		expect(session.getSessionId()).toBe("my-custom-id");
	});

	it("generates a random id when no id is provided", () => {
		const session = SessionManager.inMemory();
		session.newSession();
		const id = session.getSessionId();
		expect(id).toBeDefined();
		expect(id).not.toBe("");
		expect(id).toMatch(UUID_V7_RE);
	});

	it("generates a random id when options is provided without id", () => {
		const session = SessionManager.inMemory();
		session.newSession({ parentSession: "parent.jsonl" });
		const id = session.getSessionId();
		expect(id).toBeDefined();
		expect(id).not.toBe("");
		expect(id).toMatch(UUID_V7_RE);
	});

	it("includes the custom id in the session header", () => {
		const session = SessionManager.inMemory();
		session.newSession({ id: "header-test-id" });

		const header = session.getHeader();
		expect(header).not.toBeNull();
		expect(header!.id).toBe("header-test-id");
	});

	it("generates a UUIDv7 id when constructed without an explicit id", () => {
		const session = SessionManager.inMemory();
		expect(session.getSessionId()).toMatch(UUID_V7_RE);
		expect(session.getHeader()!.id).toBe(session.getSessionId());
	});

	it("generates a UUIDv7 id when creating a branched session", () => {
		const session = SessionManager.inMemory();
		const firstId = session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: Date.now(),
		});

		session.createBranchedSession(firstId);

		expect(session.getSessionId()).toMatch(UUID_V7_RE);
		expect(session.getHeader()!.id).toBe(session.getSessionId());
	});
});

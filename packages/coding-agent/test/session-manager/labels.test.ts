import { describe, expect, it } from "vitest";
import { type LabelEntry, SessionManager } from "../../src/core/session-manager.js";

describe("SessionManager labels", () => {
	it("sets and gets labels", () => {
		const session = SessionManager.inMemory();

		const msgId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		// No label initially
		expect(session.getLabel(msgId)).toBeUndefined();

		// Set a label
		const labelId = session.appendLabelChange(msgId, "checkpoint");
		expect(session.getLabel(msgId)).toBe("checkpoint");

		// Label entry should be in entries
		const entries = session.getEntries();
		const labelEntry = entries.find((e) => e.type === "label") as LabelEntry;
		expect(labelEntry).toBeDefined();
		expect(labelEntry.id).toBe(labelId);
		expect(labelEntry.targetId).toBe(msgId);
		expect(labelEntry.label).toBe("checkpoint");
	});

	it("clears labels with undefined", () => {
		const session = SessionManager.inMemory();

		const msgId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		session.appendLabelChange(msgId, "checkpoint");
		expect(session.getLabel(msgId)).toBe("checkpoint");

		// Clear the label
		session.appendLabelChange(msgId, undefined);
		expect(session.getLabel(msgId)).toBeUndefined();
	});

	it("last label wins", () => {
		const session = SessionManager.inMemory();

		const msgId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		session.appendLabelChange(msgId, "first");
		session.appendLabelChange(msgId, "second");
		const lastLabelId = session.appendLabelChange(msgId, "third");

		expect(session.getLabel(msgId)).toBe("third");

		const entries = session.getEntries();
		const lastLabelEntry = entries.find((e) => e.id === lastLabelId) as LabelEntry;
		const tree = session.getTree();
		const msgNode = tree.find((n) => n.entry.id === msgId);
		expect(msgNode?.labelTimestamp).toBe(lastLabelEntry.timestamp);
	});

	it("labels are included in tree nodes", () => {
		const session = SessionManager.inMemory();

		const msg1Id = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		const msg2Id = session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});

		const msg1LabelId = session.appendLabelChange(msg1Id, "start");
		const msg2LabelId = session.appendLabelChange(msg2Id, "response");

		const entries = session.getEntries();
		const msg1LabelEntry = entries.find((e) => e.id === msg1LabelId) as LabelEntry;
		const msg2LabelEntry = entries.find((e) => e.id === msg2LabelId) as LabelEntry;
		const tree = session.getTree();

		// Find the message nodes (skip label entries)
		const msg1Node = tree.find((n) => n.entry.id === msg1Id);
		expect(msg1Node?.label).toBe("start");
		expect(msg1Node?.labelTimestamp).toBe(msg1LabelEntry.timestamp);

		// msg2 is a child of msg1
		const msg2Node = msg1Node?.children.find((n) => n.entry.id === msg2Id);
		expect(msg2Node?.label).toBe("response");
		expect(msg2Node?.labelTimestamp).toBe(msg2LabelEntry.timestamp);
	});

	it("labels are preserved in createBranchedSession", () => {
		const session = SessionManager.inMemory();

		const msg1Id = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		const msg2Id = session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});

		const msg1LabelId = session.appendLabelChange(msg1Id, "important");
		const msg2LabelId = session.appendLabelChange(msg2Id, "also-important");
		const originalEntries = session.getEntries();
		const msg1LabelEntry = originalEntries.find((e) => e.id === msg1LabelId) as LabelEntry;
		const msg2LabelEntry = originalEntries.find((e) => e.id === msg2LabelId) as LabelEntry;

		// Branch from msg2 (in-memory mode returns null, but updates internal state)
		session.createBranchedSession(msg2Id);

		// Labels should be preserved
		expect(session.getLabel(msg1Id)).toBe("important");
		expect(session.getLabel(msg2Id)).toBe("also-important");

		// New label entries should exist
		const entries = session.getEntries();
		const labelEntries = entries.filter((e) => e.type === "label") as LabelEntry[];
		expect(labelEntries).toHaveLength(2);

		const tree = session.getTree();
		const msg1Node = tree.find((n) => n.entry.id === msg1Id);
		const msg2Node = msg1Node?.children.find((n) => n.entry.id === msg2Id);
		expect(msg1Node?.labelTimestamp).toBe(msg1LabelEntry.timestamp);
		expect(msg2Node?.labelTimestamp).toBe(msg2LabelEntry.timestamp);
	});

	it("labels not on path are not preserved in createBranchedSession", () => {
		const session = SessionManager.inMemory();

		const msg1Id = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		const msg2Id = session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		const msg3Id = session.appendMessage({ role: "user", content: "followup", timestamp: 3 });

		// Label all messages
		session.appendLabelChange(msg1Id, "first");
		session.appendLabelChange(msg2Id, "second");
		session.appendLabelChange(msg3Id, "third");

		// Branch from msg2 (excludes msg3)
		session.createBranchedSession(msg2Id);

		// Only labels for msg1 and msg2 should be preserved
		expect(session.getLabel(msg1Id)).toBe("first");
		expect(session.getLabel(msg2Id)).toBe("second");
		expect(session.getLabel(msg3Id)).toBeUndefined();
	});

	it("labels are not included in buildSessionContext", () => {
		const session = SessionManager.inMemory();

		const msgId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendLabelChange(msgId, "checkpoint");

		const ctx = session.buildSessionContext();
		expect(ctx.messages).toHaveLength(1);
		expect(ctx.messages[0].role).toBe("user");
	});

	it("throws when labeling non-existent entry", () => {
		const session = SessionManager.inMemory();

		expect(() => session.appendLabelChange("non-existent", "label")).toThrow("Entry non-existent not found");
	});
});

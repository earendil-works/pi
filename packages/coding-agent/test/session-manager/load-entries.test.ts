import { describe, expect, it } from "vitest";
import type { FileEntry, SessionEntry, SessionMessageEntry } from "../../src/core/session-manager.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function userMessage(text: string) {
	return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() };
}

function storedEntries(build: (source: SessionManager) => void): SessionEntry[] {
	const source = SessionManager.inMemory("/project");
	build(source);
	return source.getEntries();
}

describe("SessionManager.inMemory with preloaded entries", () => {
	it("adopts entries verbatim", () => {
		const entries = storedEntries((source) => {
			source.appendMessage(userMessage("hello"));
			source.appendModelChange("anthropic", "claude-opus-4-5");
			source.appendMessage(userMessage("again"));
		});

		const session = SessionManager.inMemory("/project", undefined, entries);

		expect(session.getEntries()).toEqual(entries);
	});

	it("keeps the loaded leaf so appends continue the conversation", () => {
		const entries = storedEntries((source) => {
			source.appendMessage(userMessage("hello"));
			source.appendMessage(userMessage("again"));
		});
		const lastId = entries[entries.length - 1].id;

		const session = SessionManager.inMemory("/project", undefined, entries);
		const appendedId = session.appendMessage(userMessage("continued"));

		expect(session.getLeafId()).toBe(appendedId);
		expect(session.getEntry(appendedId)?.parentId).toBe(lastId);
	});

	it("never mints an id that collides with a loaded entry", () => {
		const entries = storedEntries((source) => {
			for (let i = 0; i < 50; i++) source.appendMessage(userMessage(`message ${i}`));
		});

		const session = SessionManager.inMemory("/project", undefined, entries);
		const appendedId = session.appendMessage(userMessage("continued"));

		expect(entries.some((entry) => entry.id === appendedId)).toBe(false);
	});

	it("rebuilds the branch structure rather than a flat chain", () => {
		const entries = storedEntries((source) => {
			const firstId = source.appendMessage(userMessage("hello"));
			source.appendMessage(userMessage("abandoned"));
			source.branch(firstId);
			source.appendMessage(userMessage("kept"));
		});

		const session = SessionManager.inMemory("/project", undefined, entries);
		const roots = session.getTree();

		expect(roots).toHaveLength(1);
		expect(roots[0].children).toHaveLength(2);
	});

	it("rebuilds labels", () => {
		let labelledId = "";
		const entries = storedEntries((source) => {
			labelledId = source.appendMessage(userMessage("hello"));
			source.appendLabelChange(labelledId, "checkpoint");
		});

		const session = SessionManager.inMemory("/project", undefined, entries);

		expect(session.getLabel(labelledId)).toBe("checkpoint");
	});

	it("resolves a compaction against the entry it was written against", () => {
		let keptId = "";
		const entries = storedEntries((source) => {
			source.appendMessage(userMessage("dropped"));
			keptId = source.appendMessage(userMessage("kept"));
			source.appendCompaction("summary so far", keptId, 1000);
		});

		const session = SessionManager.inMemory("/project", undefined, entries);
		const context = session.buildContextEntries();

		expect(context.some((entry) => entry.id === keptId)).toBe(true);
	});

	it("creates a header from the options when the entries carry none", () => {
		const entries = storedEntries((source) => source.appendMessage(userMessage("hello")));

		const session = SessionManager.inMemory("/project", { id: "restored-session" }, entries);

		expect(session.getSessionId()).toBe("restored-session");
		expect(session.getHeader()!.id).toBe("restored-session");
		expect(session.getHeader()!.cwd).toBe("/project");
	});

	it("generates a session id when the options carry none", () => {
		const entries = storedEntries((source) => source.appendMessage(userMessage("hello")));

		const session = SessionManager.inMemory("/project", undefined, entries);

		expect(session.getSessionId()).toMatch(UUID_V7_RE);
		expect(session.getHeader()!.id).toBe(session.getSessionId());
	});

	it("stays off the filesystem", () => {
		const entries = storedEntries((source) => source.appendMessage(userMessage("hello")));

		const session = SessionManager.inMemory("/project", undefined, entries);
		session.appendMessage(userMessage("continued"));

		expect(session.getSessionFile()).toBeUndefined();
		expect(session.isPersisted()).toBe(false);
	});

	it("starts an empty session when the entries are empty", () => {
		const session = SessionManager.inMemory("/project", { id: "empty-session" }, []);

		expect(session.getSessionId()).toBe("empty-session");
		expect(session.getEntries()).toEqual([]);
		expect(session.getLeafId()).toBeNull();
	});

	it("takes the session identity from a header among the entries", () => {
		const body = storedEntries((source) => source.appendMessage(userMessage("hello")));
		const entries: FileEntry[] = [
			{ type: "session", version: 3, id: "stored-session", timestamp: "2026-01-01T00:00:00Z", cwd: "/stored" },
			...body,
		];

		const session = SessionManager.inMemory("/project", { id: "ignored" }, entries);

		expect(session.getSessionId()).toBe("stored-session");
		expect(session.getHeader()!.cwd).toBe("/stored");
	});

	it("migrates entries restored with an older header", () => {
		const entries: FileEntry[] = [
			{ type: "session", version: 2, id: "v2-session", timestamp: "2026-01-01T00:00:00Z", cwd: "/project" },
			{
				type: "message",
				id: "abc12345",
				parentId: null,
				timestamp: "2026-01-01T00:00:01Z",
				message: { role: "hookMessage", content: "from a hook", timestamp: 1 },
			} as unknown as SessionMessageEntry,
		];

		const session = SessionManager.inMemory("/project", undefined, entries);
		const restored = session.getEntries()[0] as SessionMessageEntry;

		expect(session.getHeader()!.version).toBe(3);
		expect(restored.message.role).toBe("custom");
		expect(restored.id).toBe("abc12345");
	});

	it("adopts headerless entries as current-version without migrating them", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "abc12345",
				parentId: null,
				timestamp: "2026-01-01T00:00:01Z",
				message: { role: "hookMessage", content: "from a hook", timestamp: 1 },
			} as unknown as SessionMessageEntry,
		];

		const session = SessionManager.inMemory("/project", undefined, entries);
		const restored = session.getEntries()[0] as SessionMessageEntry;

		expect(restored.message.role).toBe("hookMessage");
	});
});

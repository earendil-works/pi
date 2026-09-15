import { existsSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type LabelEntry, loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

describe("SessionManager.truncateTo", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `truncate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createSession(): { sm: SessionManager; file: string } {
		const sm = SessionManager.create(tempDir, tempDir);
		return { sm, file: sm.getSessionFile()! };
	}

	it("rewrites the file to header + retained path and moves the leaf", () => {
		const { sm, file } = createSession();
		const u1 = sm.appendMessage(userMsg("one"));
		const a1 = sm.appendMessage(assistantMsg("A1"));
		const u2 = sm.appendMessage(userMsg("two"));
		sm.appendMessage(assistantMsg("A2"));

		sm.truncateTo(a1);

		expect(sm.getLeafId()).toBe(a1);
		const entries = loadEntriesFromFile(file);
		expect(entries.map((e) => e.type)).toEqual(["session", "message", "message"]);
		const ids = entries.map((e) => e.id);
		expect(ids).toContain(u1);
		expect(ids).toContain(a1);
		expect(ids).not.toContain(u2);
	});

	it("removes abandoned branches when truncating below them", () => {
		const { sm, file } = createSession();
		const u1 = sm.appendMessage(userMsg("one"));
		const a1 = sm.appendMessage(assistantMsg("A1"));
		sm.appendMessage(userMsg("two"));
		sm.appendMessage(assistantMsg("A2"));
		// Branch from a1
		sm.branch(a1);
		const u3 = sm.appendMessage(userMsg("branch"));
		sm.appendMessage(assistantMsg("A3"));

		sm.truncateTo(u1);

		expect(sm.getLeafId()).toBe(u1);
		const entries = loadEntriesFromFile(file);
		const ids = entries.map((e) => e.id);
		expect(ids).toContain(u1);
		expect(ids).not.toContain(a1);
		expect(ids).not.toContain(u3);
	});

	it("truncates to root (header only) with null", () => {
		const { sm, file } = createSession();
		sm.appendMessage(userMsg("one"));
		sm.appendMessage(assistantMsg("A1"));

		sm.truncateTo(null);

		expect(sm.getLeafId()).toBeNull();
		const entries = loadEntriesFromFile(file);
		expect(entries.map((e) => e.type)).toEqual(["session"]);
	});

	it("throws for unknown entries and label entries", () => {
		const { sm } = createSession();
		sm.appendMessage(userMsg("one"));
		expect(() => sm.truncateTo("nope")).toThrow("Entry nope not found");

		const u1 = sm.getLeafId()!;
		const labelId = sm.appendLabelChange(u1, "bookmark");
		expect(() => sm.truncateTo(labelId)).toThrow("Cannot truncate to a label entry");
	});

	it("keeps appends working after truncate (children of the target)", () => {
		const { sm, file } = createSession();
		const u1 = sm.appendMessage(userMsg("one"));
		sm.appendMessage(assistantMsg("A1"));
		sm.appendMessage(userMsg("two"));
		sm.appendMessage(assistantMsg("A2"));

		sm.truncateTo(u1);
		const u3 = sm.appendMessage(userMsg("three"));

		expect(sm.getEntry(u3)!.parentId).toBe(u1);
		const entries = loadEntriesFromFile(file);
		// header + u1 + u3
		expect(entries).toHaveLength(3);
		expect(entries.map((e) => e.id)).toEqual([entries[0].id, u1, u3]);
	});

	it("retains labels on surviving entries and drops labels on removed entries", () => {
		const { sm, file } = createSession();
		const u1 = sm.appendMessage(userMsg("one"));
		const a1 = sm.appendMessage(assistantMsg("A1"));
		const u2 = sm.appendMessage(userMsg("two"));
		sm.appendMessage(assistantMsg("A2"));
		sm.appendLabelChange(u1, "keep");
		sm.appendLabelChange(u2, "drop");

		sm.truncateTo(a1);

		expect(sm.getLabel(u1)).toBe("keep");
		expect(sm.getLabel(u2)).toBeUndefined();
		const entries = loadEntriesFromFile(file);
		const labels = entries.filter((e) => e.type === "label") as LabelEntry[];
		expect(labels).toHaveLength(1);
		expect(labels[0].targetId).toBe(u1);
		expect(labels[0].label).toBe("keep");
	});

	it("does not create the file for a session that has not been flushed yet", () => {
		const { sm, file } = createSession();
		sm.appendMessage(userMsg("one"));
		sm.appendMessage(userMsg("two")); // no assistant -> file not created

		expect(existsSync(file)).toBe(false);
		sm.truncateTo(sm.getLeafId());
		expect(existsSync(file)).toBe(false);
		expect(sm.getEntries()).toHaveLength(2);

		// First assistant response still creates the file with the full retained state
		sm.appendMessage(assistantMsg("A1"));
		expect(existsSync(file)).toBe(true);
		expect(loadEntriesFromFile(file)).toHaveLength(4); // header + u1 + u2 + a1
	});

	it("supports in-memory sessions (no file)", () => {
		const sm = SessionManager.inMemory(tempDir);
		const u1 = sm.appendMessage(userMsg("one"));
		sm.appendMessage(assistantMsg("A1"));
		sm.appendMessage(userMsg("two"));
		sm.appendMessage(assistantMsg("A2"));

		sm.truncateTo(u1);

		expect(sm.getLeafId()).toBe(u1);
		expect(sm.getEntries().map((e) => e.id)).toEqual([u1]);
	});
});

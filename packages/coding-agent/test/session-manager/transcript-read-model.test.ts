import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
	MAX_SESSION_TRANSCRIPT_PAGE_SIZE,
	SessionManager,
	type SessionTranscriptChange,
} from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SessionManager transcript read model", () => {
	it("pages the active branch with opaque before and after cursors", () => {
		const session = SessionManager.inMemory();
		const ids = [
			session.appendMessage(userMsg("one")),
			session.appendMessage(assistantMsg("two")),
			session.appendMessage(userMsg("three")),
			session.appendMessage(assistantMsg("four")),
			session.appendMessage(userMsg("five")),
		];

		const latest = session.readTranscriptPage({ limit: 2 });
		expect(latest.items.map((item) => item.id)).toEqual(ids.slice(3));
		expect(latest.hasMoreBefore).toBe(true);
		expect(latest.hasMoreAfter).toBe(false);
		expect(latest.cursors.before).not.toContain(ids[3]);

		const older = session.readTranscriptPage({ limit: 2, before: latest.cursors.before! });
		expect(older.items.map((item) => item.id)).toEqual(ids.slice(1, 3));
		expect(older.hasMoreBefore).toBe(true);

		const beforeAppend = latest.cursors.after!;
		const appendedId = session.appendMessage(assistantMsg("six"));
		const appended = session.readTranscriptPage({ limit: 2, after: beforeAppend });
		expect(appended.items.map((item) => item.id)).toEqual([appendedId]);
		expect(appended.cursors.after).not.toBe(beforeAppend);
	});

	it("projects compaction entries through the canonical context projection", () => {
		const session = SessionManager.inMemory();
		const firstId = session.appendMessage(userMsg("one"));
		session.appendMessage(assistantMsg("two"));
		const compactionId = session.appendCompaction("summary", firstId, 123);
		const finalId = session.appendMessage(userMsg("three"));

		const page = session.readTranscriptPage({ limit: 10 });
		expect(page.items.map((item) => item.id)).toEqual([firstId, session.getBranch()[1]!.id, compactionId, finalId]);
		expect(page.items[2]?.message).toMatchObject({ role: "compactionSummary", summary: "summary" });
		expect(page.itemsAfterLatestCompaction).toBe(1);
	});

	it("emits appends after the SessionManager commit point and resets at branch changes", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-transcript-"));
		tempDirs.push(dir);
		const session = SessionManager.create(dir, dir);
		const changes: SessionTranscriptChange[] = [];
		session.subscribeTranscript(
			(change) => {
				if (change.type === "append" && change.items[0]?.message.role === "assistant") {
					const file = session.getSessionFile();
					expect(file && existsSync(file)).toBe(true);
					expect(readFileSync(file!, "utf8")).toContain(change.items[0]!.id);
				}
				changes.push(change);
			},
			{ resetPageSize: 10 },
		);

		const firstId = session.appendMessage(userMsg("one"));
		session.appendMessage(assistantMsg("two"));
		session.appendMessage(userMsg("three"));
		session.branch(firstId);
		const branchId = session.appendMessage(userMsg("branch"));

		expect(changes.map((change) => change.type)).toEqual(["append", "append", "append", "reset", "append"]);
		const reset = changes[3];
		expect(reset?.type === "reset" ? reset.page.items.map((item) => item.id) : []).toEqual([firstId]);
		const append = changes[4];
		expect(append?.type === "append" ? append.items[0]?.id : null).toBe(branchId);
	});

	it("rejects unbounded, ambiguous, foreign, and stale cursor reads", () => {
		const session = SessionManager.inMemory();
		const firstId = session.appendMessage(userMsg("one"));
		session.appendMessage(assistantMsg("two"));
		const cursor = session.readTranscriptPage({ limit: 1 }).cursors.after!;
		const foreign = SessionManager.inMemory();
		foreign.appendMessage(userMsg("foreign"));

		expect(() => session.readTranscriptPage({ limit: MAX_SESSION_TRANSCRIPT_PAGE_SIZE + 1 })).toThrow("limit");
		expect(() => session.readTranscriptPage({ limit: 1, before: cursor, after: cursor })).toThrow(
			"either before or after",
		);
		expect(() => foreign.readTranscriptPage({ limit: 1, after: cursor })).toThrow("different session");

		session.branch(firstId);
		expect(() => session.readTranscriptPage({ limit: 1, after: cursor })).toThrow("not on the active branch");
	});
});

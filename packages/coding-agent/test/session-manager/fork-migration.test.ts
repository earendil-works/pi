import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

describe("SessionManager.forkFrom legacy sessions", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-fork-migration-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it.each([undefined, 1])("preserves v1 history and tree links with version %s", (version) => {
		const sourcePath = join(tempDir, "source.jsonl");
		const timestamp = "2025-01-01T00:00:00.000Z";
		const first = { role: "user", content: "first", timestamp: 1 };
		const second = { role: "user", content: "second", timestamp: 2 };
		const sourceContent = `${[
			{ type: "session", version, id: "legacy", timestamp, cwd: tempDir },
			{ type: "message", timestamp, message: first },
			{ type: "message", timestamp, message: second },
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`;
		writeFileSync(sourcePath, sourceContent);

		const fork = SessionManager.forkFrom(sourcePath, tempDir, tempDir);
		expect(fork.buildSessionContext().messages).toEqual([first, second]);
		const entries = fork.getEntries();
		expect(entries[0].id).toEqual(expect.any(String));
		expect(entries[0].parentId).toBeNull();
		expect(entries[1].parentId).toBe(entries[0].id);
		expect(fork.getHeader()).toMatchObject({ version: 3, parentSession: sourcePath });
		expect(readFileSync(sourcePath, "utf8")).toBe(sourceContent);
		expect(SessionManager.open(fork.getSessionFile()!, tempDir).buildSessionContext().messages).toEqual([
			first,
			second,
		]);
	});

	it("migrates v2 hook messages without changing existing entry IDs or the source", () => {
		const sourcePath = join(tempDir, "source.jsonl");
		const timestamp = "2025-01-01T00:00:00.000Z";
		const legacyMessage = {
			role: "hookMessage",
			customType: "note",
			content: "saved context",
			display: false,
			timestamp: 1,
		};
		const sourceContent = `${[
			{ type: "session", version: 2, id: "legacy", timestamp, cwd: tempDir },
			{ type: "message", id: "entry-1", parentId: null, timestamp, message: legacyMessage },
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`;
		writeFileSync(sourcePath, sourceContent);

		const fork = SessionManager.forkFrom(sourcePath, tempDir, tempDir);
		const expected = [{ ...legacyMessage, role: "custom" }];
		expect(fork.buildSessionContext().messages).toEqual(expected);
		expect(fork.getEntries()[0]).toMatchObject({ id: "entry-1", parentId: null });
		expect(readFileSync(sourcePath, "utf8")).toBe(sourceContent);
		expect(SessionManager.open(fork.getSessionFile()!, tempDir).buildSessionContext().messages).toEqual(expected);
	});
});

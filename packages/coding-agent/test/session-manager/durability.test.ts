const fsMocks = vi.hoisted(() => ({
	appendFileSync: vi.fn(),
	actual: undefined as typeof import("fs") | undefined,
	renameSync: vi.fn(),
}));

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs");
	fsMocks.actual = actual;
	fsMocks.appendFileSync.mockImplementation(actual.appendFileSync);
	fsMocks.renameSync.mockImplementation(actual.renameSync);
	return { ...actual, appendFileSync: fsMocks.appendFileSync, renameSync: fsMocks.renameSync };
});

import * as fs from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

function userMessage(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

function assistantMessage(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

describe("SessionManager persistence durability", () => {
	let tempDir: string;

	afterEach(() => {
		fsMocks.appendFileSync.mockImplementation(fsMocks.actual!.appendFileSync);
		fsMocks.renameSync.mockImplementation(fsMocks.actual!.renameSync);
		if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("rolls back the graph and partial append when persistence fails", () => {
		tempDir = fs.mkdtempSync(join(tmpdir(), "session-durability-"));
		const session = SessionManager.create(tempDir, tempDir, { id: "durability-test" });
		session.appendMessage(userMessage("hello"));
		const assistantId = session.appendMessage(assistantMessage("hi"));
		const sessionFile = session.getSessionFile()!;
		const originalContent = fs.readFileSync(sessionFile, "utf8");

		fsMocks.appendFileSync.mockImplementation(((path) => {
			fs.writeFileSync(path, "partial", { flag: "a" });
			throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
		}) as typeof fs.appendFileSync);

		expect(() => session.appendMessage(userMessage("this write fails"))).toThrow("no space left on device");
		expect(session.getLeafId()).toBe(assistantId);
		expect(session.getEntries()).toHaveLength(2);
		expect(fs.readFileSync(sessionFile, "utf8")).toBe(originalContent);
		expect(SessionManager.open(sessionFile, tempDir).getEntries()).toHaveLength(2);
	});

	it("does not leave a partial fork when publishing fails", () => {
		tempDir = fs.mkdtempSync(join(tmpdir(), "session-fork-durability-"));
		const sourceDir = join(tempDir, "source");
		const targetDir = join(tempDir, "target");
		const source = SessionManager.create(sourceDir, sourceDir, { id: "source-session" });
		source.appendMessage(userMessage("hello"));
		source.appendMessage(assistantMessage("hi"));

		fsMocks.renameSync.mockImplementation(() => {
			throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
		});

		expect(() =>
			SessionManager.forkFrom(
				source.getSessionFile()!,
				join(tempDir, "target-cwd"),
				targetDir,
				{ id: "fork-session" },
			),
		).toThrow("no space left on device");
		expect(fs.readdirSync(targetDir)).toEqual([]);
	});
});

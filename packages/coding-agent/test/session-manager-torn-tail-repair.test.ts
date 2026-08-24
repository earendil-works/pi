/**
 * Tests for the torn-tail repair on session-file write failure (#279313):
 * when an append fails partway (e.g. ENOSPC persists a prefix of the buffer
 * and then throws), the file tail must be repaired to a line boundary so the
 * NEXT successful append cannot concatenate onto the torn fragment — a
 * concatenation the loader would silently swallow as one malformed line,
 * costing TWO replay entries.
 */

import * as realFs from "node:fs";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock "fs" so appendFileSync on the victim file persists only the FIRST HALF
// of the payload and then throws ENOSPC — exactly the observed artifact shape.
// The repair's own appendFileSync(file, "\n") is short and passes through.
vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const victimTag = "victim-jsonl";
	return {
		...actual,
		appendFileSync: ((file: realFs.PathOrFileDescriptor, data: string, ...rest: unknown[]) => {
			const path = typeof file === "string" ? file : "";
			if (path.includes(victimTag) && typeof data === "string" && data.length > 64) {
				actual.appendFileSync(file, data.slice(0, Math.floor(data.length / 2)));
				const err = new Error("ENOSPC: no space left on device, write") as NodeJS.ErrnoException;
				err.code = "ENOSPC";
				throw err;
			}
			return (actual.appendFileSync as (...args: unknown[]) => void)(file, data, ...rest);
		}) as typeof actual.appendFileSync,
	};
});

import { SessionManager } from "../src/core/session-manager.ts";

const header = {
	type: "session",
	version: 3,
	id: "00000000-0000-0000-0000-000000000000",
	timestamp: "2026-01-01T00:00:00.000Z",
	cwd: "/tmp",
};

function entryLine(id: string, role: string): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: `2026-01-01T00:00:0${id.charCodeAt(0) % 10}.000Z`,
		message: { role, content: [{ type: "text", text: `hello ${id} ${"x".repeat(200)}` }] },
	});
}

describe("session-file torn-tail repair on write failure", () => {
	let dir: string;

	beforeEach(() => {
		dir = join(tmpdir(), `pi-jsonl-repair-${process.pid}-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("repairs the torn tail so the next append starts on a fresh line (error still propagates)", () => {
		const file = join(dir, "victim-jsonl.jsonl");
		// Seed a flushed session (header + assistant message => hasAssistant, flushed)
		writeFileSync(file, `${JSON.stringify(header)}\n${entryLine("a", "assistant")}\n`);
		const mgr = SessionManager.open(file);

		// The next append hits the mocked ENOSPC partial: half the entry lands, then throw.
		expect(() => mgr.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }] })).toThrow(/ENOSPC/);

		// The file tail must now end at a line boundary (the repair appended \n).
		const raw = realFs.readFileSync(file, "utf8");
		expect(raw.endsWith("\n")).toBe(true);

		// The torn fragment exists as its own (malformed) line, NOT concatenated
		// with a later complete entry.
		const lines = raw.split("\n").filter((l) => l.length > 0);
		expect(lines).toHaveLength(3); // header + seeded assistant entry + torn fragment
	});
});

/**
 * Tests for the #279313 torn-append artifact class in session loading:
 * a malformed line that carries BOTH a torn entry prefix AND a complete
 * following entry on one physical line is silently skipped by
 * parseSessionEntryLine — costing TWO replay entries with no signal.
 *
 * These tests verify:
 * - loadEntriesFromFile counts skipped malformed lines and surfaces a
 *   single visible WARNING per load (never silent).
 * - A clean file produces no warning.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadEntriesFromFile } from "../src/core/session-manager.ts";

const header = {
	type: "session",
	version: 3,
	id: "00000000-0000-0000-0000-000000000000",
	timestamp: "2026-01-01T00:00:00.000Z",
	cwd: "/tmp",
};

function entry(id: string, role: string): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: `2026-01-01T00:00:0${id.charCodeAt(0) % 10}.000Z`,
		message: { role, content: [{ type: "text", text: `hello ${id}` }] },
	});
}

describe("loadEntriesFromFile malformed-line warning", () => {
	let dir: string;

	beforeEach(() => {
		dir = join(tmpdir(), `pi-jsonl-warn-${process.pid}-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("counts a torn-append line as skipped and warns once (the swallowed complete entry is visible as a loss)", () => {
		const file = join(dir, "session.jsonl");
		// torn entry `a` (prefix only) + COMPLETE entry `b` concatenated on the same physical line
		const torn = `${entry("a", "assistant").slice(0, 40)}${entry("b", "user")}`;
		writeFileSync(file, `${JSON.stringify(header)}\n${torn}\n${entry("c", "user")}\n`);

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const entries = loadEntriesFromFile(file);
			// header + c only: `a` was already torn, and `b` is swallowed with the malformed line
			expect(entries.map((e) => (e as { id?: string }).id)).toEqual(["00000000-0000-0000-0000-000000000000", "c"]);
			expect(errorSpy).toHaveBeenCalledTimes(1);
			expect(String(errorSpy.mock.calls[0][0])).toContain("skipped 1 malformed session line");
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("counts a torn final fragment (no trailing newline) as skipped", () => {
		const file = join(dir, "session.jsonl");
		const torn = entry("a", "assistant").slice(0, 40); // no trailing \n at EOF
		writeFileSync(file, `${JSON.stringify(header)}\n${torn}`);

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const entries = loadEntriesFromFile(file);
			expect(entries).toHaveLength(1); // header only
			expect(errorSpy).toHaveBeenCalledTimes(1);
			expect(String(errorSpy.mock.calls[0][0])).toContain("skipped 1 malformed session line");
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("does not warn for a clean file (blank lines included)", () => {
		const file = join(dir, "session.jsonl");
		writeFileSync(file, `${JSON.stringify(header)}\n\n${entry("a", "user")}\n\n`);

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const entries = loadEntriesFromFile(file);
			expect(entries).toHaveLength(2);
			expect(errorSpy).not.toHaveBeenCalled();
		} finally {
			errorSpy.mockRestore();
		}
	});
});

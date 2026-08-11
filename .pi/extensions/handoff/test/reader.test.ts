import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveDir, HANDOFF_SCHEMA, type HandoffNote, handoffsDir, readNote, writeNote } from "../notes.ts";
import { archiveDelivered, buildMemo, scanPendingNotes } from "../reader.ts";

function note(overrides: Partial<HandoffNote["frontmatter"]> = {}): HandoffNote {
	return {
		frontmatter: {
			schema: HANDOFF_SCHEMA,
			session_id: "019feda9-55bc-797d",
			session_file: "/sessions/019feda9.jsonl",
			cwd: "/Users/kyle/Projects/foo",
			created: "2026-08-10T22:15:00.000Z",
			source: "digest",
			model: "google/gemini-3.6-flash",
			kickoff: "Continue: wire the reader",
			...overrides,
		},
		body: "## Context\nWe wired notes.ts.\n\n## Next steps\nWire the reader.\n",
	};
}

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-handoff-reader-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("scanPendingNotes", () => {
	it("returns nothing when there are no notes", () => {
		expect(scanPendingNotes(dir)).toEqual({ older: [], corrupt: [] });
	});

	it("ingests the newest note and lists the rest as older, oldest first", () => {
		writeNote(dir, note({ created: "2026-08-08T10:00:00.000Z", session_id: "aaaaaaaa" }));
		writeNote(dir, note({ created: "2026-08-10T22:15:00.000Z", session_id: "cccccccc" }));
		writeNote(dir, note({ created: "2026-08-09T10:00:00.000Z", session_id: "bbbbbbbb" }));

		const scan = scanPendingNotes(dir);
		expect(scan.ingest?.note.frontmatter.session_id).toBe("cccccccc");
		expect(scan.older.map((p) => basename(p))).toEqual([
			"2026-08-08T10-00-00-000Z_aaaaaaaa.md",
			"2026-08-09T10-00-00-000Z_bbbbbbbb.md",
		]);
		expect(scan.corrupt).toEqual([]);
	});

	it("reports an unparseable note as corrupt instead of ingesting it", () => {
		mkdirSync(handoffsDir(dir), { recursive: true });
		writeFileSync(join(handoffsDir(dir), "2026-08-11T00-00-00-000Z_zzzzzzzz.md"), "not a note");
		writeNote(dir, note({ created: "2026-08-10T22:15:00.000Z", session_id: "cccccccc" }));

		const scan = scanPendingNotes(dir);
		expect(scan.ingest?.note.frontmatter.session_id).toBe("cccccccc");
		expect(scan.corrupt.map((p) => basename(p))).toEqual(["2026-08-11T00-00-00-000Z_zzzzzzzz.md"]);
		expect(scan.older).toEqual([]);
	});

	it("ignores already-archived notes", () => {
		writeNote(dir, note());
		archiveDelivered(dir, scanPendingNotes(dir), "consumer", "2026-08-11T09:00:00.000Z");
		expect(scanPendingNotes(dir)).toEqual({ older: [], corrupt: [] });
	});
});

describe("buildMemo", () => {
	it("leads with a banner naming the source session and how the note was made", () => {
		const memo = buildMemo(note());
		expect(memo.split("\n")[0]).toBe(
			"Handoff from session 019feda9, ended 2026-08-10T22:15:00.000Z (shutdown digest).",
		);
	});

	it("labels a /handoff-composed note differently", () => {
		expect(buildMemo(note({ source: "command" })).split("\n")[0]).toContain("(composed via /handoff)");
	});

	it("carries the note body and a transcript pointer", () => {
		const memo = buildMemo(note());
		expect(memo).toContain("## Next steps\nWire the reader.");
		expect(memo).toContain("Full transcript of that session: /sessions/019feda9.jsonl");
	});

	it("omits the transcript pointer when the note has no session file", () => {
		const withoutFile = note();
		delete withoutFile.frontmatter.session_file;
		expect(buildMemo(withoutFile)).not.toContain("Full transcript");
	});

	it("says nothing about older notes when there are none", () => {
		expect(buildMemo(note())).not.toContain("older pending");
	});

	it("mentions older superseded notes, in the right number", () => {
		expect(buildMemo(note(), 1)).toContain("1 older pending handoff note was superseded by this one");
		expect(buildMemo(note(), 3)).toContain("3 older pending handoff notes were superseded by this one");
	});
});

describe("archiveDelivered", () => {
	it("stamps the ingested note consumed and the older ones superseded", () => {
		writeNote(dir, note({ created: "2026-08-09T10:00:00.000Z", session_id: "aaaaaaaa" }));
		writeNote(dir, note({ created: "2026-08-10T22:15:00.000Z", session_id: "cccccccc" }));

		const scan = scanPendingNotes(dir);
		archiveDelivered(dir, scan, "successor-session", "2026-08-11T09:00:00.000Z");

		const ingested = readNote(join(archiveDir(dir), "2026-08-10T22-15-00-000Z_cccccccc.md"));
		expect(ingested?.frontmatter.consumed_by).toBe("successor-session");
		expect(ingested?.frontmatter.consumed_at).toBe("2026-08-11T09:00:00.000Z");
		expect(ingested?.frontmatter.superseded_by).toBeUndefined();

		const older = readNote(join(archiveDir(dir), "2026-08-09T10-00-00-000Z_aaaaaaaa.md"));
		expect(older?.frontmatter.superseded_by).toBe("2026-08-10T22-15-00-000Z_cccccccc.md");
		expect(older?.frontmatter.consumed_by).toBeUndefined();
	});

	it("leaves corrupt notes pending", () => {
		mkdirSync(handoffsDir(dir), { recursive: true });
		const corrupt = join(handoffsDir(dir), "2026-08-11T00-00-00-000Z_zzzzzzzz.md");
		writeFileSync(corrupt, "not a note");
		writeNote(dir, note());

		archiveDelivered(dir, scanPendingNotes(dir), "successor-session", "2026-08-11T09:00:00.000Z");
		expect(existsSync(corrupt)).toBe(true);
	});

	it("does nothing when there was no note to ingest", () => {
		archiveDelivered(dir, { older: [], corrupt: [] }, "successor-session", "2026-08-11T09:00:00.000Z");
		expect(existsSync(archiveDir(dir))).toBe(false);
	});

	it("archives only the snapshot, leaving a note written after detection pending", () => {
		writeNote(dir, note({ created: "2026-08-10T22:15:00.000Z", session_id: "cccccccc" }));
		const scan = scanPendingNotes(dir);
		writeNote(dir, note({ created: "2026-08-11T08:00:00.000Z", session_id: "dddddddd" }));

		archiveDelivered(dir, scan, "successor-session", "2026-08-11T09:00:00.000Z");

		const stillPending = scanPendingNotes(dir);
		expect(stillPending.ingest?.note.frontmatter.session_id).toBe("dddddddd");
		expect(stillPending.older).toEqual([]);
	});
});

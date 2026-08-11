import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	buildDigestNote,
	collectFilesTouched,
	firstLines,
	hasAssistantMessage,
	lastAssistantText,
	lastUserText,
	truncateChars,
} from "../digest.ts";
import { HANDOFF_SCHEMA } from "../notes.ts";

let nextId = 0;

function entry(message: unknown): SessionEntry {
	nextId += 1;
	return {
		type: "message",
		id: `e${nextId}`,
		parentId: null,
		timestamp: "2026-08-10T22:00:00.000Z",
		message,
	} as SessionEntry;
}

function user(text: string): SessionEntry {
	return entry({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
}

function assistant(content: unknown[]): SessionEntry {
	return entry({ role: "assistant", content, timestamp: 0 });
}

function toolCall(name: string, args: Record<string, unknown>): unknown {
	return { type: "toolCall", id: "tc", name, arguments: args };
}

const DIGEST_BASE = {
	sessionId: "019feda9-55bc-797d",
	sessionFile: "/sessions/019feda9.jsonl",
	cwd: "/Users/kyle/Projects/foo",
	model: "google/gemini-3.6-flash",
	created: "2026-08-10T22:15:00.000Z",
};

describe("message extraction", () => {
	it("reports whether an assistant message exists", () => {
		expect(hasAssistantMessage([user("hi")])).toBe(false);
		expect(hasAssistantMessage([user("hi"), assistant([{ type: "text", text: "yo" }])])).toBe(true);
	});

	it("takes the last user and last assistant message", () => {
		const entries = [
			user("first"),
			assistant([{ type: "text", text: "reply one" }]),
			user("second"),
			assistant([{ type: "text", text: "reply two" }]),
		];
		expect(lastUserText(entries)).toBe("second");
		expect(lastAssistantText(entries)).toBe("reply two");
	});

	it("handles string content and drops thinking blocks", () => {
		const entries = [
			entry({ role: "user", content: "plain string", timestamp: 0 }),
			assistant([
				{ type: "thinking", thinking: "hmm" },
				{ type: "text", text: "visible" },
			]),
		];
		expect(lastUserText(entries)).toBe("plain string");
		expect(lastAssistantText(entries)).toBe("visible");
	});

	it("ignores custom_message entries when picking the last user message", () => {
		const entries: SessionEntry[] = [
			user("real prompt"),
			{
				type: "custom_message",
				id: "cm1",
				parentId: null,
				timestamp: "2026-08-10T22:01:00.000Z",
				customType: "handoff",
				content: "briefing from a previous session",
				display: true,
			},
			assistant([{ type: "text", text: "ok" }]),
		];
		expect(lastUserText(entries)).toBe("real prompt");
	});

	it("returns empty strings when nothing matches", () => {
		expect(lastUserText([])).toBe("");
		expect(lastAssistantText([])).toBe("");
	});
});

describe("firstLines", () => {
	it("returns short text untouched", () => {
		expect(firstLines("one\ntwo", 15)).toBe("one\ntwo");
	});

	it("truncates and marks the cut", () => {
		expect(firstLines("a\nb\nc\nd", 2)).toBe("a\nb\n...");
	});
});

describe("truncateChars", () => {
	it("returns short text untouched", () => {
		expect(truncateChars("hello", 10)).toBe("hello");
	});

	it("cuts at the limit and marks the cut", () => {
		expect(truncateChars("abcdefghij", 4)).toBe("abcd...");
	});
});

describe("excerpt bounds in the note body", () => {
	// The whole body is re-injected into the successor's context as a user message, so an
	// unbounded paste at the end of one session would prefix the next session's first turn.
	it("caps a user message that is long in lines", () => {
		const paste = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
		const body = buildDigestNote({
			...DIGEST_BASE,
			entries: [user(paste), assistant([{ type: "text", text: "ok" }])],
		})?.body as string;

		expect(body).toContain("line 0");
		expect(body).not.toContain("line 300");
		expect(body).toContain("...");
	});

	it("caps a user message that is one enormous line", () => {
		const paste = "x".repeat(50_000);
		const body = buildDigestNote({
			...DIGEST_BASE,
			entries: [user(paste), assistant([{ type: "text", text: "ok" }])],
		})?.body as string;

		expect(body.length).toBeLessThan(4000);
	});

	it("caps an assistant reply that is one enormous line", () => {
		const flood = "y".repeat(50_000);
		const body = buildDigestNote({
			...DIGEST_BASE,
			entries: [user("hi"), assistant([{ type: "text", text: flood }])],
		})?.body as string;

		expect(body.length).toBeLessThan(4000);
	});

	it("caps the kickoff, which is a frontmatter scalar", () => {
		const paste = `${"z".repeat(50_000)}\nsecond line`;
		const note = buildDigestNote({
			...DIGEST_BASE,
			entries: [user(paste), assistant([{ type: "text", text: "ok" }])],
		});

		expect(note?.frontmatter.kickoff.length).toBeLessThan(300);
		expect(note?.frontmatter.kickoff.startsWith("Continue: zzz")).toBe(true);
	});
});

describe("collectFilesTouched", () => {
	it("splits reads from modifications and dedupes", () => {
		const entries = [
			assistant([toolCall("read", { path: "a.ts" }), toolCall("read", { path: "b.ts" })]),
			assistant([toolCall("read", { path: "a.ts" }), toolCall("edit", { path: "c.ts" })]),
			assistant([toolCall("write", { path: "c.ts" })]),
		];
		expect(collectFilesTouched(entries)).toEqual({ read: ["a.ts", "b.ts"], modified: ["c.ts"] });
	});

	it("reports a file that was read and then written as modified only", () => {
		const entries = [assistant([toolCall("read", { path: "a.ts" }), toolCall("write", { path: "a.ts" })])];
		expect(collectFilesTouched(entries)).toEqual({ read: [], modified: ["a.ts"] });
	});

	it("accepts the file_path provider-compat alias", () => {
		const entries = [assistant([toolCall("read", { file_path: "a.ts" })])];
		expect(collectFilesTouched(entries)).toEqual({ read: ["a.ts"], modified: [] });
	});

	it("ignores tools without a path and non-file tools", () => {
		const entries = [assistant([toolCall("bash", { command: "ls" }), toolCall("read", {})])];
		expect(collectFilesTouched(entries)).toEqual({ read: [], modified: [] });
	});
});

describe("buildDigestNote", () => {
	it("returns undefined when the session produced no assistant message", () => {
		expect(buildDigestNote({ ...DIGEST_BASE, entries: [user("hi")] })).toBeUndefined();
	});

	it("builds frontmatter with a mechanical kickoff", () => {
		const entries = [user("Wire up the reader\nand test it"), assistant([{ type: "text", text: "Done." }])];
		const note = buildDigestNote({ ...DIGEST_BASE, entries });

		expect(note?.frontmatter).toEqual({
			schema: HANDOFF_SCHEMA,
			session_id: DIGEST_BASE.sessionId,
			session_file: DIGEST_BASE.sessionFile,
			cwd: DIGEST_BASE.cwd,
			created: DIGEST_BASE.created,
			source: "digest",
			model: DIGEST_BASE.model,
			kickoff: "Continue: Wire up the reader",
		});
	});

	it("carries the last exchange and files touched into the body", () => {
		const entries = [
			user("Refactor notes.ts"),
			assistant([toolCall("read", { path: "notes.ts" }), toolCall("edit", { path: "notes.ts" })]),
			assistant([{ type: "text", text: "Refactored the parser." }]),
		];
		const body = buildDigestNote({ ...DIGEST_BASE, entries })?.body ?? "";

		expect(body).toContain("- modified: notes.ts");
		expect(body).not.toContain("- read:");
		expect(body).toContain("**User:** Refactor notes.ts");
		expect(body).toContain("**Assistant:** Refactored the parser.");
		expect(body).toContain("Pick up from the last request: Refactor notes.ts");
	});

	it("reports no files when none were touched", () => {
		const entries = [user("Explain the design"), assistant([{ type: "text", text: "It is a dead drop." }])];
		expect(buildDigestNote({ ...DIGEST_BASE, entries })?.body).toContain("- none recorded");
	});

	it("falls back to a generic kickoff when no user message was recorded", () => {
		const entries = [assistant([{ type: "text", text: "Auto-started." }])];
		expect(buildDigestNote({ ...DIGEST_BASE, entries })?.frontmatter.kickoff).toBe(
			"Continue the previous session's work.",
		);
	});

	it("omits the model field when no model is set", () => {
		const entries = [user("hi"), assistant([{ type: "text", text: "hello" }])];
		const note = buildDigestNote({ ...DIGEST_BASE, model: undefined, entries });
		expect(note?.frontmatter.model).toBeUndefined();
	});
});

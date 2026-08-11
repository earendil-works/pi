import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	answerAsPredecessor,
	buildGhostUserMessage,
	findPredecessor,
	GHOST_SYSTEM_PROMPT,
	renderTranscript,
	truncateTranscript,
} from "../ghost.ts";
import { archiveNote, HANDOFF_SCHEMA, type HandoffNote, writeNote } from "../notes.ts";

const ASKER = "0aaaaaaa-0000-7000-8000-000000000001";
const OTHER = "0bbbbbbb-0000-7000-8000-000000000002";

function note(created: string, sessionId: string, overrides: Partial<HandoffNote["frontmatter"]> = {}): HandoffNote {
	return {
		frontmatter: {
			schema: HANDOFF_SCHEMA,
			session_id: sessionId,
			session_file: `/sessions/${sessionId.slice(0, 8)}.jsonl`,
			cwd: "/repo",
			created,
			source: "digest",
			kickoff: "Continue.",
			...overrides,
		},
		body: "## Context\nStuff.\n",
	};
}

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-ghost-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("findPredecessor", () => {
	it("prefers the note this session consumed over anything newer", () => {
		const consumedPath = writeNote(dir, note("2026-08-11T09:00:00.000Z", "11111111-aaaa-7bbb-8ccc-000000000001"));
		archiveNote(dir, consumedPath, { consumed_by: ASKER });
		writeNote(dir, note("2026-08-11T10:00:00.000Z", "22222222-aaaa-7bbb-8ccc-000000000002"));

		const found = findPredecessor(dir, ASKER);
		expect(found?.note.frontmatter.session_id).toBe("11111111-aaaa-7bbb-8ccc-000000000001");
	});

	it("falls back to the newest pending note, then the newest archived note", () => {
		const archivedPath = writeNote(dir, note("2026-08-11T08:00:00.000Z", "33333333-aaaa-7bbb-8ccc-000000000003"));
		archiveNote(dir, archivedPath, { consumed_by: OTHER });

		// No pending notes: newest archive wins even though someone else consumed it.
		expect(findPredecessor(dir, ASKER)?.note.frontmatter.session_id).toBe("33333333-aaaa-7bbb-8ccc-000000000003");

		writeNote(dir, note("2026-08-11T09:00:00.000Z", "44444444-aaaa-7bbb-8ccc-000000000004"));
		writeNote(dir, note("2026-08-11T10:00:00.000Z", "55555555-aaaa-7bbb-8ccc-000000000005"));
		expect(findPredecessor(dir, ASKER)?.note.frontmatter.session_id).toBe("55555555-aaaa-7bbb-8ccc-000000000005");
	});

	it("skips notes without a transcript and returns undefined when none qualifies", () => {
		const bare = note("2026-08-11T10:00:00.000Z", "66666666-aaaa-7bbb-8ccc-000000000006");
		delete bare.frontmatter.session_file;
		writeNote(dir, bare);
		expect(findPredecessor(dir, ASKER)).toBeUndefined();
	});
});

function jsonl(entries: unknown[]): string {
	return entries.map((entry) => JSON.stringify(entry)).join("\n");
}

describe("renderTranscript", () => {
	it("renders user and assistant text with tool-call markers, skipping other roles", () => {
		const text = renderTranscript(
			jsonl([
				{ type: "session", id: "s", version: 3 },
				{ type: "message", id: "1", parentId: null, message: { role: "user", content: "fix the bug" } },
				{
					type: "message",
					id: "2",
					parentId: "1",
					message: {
						role: "assistant",
						content: [
							{ type: "text", text: "Looking now." },
							{ type: "toolCall", name: "read", arguments: { path: "src/a.ts" } },
						],
					},
				},
				{ type: "message", id: "3", parentId: "2", message: { role: "toolResult", content: "file contents" } },
				{ type: "message", id: "4", parentId: "3", message: { role: "custom", content: "injected memo" } },
				{ type: "message", id: "5", parentId: "4", message: { role: "assistant", content: "Fixed it." } },
			]),
		);
		expect(text).toBe(
			["User: fix the bug", "Assistant: Looking now.\n[ran read on src/a.ts]", "Assistant: Fixed it."].join("\n\n"),
		);
	});

	it("follows only the active branch after a rewind", () => {
		const text = renderTranscript(
			jsonl([
				{ type: "session", id: "s", version: 3 },
				{ type: "message", id: "1", parentId: null, message: { role: "user", content: "start" } },
				{ type: "message", id: "2", parentId: "1", message: { role: "assistant", content: "abandoned path" } },
				// Rewound: the next entry re-parents onto "1", orphaning "2".
				{ type: "message", id: "3", parentId: "1", message: { role: "assistant", content: "kept path" } },
			]),
		);
		expect(text).toContain("kept path");
		expect(text).not.toContain("abandoned path");
	});

	it("skips malformed lines and returns empty for a message-free file", () => {
		expect(renderTranscript("not json\n{}")).toBe("");
		expect(renderTranscript(jsonl([{ type: "session", id: "s" }]))).toBe("");
	});
});

describe("truncateTranscript", () => {
	it("keeps the tail with a marker, starting on a whole line", () => {
		const line = "x".repeat(99);
		const long = Array.from({ length: 2000 }, () => line).join("\n");
		const truncated = truncateTranscript(long);
		expect(truncated.length).toBeLessThan(long.length);
		expect(truncated.startsWith("(transcript truncated")).toBe(true);
		// After the marker and blank line, only whole lines survive.
		const body = truncated.split("\n").slice(2).join("\n");
		for (const kept of body.split("\n")) expect(kept).toBe(line);
	});

	it("leaves short transcripts untouched", () => {
		expect(truncateTranscript("short")).toBe("short");
	});
});

describe("answerAsPredecessor", () => {
	function registryReturning(response: unknown) {
		return { complete: vi.fn().mockResolvedValue(response) } as never;
	}
	const model = { provider: "test", id: "test-model" } as never;

	it("returns the model's text and sends transcript + question under the ghost prompt", async () => {
		const registry = registryReturning({
			stopReason: "stop",
			content: [{ type: "text", text: "We ruled it out because of X." }],
		});
		const result = await answerAsPredecessor({
			modelRegistry: registry,
			model,
			transcriptText: "User: hi",
			question: "why X?",
			sessionId: "test-session",
		});
		expect(result).toEqual({ status: "ok", answer: "We ruled it out because of X." });

		const [, request] = (registry as { complete: ReturnType<typeof vi.fn> }).complete.mock.calls[0];
		expect(request.systemPrompt).toBe(GHOST_SYSTEM_PROMPT);
		expect(request.messages[0].content[0].text).toBe(buildGhostUserMessage("User: hi", "why X?"));
	});

	it("maps aborted and error stop reasons to their own outcomes", async () => {
		expect(
			await answerAsPredecessor({
				modelRegistry: registryReturning({ stopReason: "aborted", content: [] }),
				model,
				transcriptText: "t",
				question: "q",
				sessionId: "s",
			}),
		).toEqual({ status: "aborted" });

		expect(
			await answerAsPredecessor({
				modelRegistry: registryReturning({ stopReason: "error", errorMessage: "rate limited", content: [] }),
				model,
				transcriptText: "t",
				question: "q",
				sessionId: "s",
			}),
		).toEqual({ status: "failed", message: "rate limited" });
	});

	it("treats an empty response as failure, not an answer", async () => {
		expect(
			await answerAsPredecessor({
				modelRegistry: registryReturning({ stopReason: "stop", content: [] }),
				model,
				transcriptText: "t",
				question: "q",
				sessionId: "s",
			}),
		).toEqual({ status: "failed", message: "the model returned no text (stop reason: stop)" });
	});
});

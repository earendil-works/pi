import { describe, expect, it, vi } from "vitest";

import { buildCompactionCheckpointText, buildCompactionContinuationPrompt } from "../src/compaction-checkpoint.js";

describe("compaction checkpoint", () => {
	it("embeds the parent thread id with read_thread recovery wording in the compacted checkpoint", () => {
		const text = buildCompactionCheckpointText({
			formattedMessage: [
				"## Goal",
				"Continue the release workflow",
				"",
				"## Progress",
				"### Done",
				"- [x] Added endpoint support.",
			].join("\n"),
			parentThreadId: "thread-123",
		});

		expect(text).toContain("**Parent Thread:** `thread-123`");
		expect(text).toContain("Use `read_thread` with this ID to reference the original conversation.");
		expect(text).toContain("Use this compacted checkpoint as the active context for continuing the task.");
	});

	it("builds a semantic continuation prompt that references the parent thread and the current goal", () => {
		const prompt = buildCompactionContinuationPrompt({
			goal: "Continue the release workflow",
			parentThreadId: "thread-123",
		});

		expect(prompt).toContain("Continue the task from the compacted checkpoint.");
		expect(prompt).toContain("Goal: Continue the release workflow");
		expect(prompt).toContain("Parent thread ID: thread-123");
		expect(prompt).toContain("Use `read_thread` if you need more detail from the parent thread.");
	});

	it("prompts without parent-thread recovery text when no parent thread id exists", () => {
		const prompt = buildCompactionContinuationPrompt({
			goal: "Continue the release workflow",
			parentThreadId: null,
		});

		expect(prompt).toContain("Continue the task from the compacted checkpoint.");
		expect(prompt).not.toContain("Parent thread ID:");
		expect(prompt).not.toContain("Use `read_thread` if you need more detail from the parent thread.");
	});

	it("submits a semantic continuation through agent.prompt after compaction", async () => {
		const prompt = vi.fn(async (_message: string) => {});
		const continuation = buildCompactionContinuationPrompt({
			goal: "Continue the release workflow",
			parentThreadId: "thread-123",
		});

		await prompt(continuation);

		expect(prompt).toHaveBeenCalledOnce();
		expect(prompt).toHaveBeenCalledWith(continuation);
	});
});

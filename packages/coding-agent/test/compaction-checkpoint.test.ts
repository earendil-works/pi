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
			goal: "Continue the release workflow",
			parentThreadId: "thread-123",
		});

		expect(text).toContain("**Parent Thread:** `thread-123`");
		expect(text).toContain("Use `read_thread` with this ID to reference the original conversation.");
		expect(text).toContain("Use this compacted checkpoint as the active context for continuing the task.");
	});

	it("builds a fallback structured checkpoint when no formatted summary is provided", () => {
		const text = buildCompactionCheckpointText({
			formattedMessage: "",
			goal: "Continue the release workflow",
			parentThreadId: "thread-123",
			keyFiles: ["src/auth.ts"],
		});

		expect(text).toContain("## Goal");
		expect(text).toContain("### Done");
		expect(text).toContain("### In Progress");
		expect(text).toContain("## Next Steps");
		expect(text).toContain("src/auth.ts");
		expect(text).toContain("**Parent Thread:** `thread-123`");
	});

	it("builds a semantic continuation prompt that references the parent thread and the current goal", () => {
		const prompt = buildCompactionContinuationPrompt({
			formattedMessage: [
				"## Goal",
				"Continue the release workflow",
				"",
				"## Progress",
				"### Done",
				"- [x] Added endpoint support.",
				"",
				"### In Progress",
				"- Verify the compacted prompt content.",
				"",
				"## Next Steps",
				"1. Rerun the resume flow.",
			].join("\n"),
			goal: "Continue the release workflow",
			parentThreadId: "thread-123",
			keyFiles: ["src/auth.ts", "src/session.ts"],
		});

		expect(prompt).toContain("**CHECKPOINT**");
		expect(prompt).toContain("You are continuing from a compacted conversation.");
		expect(prompt).toContain("**Goal**");
		expect(prompt).toContain("Continue the release workflow");
		expect(prompt).toContain("**Touched Files**");
		expect(prompt).toContain("- src/auth.ts");
		expect(prompt).toContain("Parent thread ID: thread-123");
		expect(prompt).toContain("Use `read_thread` if you need more detail from the parent thread.");
		expect(prompt).not.toContain("### Done");
		expect(prompt).not.toContain("## Next Steps");
	});

	it("prompts without parent-thread recovery text when no parent thread id exists", () => {
		const prompt = buildCompactionContinuationPrompt({
			formattedMessage: "",
			goal: "Continue the release workflow",
			parentThreadId: null,
		});

		expect(prompt).toContain("**CHECKPOINT**");
		expect(prompt).toContain("You are continuing from a compacted conversation.");
		expect(prompt).toContain("**Goal**");
		expect(prompt).not.toContain("Parent thread ID:");
		expect(prompt).not.toContain("Use `read_thread` if you need more detail from the parent thread.");
		expect(prompt).not.toContain("### Done");
	});

	it("submits a semantic continuation through agent.prompt after compaction", async () => {
		const prompt = vi.fn(async (_message: string) => {});
		const continuation = buildCompactionContinuationPrompt({
			formattedMessage: "",
			goal: "Continue the release workflow",
			parentThreadId: "thread-123",
		});

		await prompt(continuation);

		expect(prompt).toHaveBeenCalledOnce();
		expect(prompt).toHaveBeenCalledWith(continuation);
	});
});

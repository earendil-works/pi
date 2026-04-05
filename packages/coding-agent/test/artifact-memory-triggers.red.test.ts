import type { ToolResultMessage } from "@kennyfrc/mu-ai";
import { describe, expect, it } from "vitest";

interface ArtifactMemoryEntryInput {
	kind: string;
	summary: string;
	workspaceRef: string;
	artifacts?: string[];
	sourceRefs?: string[];
	supersedes?: string;
}

interface ArtifactTriggerModule {
	deriveArtifactMemoryEntriesFromToolResult(
		toolResult: ToolResultMessage<unknown>,
		options: { workspaceRef: string },
	): ArtifactMemoryEntryInput[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function assertArtifactTriggerModule(value: unknown): asserts value is ArtifactTriggerModule {
	if (!isRecord(value)) {
		throw new Error("artifact trigger module did not load as an object");
	}

	if (typeof value.deriveArtifactMemoryEntriesFromToolResult !== "function") {
		throw new Error(
			"artifact trigger module is missing deriveArtifactMemoryEntriesFromToolResult(toolResult, options)",
		);
	}
}

async function loadArtifactTriggerModule(): Promise<ArtifactTriggerModule> {
	const loaded: unknown = await import("../src/memory/artifact-trigger.js");
	assertArtifactTriggerModule(loaded);
	return loaded;
}

function buildToolResultMessage(toolName: string, details: unknown, text: string): ToolResultMessage<unknown> {
	return {
		role: "toolResult",
		toolCallId: `call-${toolName}`,
		toolName,
		content: [{ type: "text", text }],
		details,
		isError: false,
		timestamp: Date.now(),
	};
}

describe("artifact memory triggers (red)", () => {
	it("derives artifact memory entries from completed write/edit/apply_patch results and skips bash without artifacts", async () => {
		const triggers = await loadArtifactTriggerModule();
		const workspaceRef = "/tmp/workspaces/alpha";

		const writeResult = buildToolResultMessage(
			"write",
			{
				path: "/tmp/workspaces/alpha/src/generated.ts",
				created: true,
				previousContent: null,
				newContentHash: "hash-write",
			},
			"Successfully wrote 42 bytes to src/generated.ts",
		);
		const writeEntries = triggers.deriveArtifactMemoryEntriesFromToolResult(writeResult, { workspaceRef });
		expect(writeEntries).toHaveLength(1);
		expect(writeEntries[0]).toMatchObject({
			kind: "artifact",
			workspaceRef,
			artifacts: ["/tmp/workspaces/alpha/src/generated.ts"],
			sourceRefs: ["tool:write"],
		});

		const editResult = buildToolResultMessage(
			"edit",
			{
				path: "/tmp/workspaces/alpha/src/app.ts",
				diff: "+1 console.log('updated')",
				oldText: "before",
				newText: "after",
				index: 12,
				newContentHash: "hash-edit",
			},
			"Successfully replaced text in src/app.ts.",
		);
		const editEntries = triggers.deriveArtifactMemoryEntriesFromToolResult(editResult, { workspaceRef });
		expect(editEntries).toHaveLength(1);
		expect(editEntries[0]?.artifacts).toEqual(["/tmp/workspaces/alpha/src/app.ts"]);
		expect(editEntries[0]?.sourceRefs).toEqual(["tool:edit"]);

		const applyPatchResult = buildToolResultMessage(
			"apply_patch",
			{
				parsed: {
					ops: [
						{ type: "update", path: "src/main.ts" },
						{ type: "add", path: "src/memory.ts" },
					],
				},
				undo: { entries: [] },
			},
			"Applied patch",
		);
		const applyPatchEntries = triggers.deriveArtifactMemoryEntriesFromToolResult(applyPatchResult, { workspaceRef });
		expect(applyPatchEntries).toHaveLength(1);
		expect(applyPatchEntries[0]?.artifacts).toEqual(["src/main.ts", "src/memory.ts"]);
		expect(applyPatchEntries[0]?.sourceRefs).toEqual(["tool:apply_patch"]);

		const bashWithoutArtifacts = buildToolResultMessage("bash", { exitCode: 0 }, "npm test completed successfully");
		expect(triggers.deriveArtifactMemoryEntriesFromToolResult(bashWithoutArtifacts, { workspaceRef })).toEqual([]);
	});

	it("derives a bash artifact memory entry only when the completed result carries artifact paths", async () => {
		const triggers = await loadArtifactTriggerModule();
		const workspaceRef = "/tmp/workspaces/alpha";
		const bashWithArtifacts = buildToolResultMessage(
			"bash",
			{
				exitCode: 0,
				artifacts: ["dist/app.js", "coverage/summary.json"],
			},
			"build completed",
		);

		const entries = triggers.deriveArtifactMemoryEntriesFromToolResult(bashWithArtifacts, { workspaceRef });
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			kind: "artifact",
			workspaceRef,
			artifacts: ["dist/app.js", "coverage/summary.json"],
			sourceRefs: ["tool:bash"],
		});
	});
});

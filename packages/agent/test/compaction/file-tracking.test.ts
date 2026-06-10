import { describe, expect, it } from "vitest";
import { createFileOps, extractFileOpsFromMessage } from "../../src/harness/compaction/utils.ts";
import type { AgentMessage } from "../../src/types.ts";

describe("extractFileOpsFromMessage — grep/find/ls (local)", () => {
	it("grep with explicit path → fileOps.read", () => {
		const fileOps = createFileOps();
		const message = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-1",
					name: "grep",
					arguments: { pattern: "TODO", path: "src" },
				},
			],
		} as unknown as AgentMessage;
		extractFileOpsFromMessage(message, fileOps);
		expect(fileOps.read.has("src")).toBe(true);
	});

	it("find with explicit path → fileOps.read", () => {
		const fileOps = createFileOps();
		const message = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-1",
					name: "find",
					arguments: { pattern: "*.ts", path: "src" },
				},
			],
		} as unknown as AgentMessage;
		extractFileOpsFromMessage(message, fileOps);
		expect(fileOps.read.has("src")).toBe(true);
	});

	it("ls with explicit path → fileOps.read", () => {
		const fileOps = createFileOps();
		const message = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-1",
					name: "ls",
					arguments: { path: "src" },
				},
			],
		} as unknown as AgentMessage;
		extractFileOpsFromMessage(message, fileOps);
		expect(fileOps.read.has("src")).toBe(true);
	});

	it("grep without path argument → no path added, no error", () => {
		const fileOps = createFileOps();
		const message = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-1",
					name: "grep",
					arguments: { pattern: "TODO" },
				},
			],
		} as unknown as AgentMessage;
		expect(() => extractFileOpsFromMessage(message, fileOps)).not.toThrow();
		expect(fileOps.read.size).toBe(0);
	});
});

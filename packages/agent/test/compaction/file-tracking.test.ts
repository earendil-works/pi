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

describe("extractFileOpsFromMessage — satellite_remote_exec", () => {
	it("satellite_remote_exec with tool=grep → fileOps.read", () => {
		const fileOps = createFileOps();
		const message = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-1",
					name: "satellite_remote_exec",
					arguments: { tool: "grep", pattern: "TODO", path: "src" },
				},
			],
		} as unknown as AgentMessage;
		extractFileOpsFromMessage(message, fileOps);
		expect(fileOps.read.has("src")).toBe(true);
	});

	it("satellite_remote_exec with tool=find → fileOps.read", () => {
		const fileOps = createFileOps();
		const message = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-2",
					name: "satellite_remote_exec",
					arguments: { tool: "find", pattern: "*.ts", path: "src" },
				},
			],
		} as unknown as AgentMessage;
		extractFileOpsFromMessage(message, fileOps);
		expect(fileOps.read.has("src")).toBe(true);
	});

	it("satellite_remote_exec with tool=ls → fileOps.read", () => {
		const fileOps = createFileOps();
		const message = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-3",
					name: "satellite_remote_exec",
					arguments: { tool: "ls", path: "src" },
				},
			],
		} as unknown as AgentMessage;
		extractFileOpsFromMessage(message, fileOps);
		expect(fileOps.read.has("src")).toBe(true);
	});

	it("satellite_remote_exec with tool=read → does NOT add to fileOps", () => {
		const fileOps = createFileOps();
		const message = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-4",
					name: "satellite_remote_exec",
					arguments: { tool: "read", path: "src/foo.ts" },
				},
			],
		} as unknown as AgentMessage;
		extractFileOpsFromMessage(message, fileOps);
		expect(fileOps.read.has("src/foo.ts")).toBe(false);
	});

	it("satellite_remote_exec with tool=bash → does NOT add to fileOps", () => {
		const fileOps = createFileOps();
		const message = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-5",
					name: "satellite_remote_exec",
					arguments: { tool: "bash", command: "cat src/foo.ts" },
				},
			],
		} as unknown as AgentMessage;
		expect(() => extractFileOpsFromMessage(message, fileOps)).not.toThrow();
		expect(fileOps.read.size).toBe(0);
		expect(fileOps.written.size).toBe(0);
		expect(fileOps.edited.size).toBe(0);
	});

	it("satellite_remote_exec without args.path → no path added, no error", () => {
		const fileOps = createFileOps();
		const message = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-6",
					name: "satellite_remote_exec",
					arguments: { tool: "grep", pattern: "TODO" },
				},
			],
		} as unknown as AgentMessage;
		expect(() => extractFileOpsFromMessage(message, fileOps)).not.toThrow();
		expect(fileOps.read.size).toBe(0);
	});
});

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	interceptTransferCall,
	interceptTransferResult,
} from "../tools.ts";

describe("interceptTransferCall (to_remote — inject content)", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "transfer-test-"));
	});
	afterEach(() => {
		if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
	});

	it("reads file1 and injects content into event.input", async () => {
		const file1 = join(tmpDir, "local.txt");
		writeFileSync(file1, "hello world", "utf-8");
		const event: { toolName: string; input: Record<string, unknown> } = {
			toolName: "satellite_remote_exec",
			input: { tool: "transfer_file", direction: "to_remote", file1, file2: "/hpc/remote.txt" },
		};
		const result = await interceptTransferCall(event);
		expect(result).toBeUndefined();
		expect(event.input.content).toBe("hello world");
	});

	it("returns block:true when file1 does not exist", async () => {
		const event: { toolName: string; input: Record<string, unknown> } = {
			toolName: "satellite_remote_exec",
			input: {
				tool: "transfer_file",
				direction: "to_remote",
				file1: join(tmpDir, "missing.txt"),
				file2: "/hpc/remote.txt",
			},
		};
		const result = await interceptTransferCall(event);
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/cannot read/);
	});

	it("ignores non-satellite tools", async () => {
		const event: { toolName: string; input: Record<string, unknown> } = {
			toolName: "some_other_tool",
			input: { tool: "transfer_file", direction: "to_remote", file1: "/x", file2: "/y" },
		};
		expect(await interceptTransferCall(event)).toBeUndefined();
		expect(event.input.content).toBeUndefined();
	});

	it("ignores to_local direction (handled in afterToolCall)", async () => {
		const file1 = join(tmpDir, "x.txt");
		writeFileSync(file1, "abc", "utf-8");
		const event: { toolName: string; input: Record<string, unknown> } = {
			toolName: "satellite_remote_exec",
			input: { tool: "transfer_file", direction: "to_local", file1, file2: "/hpc/r.txt" },
		};
		expect(await interceptTransferCall(event)).toBeUndefined();
		expect(event.input.content).toBeUndefined();
	});

	it("ignores non-transfer_file tools (e.g. read_file)", async () => {
		const event: { toolName: string; input: Record<string, unknown> } = {
			toolName: "satellite_remote_exec",
			input: { tool: "read_file", path: "/x" },
		};
		expect(await interceptTransferCall(event)).toBeUndefined();
	});
});

describe("interceptTransferResult (to_local — write file1, replace content)", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "transfer-result-"));
	});
	afterEach(() => {
		if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
	});

	it("writes file1 with server-returned bytes and replaces content with metadata", async () => {
		const file1 = join(tmpDir, "out.txt");
		const echo = "direction=remote_to_local, local=/x, remote=/hpc/r.txt\n";
		const event = {
			toolName: "satellite_remote_exec",
			input: { tool: "transfer_file", direction: "to_local", file1, file2: "/hpc/r.txt" },
			content: [{ type: "text" as const, text: echo + "downloaded content here" }],
			isError: false,
		};
		const result = await interceptTransferResult(event);
		expect(result).toBeDefined();
		expect(result!.content[0].text).toMatch(/Downloaded \d+ bytes/);
		expect(readFileSync(file1, "utf-8")).toBe("downloaded content here");
	});

	it("creates parent directories if missing", async () => {
		const file1 = join(tmpDir, "deep", "nested", "out.txt");
		const echo = "direction=remote_to_local, local=/x, remote=/hpc/r.txt\n";
		const event = {
			toolName: "satellite_remote_exec",
			input: { tool: "transfer_file", direction: "to_local", file1, file2: "/hpc/r.txt" },
			content: [{ type: "text" as const, text: echo + "ok" }],
			isError: false,
		};
		await interceptTransferResult(event);
		expect(existsSync(file1)).toBe(true);
	});

	it("passes through on error (don't write partial data)", async () => {
		const event = {
			toolName: "satellite_remote_exec",
			input: { tool: "transfer_file", direction: "to_local", file1: "/x", file2: "/hpc/r.txt" },
			content: [{ type: "text" as const, text: "Error: not found" }],
			isError: true,
		};
		expect(await interceptTransferResult(event)).toBeUndefined();
	});

	it("ignores non-satellite tools", async () => {
		const event = {
			toolName: "other",
			input: { tool: "transfer_file", direction: "to_local", file1: "/x", file2: "/y" },
			content: [{ type: "text" as const, text: "stuff" }],
			isError: false,
		};
		expect(await interceptTransferResult(event)).toBeUndefined();
	});

	it("ignores to_remote direction (handled in beforeToolCall)", async () => {
		const event = {
			toolName: "satellite_remote_exec",
			input: { tool: "transfer_file", direction: "to_remote", file1: "/x", file2: "/y" },
			content: [{ type: "text" as const, text: "irrelevant" }],
			isError: false,
		};
		expect(await interceptTransferResult(event)).toBeUndefined();
	});
});

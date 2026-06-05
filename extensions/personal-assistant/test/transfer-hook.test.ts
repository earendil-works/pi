import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	interceptTransferCall,
	interceptTransferResult,
} from "../tools.ts";
import { REMOTE_EXEC_INPUT_SCHEMA } from "../../satellite/schema.ts";

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

	// e2e: the post-hook payload must validate against the server's actual
	// input schema. We import the schema (not duplicate it) so this test
	// catches field-name drift between client hook and server.
	it("post-hook payload (to_remote) validates against REMOTE_EXEC_INPUT_SCHEMA", async () => {
		const file1 = join(tmpDir, "local.txt");
		writeFileSync(file1, "hello world", "utf-8");
		const event: { toolName: string; input: Record<string, unknown> } = {
			toolName: "satellite_remote_exec",
			input: { tool: "transfer_file", direction: "to_remote", file1, file2: "/hpc/remote.txt" },
		};
		await interceptTransferCall(event);
		const result = REMOTE_EXEC_INPUT_SCHEMA.safeParse(event.input);
		if (!result.success) {
			throw new Error(`Hook left invalid payload on the wire: ${result.error.message}`);
		}
		expect(result.success).toBe(true);
	});

	it("post-hook payload (to_local) validates against REMOTE_EXEC_INPUT_SCHEMA", async () => {
		const event: { toolName: string; input: Record<string, unknown> } = {
			toolName: "satellite_remote_exec",
			input: {
				tool: "transfer_file",
				direction: "to_local",
				file1: "/local/out.txt",
				file2: "/hpc/remote.txt",
			},
		};
		await interceptTransferCall(event);
		const result = REMOTE_EXEC_INPUT_SCHEMA.safeParse(event.input);
		if (!result.success) {
			throw new Error(`Hook left invalid payload on the wire: ${result.error.message}`);
		}
		expect(result.success).toBe(true);
	});
});

describe("interceptTransferResult (to_local — write local_path, replace content)", () => {
	// interceptTransferResult receives the SAME event.input that was passed
	// to interceptTransferCall. That hook translates to_local →
	// remote_to_local and renames file1/file2 → local_path/remote_path.
	// So the result hook must read the post-translation shape, not the
	// pre-translation one. (Bugs here: see the hotfix commit message.)

	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "transfer-result-"));
	});
	afterEach(() => {
		if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
	});

	it("writes local_path with server-returned bytes and replaces content with metadata", async () => {
		const localPath = join(tmpDir, "out.txt");
		const echo = "direction=remote_to_local, local=/x, remote=/hpc/r.txt\n";
		const event = {
			toolName: "satellite_remote_exec",
			input: { tool: "transfer_file", direction: "remote_to_local", local_path: localPath, remote_path: "/hpc/r.txt" },
			content: [{ type: "text" as const, text: echo + "downloaded content here" }],
			isError: false,
		};
		const result = await interceptTransferResult(event);
		expect(result).toBeDefined();
		expect(result!.content[0].text).toMatch(/Downloaded \d+ bytes/);
		expect(readFileSync(localPath, "utf-8")).toBe("downloaded content here");
	});

	it("creates parent directories if missing", async () => {
		const localPath = join(tmpDir, "deep", "nested", "out.txt");
		const echo = "direction=remote_to_local, local=/x, remote=/hpc/r.txt\n";
		const event = {
			toolName: "satellite_remote_exec",
			input: { tool: "transfer_file", direction: "remote_to_local", local_path: localPath, remote_path: "/hpc/r.txt" },
			content: [{ type: "text" as const, text: echo + "ok" }],
			isError: false,
		};
		await interceptTransferResult(event);
		expect(existsSync(localPath)).toBe(true);
	});

	it("passes through on error (don't write partial data)", async () => {
		const event = {
			toolName: "satellite_remote_exec",
			input: { tool: "transfer_file", direction: "remote_to_local", local_path: "/x", remote_path: "/hpc/r.txt" },
			content: [{ type: "text" as const, text: "Error: not found" }],
			isError: true,
		};
		expect(await interceptTransferResult(event)).toBeUndefined();
	});

	it("ignores non-satellite tools", async () => {
		const event = {
			toolName: "other",
			input: { tool: "transfer_file", direction: "remote_to_local", local_path: "/x", remote_path: "/y" },
			content: [{ type: "text" as const, text: "stuff" }],
			isError: false,
		};
		expect(await interceptTransferResult(event)).toBeUndefined();
	});

	it("ignores to_remote direction (handled in beforeToolCall, never reaches here)", async () => {
		const event = {
			toolName: "satellite_remote_exec",
			input: { tool: "transfer_file", direction: "local_to_remote", local_path: "/x", remote_path: "/y" },
			content: [{ type: "text" as const, text: "irrelevant" }],
			isError: false,
		};
		expect(await interceptTransferResult(event)).toBeUndefined();
	});

	// True end-to-end: run call hook → MCP schema validation → result hook.
	// The 10 single-side tests above could pass even if the result hook
	// read stale field names (which was the previous bug). This test
	// catches that class of regression by exercising the actual sequence.
	it("e2e: call hook translates → result hook writes file (to_local flow)", async () => {
		const file1 = join(tmpDir, "downloaded.txt");
		const file2 = "/hpc/remote/data.json";

		// 1. Agent calls with the user's view of the world.
		const callEvent: { toolName: string; input: Record<string, unknown> } = {
			toolName: "satellite_remote_exec",
			input: { tool: "transfer_file", direction: "to_local", file1, file2 },
		};
		const callResult = await interceptTransferCall(callEvent);
		expect(callResult).toBeUndefined();

		// 2. Verify the wire payload validates against the server schema.
		const wireCheck = REMOTE_EXEC_INPUT_SCHEMA.safeParse(callEvent.input);
		expect(wireCheck.success).toBe(true);

		// 3. Simulate server response: echo + content. The runner fires
		//    tool_result with the SAME event object (input still mutated).
		const echo = `direction=remote_to_local, local=${file1}, remote=${file2}\n`;
		const resultEvent = {
			toolName: "satellite_remote_exec" as const,
			input: callEvent.input,
			content: [{ type: "text" as const, text: echo + '{"key": "value"}' }],
			isError: false,
		};
		const resultResult = await interceptTransferResult(resultEvent);

		// 4. Verify both: the file was written AND the user sees metadata.
		expect(resultResult).toBeDefined();
		expect(readFileSync(file1, "utf-8")).toBe('{"key": "value"}');
		expect(resultResult!.content[0].text).toMatch(
			new RegExp(`Downloaded \\d+ bytes: ${file2.replace(/\//g, "\\/")} → ${file1.replace(/\//g, "\\/")}`),
		);
	});
});

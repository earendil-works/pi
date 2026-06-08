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

	it("blocks to_local with missing file1 (silent pass-through was a partial-injection bug)", async () => {
		const event: { toolName: string; input: Record<string, unknown> } = {
			toolName: "satellite_remote_exec",
			input: { tool: "transfer_file", direction: "to_local", file2: "/hpc/r.txt" },
		};
		const result = await interceptTransferCall(event);
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/missing/);
		// And the input must NOT have been mutated.
		expect(event.input.direction).toBe("to_local");
		expect(event.input.local_path).toBeUndefined();
	});

	it("blocks unknown direction (Zod error at server was opaque)", async () => {
		const event: { toolName: string; input: Record<string, unknown> } = {
			toolName: "satellite_remote_exec",
			input: { tool: "transfer_file", direction: "garbage", file1: "/x", file2: "/y" },
		};
		const result = await interceptTransferCall(event);
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/unknown direction/);
		// Input must NOT have been mutated to "local_to_remote" or similar.
		expect(event.input.direction).toBe("garbage");
	});

	it("blocks missing direction field (not 'to_remote' or 'to_local')", async () => {
		const event: { toolName: string; input: Record<string, unknown> } = {
			toolName: "satellite_remote_exec",
			input: { tool: "transfer_file", file1: "/x", file2: "/y" },
		};
		const result = await interceptTransferCall(event);
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/unknown direction/);
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

describe("interceptTransferCall direction aliases (model uses S3/curl/rsync vocab)", () => {
	// Models trained on S3 / curl / rsync / scp commonly reach for
	// "download" / "upload" / "get" / "put" / etc. when the server's
	// canonical enum is "remote_to_local" / "local_to_remote". Without
	// the alias table, the call gets a Zod error and the model starts
	// guessing. The hook must translate silently.

	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "transfer-alias-"));
	});
	afterEach(() => {
		if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
	});

	it.each([
		["download", "remote_to_local"],
		["DOWNLOAD", "remote_to_local"],
		["Download", "remote_to_local"],
		["get", "remote_to_local"],
		["pull", "remote_to_local"],
		["fetch", "remote_to_local"],
		["retrieve", "remote_to_local"],
		["upload", "local_to_remote"],
		["UPLOAD", "local_to_remote"],
		["send", "local_to_remote"],
		["push", "local_to_remote"],
		["put", "local_to_remote"],
	] as const)("translates alias %s → %s", async (alias, expectedCanonical) => {
		const file1 = join(tmpDir, "x.txt");
		if (expectedCanonical === "local_to_remote") {
			writeFileSync(file1, "data", "utf-8");
		}
		const event: { toolName: string; input: Record<string, unknown> } = {
			toolName: "satellite_remote_exec",
			input: {
				tool: "transfer_file",
				direction: alias,
				local_path: file1,
				remote_path: "/hpc/y.txt",
			},
		};
		const result = await interceptTransferCall(event);
		expect(result).toBeUndefined();
		// Hook must have normalized to the canonical direction.
		expect(event.input.direction).toBe(expectedCanonical);
		// local_path / remote_path must round-trip correctly.
		expect(event.input.local_path).toBe(file1);
		expect(event.input.remote_path).toBe("/hpc/y.txt");
		// For local_to_remote, content must be injected; for download, it must NOT.
		if (expectedCanonical === "local_to_remote") {
			expect(event.input.content).toBe("data");
		} else {
			expect(event.input.content).toBeUndefined();
		}
		// legacy file1/file2 must be cleaned up regardless of which field name the model used.
		expect(event.input.file1).toBeUndefined();
		expect(event.input.file2).toBeUndefined();
	});

	it("accepts local_path/remote_path (canonical) directly without going through file1/file2", async () => {
		const event: { toolName: string; input: Record<string, unknown> } = {
			toolName: "satellite_remote_exec",
			input: {
				tool: "transfer_file",
				direction: "remote_to_local",
				local_path: "/tmp/dest.txt",
				remote_path: "/hpc/src.txt",
			},
		};
		const result = await interceptTransferCall(event);
		expect(result).toBeUndefined();
		expect(event.input.direction).toBe("remote_to_local");
		expect(event.input.local_path).toBe("/tmp/dest.txt");
		expect(event.input.remote_path).toBe("/hpc/src.txt");
	});

	it("aliases + canonical path names combined work (model's actual reported shape)", async () => {
		const file1 = join(tmpDir, "miq.zip");
		writeFileSync(file1, "zipbytes", "utf-8");
		const event: { toolName: string; input: Record<string, unknown> } = {
			toolName: "satellite_remote_exec",
			input: {
				tool: "transfer_file",
				direction: "download", // alias
				remote_path: "/TJPROJ13/.../miq.zip", // canonical
				local_path: file1, // canonical
			},
		};
		const result = await interceptTransferCall(event);
		expect(result).toBeUndefined();
		expect(event.input.direction).toBe("remote_to_local");
		expect(event.input.local_path).toBe(file1);
		expect(event.input.remote_path).toBe("/TJPROJ13/.../miq.zip");
		expect(event.input.content).toBeUndefined(); // download, no content
	});

	it("truly unknown direction (e.g. 'sideways') still blocks with a helpful error", async () => {
		const event: { toolName: string; input: Record<string, unknown> } = {
			toolName: "satellite_remote_exec",
			input: {
				tool: "transfer_file",
				direction: "sideways",
				local_path: "/tmp/x",
				remote_path: "/hpc/y",
			},
		};
		const result = await interceptTransferCall(event);
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/unknown direction/);
		expect(result?.reason).toMatch(/upload|download/); // aliases mentioned in error
		// Input must NOT have been mutated.
		expect(event.input.direction).toBe("sideways");
		expect(event.input.local_path).toBe("/tmp/x");
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

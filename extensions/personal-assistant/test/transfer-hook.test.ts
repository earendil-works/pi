import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	interceptTransferCall,
	interceptTransferResult,
} from "../tools.ts";
import { REMOTE_EXEC_INPUT_SCHEMA } from "../../satellite/schema.ts";

describe("interceptTransferCall (strict canonical gate)", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "transfer-test-"));
	});
	afterEach(() => {
		if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
	});

	// --- Acceptance: only canonical direction + canonical field names ---

	it("accepts canonical local_to_remote and injects B64:base64 of the local file's bytes", async () => {
		const localPath = join(tmpDir, "local.txt");
		writeFileSync(localPath, "hello world", "utf-8");
		const event: { toolName: string; input: Record<string, unknown> } = {
			toolName: "satellite_remote_exec",
			input: {
				tool: "transfer_file",
				direction: "local_to_remote",
				local_path: localPath,
				remote_path: "/hpc/remote.txt",
			},
		};
		const result = await interceptTransferCall(event);
		expect(result).toBeUndefined();
		// Content must be the file's BYTES base64-encoded with the B64: marker
		// (so binary files survive the JSON string round-trip).
		const expectedB64 = Buffer.from("hello world", "utf-8").toString("base64");
		expect(event.input.content).toBe(`B64:${expectedB64}`);
		expect(event.input.direction).toBe("local_to_remote");
		expect(event.input.local_path).toBe(localPath);
		expect(event.input.remote_path).toBe("/hpc/remote.txt");
	});

	it("accepts canonical local_to_remote with BINARY content (round-trip base64)", async () => {
		const localPath = join(tmpDir, "binary.bin");
		// Bytes that would be corrupted by utf-8 decoding (invalid UTF-8 sequences).
		const raw = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xbc, 0x5c, 0xc8, 0x5c, 0xff, 0xfe, 0x00, 0x80, 0x81, 0x82, 0x83, 0x84]);
		writeFileSync(localPath, raw);
		const event: { toolName: string; input: Record<string, unknown> } = {
			toolName: "satellite_remote_exec",
			input: {
				tool: "transfer_file",
				direction: "local_to_remote",
				local_path: localPath,
				remote_path: "/hpc/binary.bin",
			},
		};
		const result = await interceptTransferCall(event);
		expect(result).toBeUndefined();
		const expectedB64 = raw.toString("base64");
		expect(event.input.content).toBe(`B64:${expectedB64}`);
		// Decoding the base64 back gives the original bytes byte-for-byte.
		const content = event.input.content as string;
		const decoded = Buffer.from(content.slice("B64:".length), "base64");
		expect(decoded.equals(raw)).toBe(true);
	});

	it("accepts canonical remote_to_local and passes through unchanged (file write is the AFTER hook)", async () => {
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
		expect(event.input.content).toBeUndefined();
		expect(event.input.direction).toBe("remote_to_local");
		expect(event.input.local_path).toBe("/tmp/dest.txt");
		expect(event.input.remote_path).toBe("/hpc/src.txt");
	});

	// --- Tool / sub-tool scoping (unchanged) ---

	it("ignores non-satellite tools", async () => {
		const event: { toolName: string; input: Record<string, unknown> } = {
			toolName: "some_other_tool",
			input: { tool: "transfer_file", direction: "local_to_remote", local_path: "/x", remote_path: "/y" },
		};
		expect(await interceptTransferCall(event)).toBeUndefined();
		expect(event.input.content).toBeUndefined();
	});

	it("ignores non-transfer_file tools (e.g. read)", async () => {
		const event: { toolName: string; input: Record<string, unknown> } = {
			toolName: "satellite_remote_exec",
			input: { tool: "read", path: "/x" },
		};
		expect(await interceptTransferCall(event)).toBeUndefined();
	});

	// --- Rejection: legacy direction names ---

	it("rejects legacy direction 'to_remote' (the old pre-canonical API)", async () => {
		const event: { toolName: string; input: Record<string, unknown> } = {
			toolName: "satellite_remote_exec",
			input: { tool: "transfer_file", direction: "to_remote", local_path: "/x", remote_path: "/y" },
		};
		const result = await interceptTransferCall(event);
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/expected "local_to_remote" or "remote_to_local"/);
		expect(result?.reason).toMatch(/"to_remote"/);
		// Input must NOT have been mutated.
		expect(event.input.direction).toBe("to_remote");
		expect(event.input.content).toBeUndefined();
	});

	it("rejects legacy direction 'to_local' (the old pre-canonical API)", async () => {
		const event = {
			toolName: "satellite_remote_exec",
			input: { tool: "transfer_file", direction: "to_local", local_path: "/x", remote_path: "/y" },
		};
		const result = await interceptTransferCall(event);
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/expected "local_to_remote" or "remote_to_local"/);
		expect(result?.reason).toMatch(/"to_local"/);
	});

	// --- Rejection: S3 / curl / rsync / scp vocabulary (the actual reason this gate exists) ---

	it.each([
		"download", "upload", "get", "put", "pull", "push",
		"send", "fetch", "retrieve",
		// case-mismatch (canonical is case-sensitive)
		"Download", "UPLOAD", "Local_To_Remote", "REMOTE_TO_LOCAL",
	])("rejects API-convention direction %s with canonical names in error", async (wrong) => {
		const event = {
			toolName: "satellite_remote_exec",
			input: { tool: "transfer_file", direction: wrong, local_path: "/x", remote_path: "/y" },
		};
		const result = await interceptTransferCall(event);
		expect(result?.block, `direction=${wrong} should be blocked`).toBe(true);
		expect(result?.reason).toMatch(/expected "local_to_remote" or "remote_to_local"/);
		// The error must explicitly echo the rejected value so the model knows what it sent.
		expect(result?.reason).toContain(wrong);
		// The error must also mention that these aliases are NOT accepted.
		// Input must NOT have been mutated.
		expect(event.input.direction).toBe(wrong);
	});

	// --- Rejection: missing / malformed direction ---

	it("rejects missing direction field", async () => {
		const event = {
			toolName: "satellite_remote_exec",
			input: { tool: "transfer_file", local_path: "/x", remote_path: "/y" },
		};
		const result = await interceptTransferCall(event);
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/expected "local_to_remote" or "remote_to_local"/);
	});

	it.each(["", null, 0, 123, true, false, [], {}])(
		"rejects malformed direction %s",
		async (bad) => {
			const event = {
				toolName: "satellite_remote_exec",
				input: { tool: "transfer_file", direction: bad, local_path: "/x", remote_path: "/y" },
			};
			const result = await interceptTransferCall(event);
			expect(result?.block, `direction=${JSON.stringify(bad)} should be blocked`).toBe(true);
		},
	);

	// --- Rejection: legacy field names ---

	it("rejects legacy field name 'file1'", async () => {
		const event: { toolName: string; input: Record<string, unknown> } = {
			toolName: "satellite_remote_exec",
			input: { tool: "transfer_file", direction: "local_to_remote", file1: "/x", remote_path: "/y" },
		};
		const result = await interceptTransferCall(event);
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/use "local_path" and "remote_path"/);
		expect(result?.reason).toMatch(/file1/);
		// (The verbose "NOT accepted" hint was removed when we shortened
		//  the error message — the pre-emptive teaching of canonical names
		//  now lives in buildTransferFileCanonicalPrompt, injected into
		//  the system prompt at session start.)
		// Input must NOT have been mutated.
		expect(event.input.file1).toBe("/x");
		expect(event.input.local_path).toBeUndefined();
	});

	it("rejects legacy field name 'file2'", async () => {
		const event: { toolName: string; input: Record<string, unknown> } = {
			toolName: "satellite_remote_exec",
			input: { tool: "transfer_file", direction: "remote_to_local", local_path: "/x", file2: "/y" },
		};
		const result = await interceptTransferCall(event);
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/file2/);
	});

	it("rejects both file1 and file2 (lists both in error)", async () => {
		const event = {
			toolName: "satellite_remote_exec",
			input: { tool: "transfer_file", direction: "local_to_remote", file1: "/x", file2: "/y" },
		};
		const result = await interceptTransferCall(event);
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/file1/);
		expect(result?.reason).toMatch(/file2/);
	});

	// --- Rejection: missing required canonical fields ---

	it("rejects local_to_remote with missing local_path", async () => {
		const event = {
			toolName: "satellite_remote_exec",
			input: { tool: "transfer_file", direction: "local_to_remote", remote_path: "/y" },
		};
		const result = await interceptTransferCall(event);
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/requires "local_path"/);
	});

	it("rejects remote_to_local with missing local_path", async () => {
		const event = {
			toolName: "satellite_remote_exec",
			input: { tool: "transfer_file", direction: "remote_to_local", remote_path: "/y" },
		};
		const result = await interceptTransferCall(event);
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/requires "local_path"/);
	});

	it("rejects local_to_remote when local file cannot be read", async () => {
		const event = {
			toolName: "satellite_remote_exec",
			input: { tool: "transfer_file", direction: "local_to_remote", local_path: "/nonexistent/path/abc", remote_path: "/y" },
		};
		const result = await interceptTransferCall(event);
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/cannot read/);
	});

	// --- e2e: post-hook payload must validate against the server's schema ---

	it("post-hook payload (local_to_remote) validates against REMOTE_EXEC_INPUT_SCHEMA", async () => {
		const localPath = join(tmpDir, "local.txt");
		writeFileSync(localPath, "hello", "utf-8");
		const event = {
			toolName: "satellite_remote_exec",
			input: { tool: "transfer_file", direction: "local_to_remote", local_path: localPath, remote_path: "/hpc/remote.txt" },
		};
		await interceptTransferCall(event);
		const result = REMOTE_EXEC_INPUT_SCHEMA.safeParse(event.input);
		if (!result.success) {
			throw new Error(`Hook left invalid payload: ${result.error.message}`);
		}
		expect(result.success).toBe(true);
	});

	it("post-hook payload (remote_to_local) validates against REMOTE_EXEC_INPUT_SCHEMA", async () => {
		const event = {
			toolName: "satellite_remote_exec",
			input: { tool: "transfer_file", direction: "remote_to_local", local_path: "/local/out.txt", remote_path: "/hpc/remote.txt" },
		};
		await interceptTransferCall(event);
		const result = REMOTE_EXEC_INPUT_SCHEMA.safeParse(event.input);
		if (!result.success) {
			throw new Error(`Hook left invalid payload: ${result.error.message}`);
		}
		expect(result.success).toBe(true);
	});

	// --- The user's reported failure shape: must be rejected (teaches model) ---

	it("rejects the user's reported bad shape (direction: 'download' + canonical paths)", async () => {
		const event = {
			toolName: "satellite_remote_exec",
			input: {
				tool: "transfer_file",
				direction: "download",
				remote_path: "/TJPROJ13/.../miq.zip",
				local_path: "/tmp/SYH-202606042100-miq.zip",
			},
		};
		const result = await interceptTransferCall(event);
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/"download"/);
		expect(result?.reason).toMatch(/local_to_remote.*remote_to_local/);
		// The path fields were canonical; the only problem was direction.
	});
});

describe("interceptTransferResult (remote_to_local — write local_path, replace content)", () => {
	// interceptTransferResult receives the same event.input that was passed
	// to interceptTransferCall. The call hook is a strict canonical gate
	// (see the describe above), so by the time we get here the input is
	// always in canonical shape (direction: "remote_to_local" or
	// "local_to_remote", path fields: local_path / remote_path). The
	// result hook must read this canonical shape, not the pre-canonical
	// one. (Bugs here: see the hotfix commit message.)

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

	it("ignores local_to_remote direction (handled in beforeToolCall, never reaches here)", async () => {
		const event = {
			toolName: "satellite_remote_exec",
			input: { tool: "transfer_file", direction: "local_to_remote", local_path: "/x", remote_path: "/y" },
			content: [{ type: "text" as const, text: "irrelevant" }],
			isError: false,
		};
		expect(await interceptTransferResult(event)).toBeUndefined();
	});

	// True end-to-end: call hook (canonical) → MCP schema validation → result hook.
	// The single-side tests above could pass even if the result hook
	// read stale field names. This test catches that class of regression
	// by exercising the actual sequence with canonical names.
	it("e2e: call hook accepts canonical → result hook writes file (remote_to_local flow)", async () => {
		const localPath = join(tmpDir, "downloaded.txt");
		const remotePath = "/hpc/remote/data.json";

		// 1. Agent calls with canonical names. The strict gate accepts.
		const callEvent: { toolName: string; input: Record<string, unknown> } = {
			toolName: "satellite_remote_exec",
			input: { tool: "transfer_file", direction: "remote_to_local", local_path: localPath, remote_path: remotePath },
		};
		const callResult = await interceptTransferCall(callEvent);
		expect(callResult).toBeUndefined();

		// 2. Verify the wire payload validates against the server schema.
		const wireCheck = REMOTE_EXEC_INPUT_SCHEMA.safeParse(callEvent.input);
		expect(wireCheck.success).toBe(true);

		// 3. Simulate server response: echo + content. The runner fires
		//    tool_result with the same event object (input still in canonical form).
		const echo = `direction=remote_to_local, local=${localPath}, remote=${remotePath}\n`;
		const resultEvent = {
			toolName: "satellite_remote_exec" as const,
			input: callEvent.input,
			content: [{ type: "text" as const, text: echo + '{"key": "value"}' }],
			isError: false,
		};
		const resultResult = await interceptTransferResult(resultEvent);

		// 4. Verify both: the file was written AND the user sees metadata.
		expect(resultResult).toBeDefined();
		expect(readFileSync(localPath, "utf-8")).toBe('{"key": "value"}');
		expect(resultResult!.content[0].text).toMatch(
			new RegExp(`Downloaded \\d+ bytes: ${remotePath.replace(/\//g, "\\/")} → ${localPath.replace(/\//g, "\\/")}`),
		);
	});
});

import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { execCommandTool } from "./exec-command.js";

describe("exec_command tool", () => {
	let tempDir: string | null = null;

	afterEach(async () => {
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true });
			tempDir = null;
		}
	});

	it("executes a command and returns output", async () => {
		const result = await execCommandTool.execute("toolcall_1", { cmd: 'echo "hello"' });
		const text = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
		expect(text).toContain("hello");
	});

	it("supports workdir", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mu-exec-command-"));

		const result = await execCommandTool.execute("toolcall_2", { cmd: "pwd", workdir: tempDir });
		const text = result.content
			.map((c) => ("text" in c ? c.text : ""))
			.join("\n")
			.trim();
		expect(text).toContain(tempDir);
	});
});

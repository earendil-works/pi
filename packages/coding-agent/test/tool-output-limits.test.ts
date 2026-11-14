import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createBashTool } from "../src/core/tools/bash.ts";
import { createReadTool } from "../src/core/tools/read.ts";
import { appendNoticeWithinLimits, resolveToolOutputLimits } from "../src/core/tools/truncate.ts";

const textOf = (result: { content?: Array<{ type: string; text?: string }> }) =>
	(result.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");

describe("toolOutput ceilings", () => {
	it("keeps the upstream defaults when the setting is absent", () => {
		expect(SettingsManager.inMemory().getToolOutputLimits()).toEqual({ maxBytes: 51200, maxLines: 2000 });
		expect(resolveToolOutputLimits(undefined)).toEqual({ maxBytes: 51200, maxLines: 2000 });
	});

	it("uses absolute settings for the model-facing excerpt", () => {
		const manager = SettingsManager.inMemory({ toolOutput: { maxBytes: 25600, maxLines: 1500 } });
		expect(manager.getToolOutputLimits()).toEqual({ maxBytes: 25600, maxLines: 1500 });
	});

	it("keeps a read excerpt within the configured ceilings and names the continuation", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-tool-output-"));
		const file = join(dir, "wide.txt");
		writeFileSync(file, Array.from({ length: 30 }, () => "abcdefghij").join("\n"));
		const tool = createReadTool(dir);
		const result = await tool.execute(
			"call",
			{ path: file },
			undefined,
			undefined,
			{ getSettings: () => ({ toolOutput: { maxBytes: 180, maxLines: 4 } }) } as never,
		);
		const text = textOf(result);
		expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(180);
		expect(text.split("\n").length).toBeLessThanOrEqual(4);
		expect(text).toMatch(/offset=/);
		expect(text.length).toBeGreaterThan(0);
	});

	it("keeps a bash excerpt within the configured ceilings and names the full output", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute(
			"call",
			{ command: "python3 -c 'print(\"abcde\" * 80)'" },
			undefined,
			undefined,
			{
				getSettings: () => ({ toolOutput: { maxBytes: 120, maxLines: 6 } }),
				sessionManager: { getSessionId: () => "session", getSessionFile: () => undefined },
			} as never,
		);
		const text = textOf(result);
		expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(120);
		expect(text.split("\n").length).toBeLessThanOrEqual(6);
		expect(text).toMatch(/Full output: /);
		expect(result.details?.fullOutputPath).toBeTruthy();
	});

	it("fits the notice inside the byte ceiling", () => {
		const text = appendNoticeWithinLimits("x".repeat(500), "\n\n[Full output: /tmp/out]", {
			maxBytes: 80,
			maxLines: 4,
		});
		expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(80);
		expect(text).toContain("Full output:");
	});
});

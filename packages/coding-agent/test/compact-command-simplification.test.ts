import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@kennyfrc/mu-agent-core";
import { getModel } from "@kennyfrc/mu-ai";
import { describe, expect, it } from "vitest";

import { parseCompactSlashCommand } from "../src/compact-command.js";
import { SettingsManager } from "../src/settings-manager.js";
import { initTheme } from "../src/theme/theme.js";
import { TuiRenderer } from "../src/tui/tui-renderer.js";

describe("compact command simplification", () => {
	it("accepts only /compact --summary <goal>", () => {
		expect(parseCompactSlashCommand("/compact --summary continue login fix")).toEqual({
			kind: "compact",
			goal: "continue login fix",
		});
		expect(parseCompactSlashCommand("/compact continue login fix")).toBeNull();
		expect(parseCompactSlashCommand("/compact --inject src/app.ts")).toBeNull();
		expect(parseCompactSlashCommand("/compact on")).toBeNull();
		expect(parseCompactSlashCommand("/compact toggle")).toBeNull();
	});

	it("exposes only /compact in the built-in slash command list", () => {
		initTheme("dark");
		const configDir = mkdtempSync(join(tmpdir(), "mu-compact-command-test-"));

		try {
			const agent = new Agent({
				transport: {
					async *run() {
						yield { type: "agent_end", messages: [] };
					},
				},
				initialState: {
					model: getModel("openai", "gpt-4o-mini"),
					thinkingLevel: "medium",
				},
			});

			const renderer = new TuiRenderer(
				agent,
				{
					appendContextCompaction: () => {},
					loadTitle: () => null,
					getSessionId: () => "compact-command-test",
				} as never,
				new SettingsManager(configDir),
				{
					listCommands: () => [],
					getCommand: () => undefined,
					applyInputHooks: async (text: string) => ({ handled: false, text }),
					composeToolResultTransformer: <T>(base: T) => base,
				} as never,
				{} as never,
				"0.0.0",
			);

			const commands = (
				renderer as unknown as { builtInSlashCommands: Array<{ name: string; injectedDiagnostic?: string }> }
			).builtInSlashCommands;
			expect(commands.some((command) => command.name === "compact")).toBe(true);
			expect(commands.some((command) => command.name === "morph-compaction")).toBe(false);
			expect(commands.find((command) => command.name === "compact")?.injectedDiagnostic).toContain(
				"--summary <goal>",
			);
		} finally {
			rmSync(configDir, { recursive: true, force: true });
		}
	});
});

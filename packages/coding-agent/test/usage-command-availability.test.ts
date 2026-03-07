import { Agent } from "@kennyfrc/mu-agent-core";
import { getModel } from "@kennyfrc/mu-ai";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/settings-manager.js";
import { initTheme } from "../src/theme/theme.js";
import { TuiRenderer } from "../src/tui/tui-renderer.js";

function createRenderer(modelId: string, provider: "openai" | "openai-codex" = "openai") {
	const baseDir = join(tmpdir(), `mu-usage-command-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(baseDir, { recursive: true });

	const agent = new Agent({
		transport: {
			async *run() {
				yield* [];
				throw new Error("not used in this test");
			},
		} as never,
		initialState: {
			model: getModel(provider as never, modelId as never),
		},
	});

	const renderer = new TuiRenderer(
		agent,
		{ loadTitle: () => null } as never,
		new SettingsManager(baseDir),
		{
			listCommands: () => [],
			applyInputHooks: async (text: string) => ({ handled: false, text }),
			composeToolResultTransformer: <T>(base: T) => base,
		} as never,
		{} as never,
		"0.0.0",
	);

	return {
		baseDir,
		renderer,
		cleanup: () => rmSync(baseDir, { recursive: true, force: true }),
	};
}

describe("/usage command availability", () => {
	initTheme("dark");

	it("registers /usage for GPT-family models", () => {
		const { renderer, cleanup } = createRenderer("gpt-5.3-codex-spark", "openai-codex");
		try {
			const commandNames = (renderer as any).builtInSlashCommands.map((cmd: { name: string }) => cmd.name);
			expect(commandNames).toContain("usage");
		} finally {
			cleanup();
			renderer.stop();
		}
	});

	it("does not register /usage for non-GPT models", () => {
		const baseDir = join(tmpdir(), `mu-usage-command-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(baseDir, { recursive: true });

		const agent = new Agent({
			transport: {
				async *run() {
					yield* [];
					throw new Error("not used in this test");
				},
			} as never,
			initialState: {
				model: getModel("anthropic", "claude-sonnet-4-5"),
			},
		});

		const renderer = new TuiRenderer(
			agent,
			{ loadTitle: () => null } as never,
			new SettingsManager(baseDir),
			{
				listCommands: () => [],
				applyInputHooks: async (text: string) => ({ handled: false, text }),
				composeToolResultTransformer: <T>(base: T) => base,
			} as never,
			{} as never,
			"0.0.0",
		);

		try {
			const commandNames = (renderer as any).builtInSlashCommands.map((cmd: { name: string }) => cmd.name);
			expect(commandNames).not.toContain("usage");
		} finally {
			renderer.stop();
			rmSync(baseDir, { recursive: true, force: true });
		}
	});
});

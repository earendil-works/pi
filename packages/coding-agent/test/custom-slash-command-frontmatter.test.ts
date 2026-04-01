import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@kennyfrc/mu-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/settings-manager.js";
import { initTheme } from "../src/theme/theme.js";
import { TuiRenderer } from "../src/tui/tui-renderer.js";

type RendererForSlashTests = {
	stop(): void;
	getAllSlashCommands(): Array<{ name: string; description: string }>;
};

describe("custom slash command frontmatter", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("registers file-backed slash commands in the live TUI renderer", async () => {
		initTheme("dark");
		const baseDir = mkdtempSync(join(tmpdir(), "mu-custom-slash-config-"));
		const workspaceDir = mkdtempSync(join(tmpdir(), "mu-custom-slash-workspace-"));
		const previousConfigDir = process.env.MU_CODING_AGENT_DIR;
		const previousCwd = process.cwd();
		process.env.MU_CODING_AGENT_DIR = baseDir;
		process.chdir(workspaceDir);

		cleanups.push(() => {
			process.chdir(previousCwd);
			if (previousConfigDir === undefined) {
				delete process.env.MU_CODING_AGENT_DIR;
			} else {
				process.env.MU_CODING_AGENT_DIR = previousConfigDir;
			}
			rmSync(baseDir, { recursive: true, force: true });
			rmSync(workspaceDir, { recursive: true, force: true });
		});

		const commandsDir = join(workspaceDir, ".mu", "commands");
		mkdirSync(commandsDir, { recursive: true });
		writeFileSync(
			join(commandsDir, "review.md"),
			[
				"---",
				"description: Review with Kimi",
				"provider: fireworks",
				"model: accounts/fireworks/routers/kimi-k2p5-turbo",
				"reasoning_level: medium",
				"---",
				"Review $ARGUMENTS",
			].join("\n"),
		);

		const agent = new Agent({
			transport: {
				async *run() {
					yield* [];
				},
			} as never,
		});

		const renderer = new TuiRenderer(
			agent,
			{
				loadTitle: () => null,
				getSessionId: () => "custom-slash-frontmatter",
			} as never,
			new SettingsManager(baseDir),
			{
				listCommands: () => [],
				getCommand: () => undefined,
				applyInputHooks: async (text: string) => ({ handled: false, text }),
				composeToolResultTransformer: <T>(base: T) => base,
			} as never,
			{} as never,
			"0.0.0",
		) as unknown as RendererForSlashTests;

		await (renderer as unknown as { init(): Promise<void> }).init();
		cleanups.push(() => renderer.stop());

		const commands = renderer.getAllSlashCommands();
		expect(commands.find((command) => command.name === "review")).toMatchObject({
			name: "review",
			description: "Review with Kimi (project)",
		});
	});
});

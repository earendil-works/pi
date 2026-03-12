import { Agent } from "@kennyfrc/mu-agent-core";
import { getModel } from "@kennyfrc/mu-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/settings-manager.js";
import { initTheme } from "../src/theme/theme.js";
import { TuiRenderer } from "../src/tui/tui-renderer.js";

type RendererForSlashTests = {
	stop(): void;
	getAllSlashCommands(): Array<{ name: string; description: string }>;
};

async function makeRenderer(): Promise<RendererForSlashTests> {
	initTheme("dark");
	const agent = new Agent({
		transport: {
			async *run() {
				yield* [];
			},
		} as never,
		initialState: {
			model: getModel("openai-codex", "gpt-5.4"),
			thinkingLevel: "medium",
		},
	});

	const renderer = new TuiRenderer(
		agent,
		{
			loadTitle: () => null,
			getSessionId: () => "background-jobs-slash-red",
		} as never,
		new SettingsManager(process.cwd()),
		{
			listCommands: () => [],
			getCommand: () => undefined,
			applyInputHooks: async (text: string) => ({ handled: false, text }),
			composeToolResultTransformer: <T>(base: T) => base,
		} as never,
		{} as never,
		"0.0.0",
	);

	await renderer.init();
	return renderer as unknown as RendererForSlashTests;
}

describe("background job slash commands (red)", () => {
	const renderers: RendererForSlashTests[] = [];

	afterEach(() => {
		for (const renderer of renderers.splice(0)) {
			renderer.stop();
		}
	});

	it("registers background-job slash commands in the live TUI renderer", async () => {
		const renderer = await makeRenderer();
		renderers.push(renderer);

		const commands = renderer.getAllSlashCommands();
		const names = commands.map((command) => command.name);

		expect(names).toContain("ps");
		expect(names).toContain("kill");
		expect(names).toContain("clean");

		expect(commands.find((command) => command.name === "ps")?.description).toMatch(/background/i);
		expect(commands.find((command) => command.name === "kill")?.description).toMatch(/background/i);
		expect(commands.find((command) => command.name === "clean")?.description).toMatch(/background/i);
	});
});

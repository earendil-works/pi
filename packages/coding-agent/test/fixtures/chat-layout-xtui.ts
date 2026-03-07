import { Agent } from "@kennyfrc/mu-agent-core";
import { getModel } from "@kennyfrc/mu-ai";
import { Text } from "@kennyfrc/mu-tui";
import { SettingsManager } from "../../src/settings-manager.js";
import { initTheme } from "../../src/theme/theme.js";
import { TuiRenderer } from "../../src/tui/tui-renderer.js";

async function main(): Promise<void> {
	initTheme("dark");
	const thinkingLevel =
		process.env.MU_XTUI_THINKING_LEVEL === "minimal" ||
		process.env.MU_XTUI_THINKING_LEVEL === "low" ||
		process.env.MU_XTUI_THINKING_LEVEL === "medium" ||
		process.env.MU_XTUI_THINKING_LEVEL === "high" ||
		process.env.MU_XTUI_THINKING_LEVEL === "xhigh" ||
		process.env.MU_XTUI_THINKING_LEVEL === "off"
			? process.env.MU_XTUI_THINKING_LEVEL
			: "medium";

	const agent = new Agent({
		transport: {
			async *run() {
				yield* [];
			},
		} as never,
		initialState: {
			model: getModel("openai-codex", "gpt-5.4"),
			thinkingLevel,
		},
	});

	const renderer = new TuiRenderer(
		agent,
		{
			loadTitle: () => null,
			getSessionId: () => "xtui-chat-layout-spec",
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

	const view = renderer as unknown as {
		chatContainer: { addChild(component: Text): void };
		ui: { requestRender(): void };
	};

	for (let index = 1; index <= 60; index++) {
		view.chatContainer.addChild(new Text(`chat line ${index}`, 0, 0));
	}
	view.chatContainer.addChild(new Text("XTUI_CHAT_LAYOUT_READY", 0, 0));
	view.ui.requestRender();

	const shutdown = (): void => {
		renderer.stop();
		process.exit(0);
	};

	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);

	await new Promise<void>(() => {
		setInterval(() => {}, 1000);
	});
}

void main();

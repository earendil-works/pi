import { Agent } from "@kennyfrc/mu-agent-core";
import { getModel } from "@kennyfrc/mu-ai";
import { Text } from "@kennyfrc/mu-tui";
import { SettingsManager } from "../../src/settings-manager.js";
import { initTheme } from "../../src/theme/theme.js";
import { TuiRenderer } from "../../src/tui/tui-renderer.js";

async function main(): Promise<void> {
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
			getSessionId: () => "xtui-transcript-copy-toast",
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
		handleTranscriptSelectionCopy(text: string): void;
	};

	view.chatContainer.addChild(new Text("XTUI_TOAST_READY", 0, 0));
	view.ui.requestRender();

	setTimeout(() => {
		view.handleTranscriptSelectionCopy("fixture transcript copy");
	}, 300);

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

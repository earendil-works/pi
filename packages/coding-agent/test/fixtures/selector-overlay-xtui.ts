import { Agent } from "@kennyfrc/mu-agent-core";
import { getModel } from "@kennyfrc/mu-ai";
import { SettingsManager } from "../../src/settings-manager.js";
import { initTheme } from "../../src/theme/theme.js";
import { TuiRenderer } from "../../src/tui/tui-renderer.js";

type SelectorKind = "model" | "theme" | "thinking" | "queue" | "user";

function getSelectorKind(): SelectorKind {
	const value = process.env.MU_XTUI_SELECTOR_KIND;
	if (value === "model" || value === "theme" || value === "thinking" || value === "queue" || value === "user") {
		return value;
	}
	return "model";
}

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
			getSessionId: () => "xtui-selector-overlay-spec",
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
		showModelSelector(): void;
		showThemeSelector(): void;
		showThinkingSelector(): void;
		showQueueModeSelector(): void;
		showUserMessageSelector(): void;
		agent: {
			replaceMessages(messages: Array<{ role: string; content: Array<{ type: string; text: string }> }>): void;
		};
		ui: { requestRender(): void };
	};

	switch (getSelectorKind()) {
		case "model":
			view.showModelSelector();
			break;
		case "theme":
			view.showThemeSelector();
			break;
		case "thinking":
			view.showThinkingSelector();
			break;
		case "queue":
			view.showQueueModeSelector();
			break;
		case "user":
			view.agent.replaceMessages([
				{ role: "user", content: [{ type: "text", text: "first user" }] },
				{ role: "user", content: [{ type: "text", text: "second user" }] },
			]);
			view.showUserMessageSelector();
			break;
	}

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

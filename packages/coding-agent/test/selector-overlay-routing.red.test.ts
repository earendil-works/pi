import { Agent } from "@kennyfrc/mu-agent-core";
import { getModel } from "@kennyfrc/mu-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/settings-manager.js";
import { initTheme } from "../src/theme/theme.js";
import { TuiRenderer } from "../src/tui/tui-renderer.js";

async function makeRenderer() {
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
			getSessionId: () => "selector-overlay-routing-red",
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
	return renderer as unknown as {
		stop(): void;
		ui: {
			setOverlay(component: unknown, options?: unknown): void;
		};
		editorContainer: {
			addChild(component: unknown): void;
		};
		agent: {
			replaceMessages(messages: unknown[]): void;
		};
		showModelSelector(): void;
		showThemeSelector(): void;
		showThinkingSelector(): void;
		showQueueModeSelector(): void;
		showUserMessageSelector(): void;
	};
}

describe("selector overlay routing", () => {
	const renderers: Array<{ stop(): void }> = [];

	afterEach(() => {
		for (const renderer of renderers.splice(0)) {
			renderer.stop();
		}
	});

	async function expectUsesOverlay(
		invoke: (renderer: Awaited<ReturnType<typeof makeRenderer>>) => void,
		prepare?: (renderer: Awaited<ReturnType<typeof makeRenderer>>) => void,
	): Promise<void> {
		const renderer = await makeRenderer();
		renderers.push(renderer);
		prepare?.(renderer);

		let overlayCalls = 0;
		let editorContainerAddChildCalls = 0;

		const originalSetOverlay = renderer.ui.setOverlay.bind(renderer.ui);
		const originalAddChild = renderer.editorContainer.addChild.bind(renderer.editorContainer);

		renderer.ui.setOverlay = (component: unknown, options?: unknown) => {
			overlayCalls++;
			originalSetOverlay(component, options);
		};
		renderer.editorContainer.addChild = (component: unknown) => {
			editorContainerAddChildCalls++;
			originalAddChild(component);
		};

		invoke(renderer);

		expect(overlayCalls).toBeGreaterThan(0);
		expect(editorContainerAddChildCalls).toBe(0);
	}

	it("uses the dialog overlay path for model selector", async () => {
		await expectUsesOverlay((renderer) => renderer.showModelSelector());
	});

	it("uses the dialog overlay path for theme selector", async () => {
		await expectUsesOverlay((renderer) => renderer.showThemeSelector());
	});

	it("uses the dialog overlay path for thinking selector", async () => {
		await expectUsesOverlay((renderer) => renderer.showThinkingSelector());
	});

	it("uses the dialog overlay path for queue mode selector", async () => {
		await expectUsesOverlay((renderer) => renderer.showQueueModeSelector());
	});

	it("uses the dialog overlay path for user-message selector", async () => {
		await expectUsesOverlay(
			(renderer) => renderer.showUserMessageSelector(),
			(renderer) => {
				renderer.agent.replaceMessages([
					{ role: "user", content: [{ type: "text", text: "first user" }] },
					{ role: "user", content: [{ type: "text", text: "second user" }] },
				]);
			},
		);
	});

	it("uses the dialog overlay path for a single compacted checkpoint user message", async () => {
		await expectUsesOverlay(
			(renderer) => renderer.showUserMessageSelector(),
			(renderer) => {
				renderer.agent.replaceMessages([
					{
						role: "assistant",
						content: [{ type: "text", text: "Opaque native compacted history" }],
						api: "openai-codex-responses",
						provider: "openai-codex",
						model: "gpt-5.4",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 1,
					},
					{
						role: "user",
						content: [{ type: "text", text: "Compacted checkpoint summary" }],
					},
				]);
			},
		);
	});
});

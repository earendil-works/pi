import type { AgentEvent, AgentState } from "@kennyfrc/mu-agent-core";
import { Agent } from "@kennyfrc/mu-agent-core";
import { getModel } from "@kennyfrc/mu-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/settings-manager.js";
import { initTheme } from "../src/theme/theme.js";
import { TuiRenderer } from "../src/tui/tui-renderer.js";

interface WorkingSnapshot {
	message: string;
	indicator: string;
}

interface RendererHarness {
	stop(): void;
	footer: { transientStatus?: WorkingSnapshot | null };
	handleEvent(event: AgentEvent, state: AgentState): Promise<void>;
	runAskUserDialog(request: {
		mode: "clarify";
		objective: string;
		questions: [
			{
				id: string;
				topic: string;
				prompt: string;
				options: string[];
			},
		];
	}): Promise<{ answers: Array<{ answer: string }> }>;
	activeDialogOverlay: { handleInput(data: string): void } | null;
}

async function makeRenderer(): Promise<{ renderer: RendererHarness; state: AgentState }> {
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
			getSessionId: () => "ask-user-working-freeze-test",
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
	return { renderer: renderer as unknown as RendererHarness, state: agent.state };
}

function readWorkingSnapshot(renderer: RendererHarness): WorkingSnapshot {
	const status = renderer.footer.transientStatus;
	return {
		message: status?.message ?? "",
		indicator: status?.indicator ?? "",
	};
}

function submitDialog(renderer: RendererHarness): void {
	const overlay = renderer.activeDialogOverlay;
	if (!overlay) {
		throw new Error("expected active ask-user dialog overlay");
	}
	// Select first option
	overlay.handleInput("\r");
}

function cancelDialog(renderer: RendererHarness): void {
	const overlay = renderer.activeDialogOverlay;
	if (!overlay) {
		throw new Error("expected active ask-user dialog overlay");
	}
	overlay.handleInput("\x1b");
}

describe("ask-user dialog working status freeze", () => {
	const renderers: RendererHarness[] = [];

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		for (const renderer of renderers.splice(0)) {
			renderer.stop();
		}
	});

	it("freezes and resumes the working footer while ask_user dialog is open", async () => {
		const { renderer, state } = await makeRenderer();
		renderers.push(renderer);

		await renderer.handleEvent({ type: "agent_start" } as AgentEvent, state);
		await vi.advanceTimersByTimeAsync(1100);

		const beforePause = readWorkingSnapshot(renderer);
		expect(beforePause.message).toContain("Working");
		expect(beforePause.message).toContain("1s");

		const dialogPromise = renderer.runAskUserDialog({
			mode: "clarify",
			objective: "Lock down missing validation details",
			questions: [
				{
					id: "surface",
					topic: "Surface",
					prompt: "Which surface should verify the flow?",
					options: ["xtui", "cdp"],
				},
			],
		});

		const paused = readWorkingSnapshot(renderer);
		await vi.advanceTimersByTimeAsync(1200);
		const stillPaused = readWorkingSnapshot(renderer);

		expect(stillPaused).toEqual(paused);

		submitDialog(renderer);
		await expect(dialogPromise).resolves.toMatchObject({
			answers: [{ answer: "xtui" }],
		});

		await vi.advanceTimersByTimeAsync(1100);
		const resumed = readWorkingSnapshot(renderer);
		expect(resumed.message).toContain("Working");
		expect(resumed.message).toContain("2s");
		expect(resumed).not.toEqual(paused);
	});

	it("resumes the working footer after cancelling the ask_user dialog", async () => {
		const { renderer, state } = await makeRenderer();
		renderers.push(renderer);

		await renderer.handleEvent({ type: "agent_start" } as AgentEvent, state);
		await vi.advanceTimersByTimeAsync(1100);

		const dialogPromise = renderer.runAskUserDialog({
			mode: "clarify",
			objective: "Lock down missing validation details",
			questions: [
				{
					id: "surface",
					topic: "Surface",
					prompt: "Which surface should verify the flow?",
					options: ["xtui", "cdp"],
				},
			],
		});

		const paused = readWorkingSnapshot(renderer);
		await vi.advanceTimersByTimeAsync(1200);
		expect(readWorkingSnapshot(renderer)).toEqual(paused);

		cancelDialog(renderer);
		await expect(dialogPromise).rejects.toThrow("ask_user cancelled");

		await vi.advanceTimersByTimeAsync(1100);
		const resumed = readWorkingSnapshot(renderer);
		expect(resumed.message).toContain("Working");
		expect(resumed.message).toContain("2s");
		expect(resumed).not.toEqual(paused);
	});
});

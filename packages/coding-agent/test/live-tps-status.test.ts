import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentEvent } from "@kennyfrc/mu-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, getModel } from "@kennyfrc/mu-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/settings-manager.js";
import { initTheme } from "../src/theme/theme.js";
import { estimateTokens } from "../src/tools/handoff.js";
import { TuiRenderer } from "../src/tui/tui-renderer.js";

interface RendererPrivateView {
	statusContainer: { render(width: number): string[] };
	agent: Agent;
	handleEvent(event: AgentEvent, state: Agent["state"]): Promise<void>;
	agentStartTime: number | null;
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function baseAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "openai",
		model: "gpt-5.1-codex",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createRenderer(baseDir: string): TuiRenderer {
	const agent = new Agent({
		transport: {
			async *run() {
				yield* [];
			},
		} as never,
		initialState: {
			model: getModel("openai", "gpt-5.1-codex"),
		},
	});

	return new TuiRenderer(
		agent,
		{
			loadTitle: () => null,
			getSessionId: () => "test-session",
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
	);
}

function readStatusText(renderer: TuiRenderer, width: number = 120): string {
	const statusContainer = (renderer as unknown as RendererPrivateView).statusContainer;
	return stripAnsi(statusContainer.render(width).join("\n"));
}

async function handleRendererEvent(renderer: TuiRenderer, event: AgentEvent): Promise<void> {
	const rendererView = renderer as unknown as RendererPrivateView;
	await rendererView.handleEvent(event, rendererView.agent.state);
}

describe("working status live TPS", () => {
	let previousCwd: string;
	let previousOpenAiApiKey: string | undefined;
	let repoRoot: string;
	let settingsDir: string;

	beforeEach(() => {
		initTheme("dark");
		previousCwd = process.cwd();
		previousOpenAiApiKey = process.env.OPENAI_API_KEY;

		repoRoot = mkdtempSync(join(tmpdir(), "mu-live-tps-status-"));
		settingsDir = join(repoRoot, ".mu-agent-test");

		mkdirSync(join(repoRoot, ".git"), { recursive: true });
		writeFileSync(join(repoRoot, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
		mkdirSync(settingsDir, { recursive: true });

		process.chdir(repoRoot);
		process.env.OPENAI_API_KEY = "test-openai-key";
	});

	afterEach(() => {
		process.chdir(previousCwd);
		if (previousOpenAiApiKey === undefined) {
			delete process.env.OPENAI_API_KEY;
		} else {
			process.env.OPENAI_API_KEY = previousOpenAiApiKey;
		}
		rmSync(repoRoot, { recursive: true, force: true });
	});

	it("shows 0 tps in the initial working status", async () => {
		const renderer = createRenderer(settingsDir);

		try {
			await handleRendererEvent(renderer, { type: "agent_start" });

			expect(readStatusText(renderer)).toContain("Working (0s • 0 tps • esc to interrupt)");
		} finally {
			renderer.stop();
		}
	});

	it("updates the working status with estimated live TPS while assistant text streams", async () => {
		const renderer = createRenderer(settingsDir);
		const partialText = "hello world";
		const expectedTps = Math.round(estimateTokens(partialText) / 2);

		const assistantStartMessage: AssistantMessage = baseAssistantMessage();
		const assistantStreamingMessage: AssistantMessage = {
			...baseAssistantMessage(),
			content: [{ type: "text", text: partialText }],
		};
		const assistantStreamingEvent: AssistantMessageEvent = {
			type: "text_delta",
			contentIndex: 0,
			delta: partialText,
			partial: assistantStreamingMessage,
		};

		try {
			await handleRendererEvent(renderer, { type: "agent_start" });
			await handleRendererEvent(renderer, { type: "message_start", message: assistantStartMessage });

			(renderer as unknown as RendererPrivateView).agentStartTime = Date.now() - 2_000;

			await handleRendererEvent(renderer, {
				type: "message_update",
				message: assistantStreamingMessage,
				assistantMessageEvent: assistantStreamingEvent,
			});

			expect(readStatusText(renderer)).toContain(`${expectedTps} tps`);
		} finally {
			renderer.stop();
		}
	});
});

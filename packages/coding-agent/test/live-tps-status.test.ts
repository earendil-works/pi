import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentEvent } from "@kennyfrc/mu-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, getModel } from "@kennyfrc/mu-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/settings-manager.js";
import { initTheme } from "../src/theme/theme.js";
import { estimateTokens } from "../src/tools/handoff.js";
import { TuiRenderer } from "../src/tui/tui-renderer.js";

interface RendererPrivateView {
	statusContainer: { render(width: number): string[] };
	chatContainer: { render(width: number): string[] };
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

function readChatText(renderer: TuiRenderer, width: number = 120): string {
	const chatContainer = (renderer as unknown as RendererPrivateView).chatContainer;
	return stripAnsi(chatContainer.render(width).join("\n"));
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
		vi.useFakeTimers();
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
			vi.advanceTimersByTime(2_000);

			await handleRendererEvent(renderer, {
				type: "message_update",
				message: assistantStreamingMessage,
				assistantMessageEvent: assistantStreamingEvent,
			});

			expect(readStatusText(renderer)).toContain(`${expectedTps} tps`);
		} finally {
			renderer.stop();
			vi.useRealTimers();
		}
	});

	it("includes tool call content in the live TPS estimate", async () => {
		vi.useFakeTimers();
		const renderer = createRenderer(settingsDir);
		const toolCallText = 'bash {"command":"echo hi"}';
		const expectedTps = Math.round(estimateTokens(toolCallText) / 2);

		const assistantStartMessage: AssistantMessage = baseAssistantMessage();
		const assistantStreamingMessage: AssistantMessage = {
			...baseAssistantMessage(),
			content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "echo hi" } }],
		};
		const assistantStreamingEvent: AssistantMessageEvent = {
			type: "toolcall_delta",
			contentIndex: 0,
			delta: '{"command":"echo hi"}',
			partial: assistantStreamingMessage,
		};

		try {
			await handleRendererEvent(renderer, { type: "agent_start" });
			await handleRendererEvent(renderer, { type: "message_start", message: assistantStartMessage });
			vi.advanceTimersByTime(2_000);

			await handleRendererEvent(renderer, {
				type: "message_update",
				message: assistantStreamingMessage,
				assistantMessageEvent: assistantStreamingEvent,
			});

			expect(readStatusText(renderer)).toContain(`${expectedTps} tps`);
		} finally {
			renderer.stop();
			vi.useRealTimers();
		}
	});

	it("shows tps in the done label after completion", async () => {
		vi.useFakeTimers();
		const renderer = createRenderer(settingsDir);
		const finalText = "hello world";
		const expectedTps = Math.round(estimateTokens(finalText) / 2);

		const assistantStartMessage: AssistantMessage = baseAssistantMessage();
		const finalAssistantMessage: AssistantMessage = {
			...baseAssistantMessage(),
			content: [{ type: "text", text: finalText }],
		};

		try {
			await handleRendererEvent(renderer, { type: "agent_start" });
			await handleRendererEvent(renderer, { type: "message_start", message: assistantStartMessage });
			vi.advanceTimersByTime(2_000);
			await handleRendererEvent(renderer, { type: "message_end", message: finalAssistantMessage });
			await handleRendererEvent(renderer, { type: "agent_end", messages: [finalAssistantMessage] });

			expect(readChatText(renderer)).toContain(`Done after 2s - ${expectedTps} tps`);
		} finally {
			renderer.stop();
			vi.useRealTimers();
		}
	});

	it("excludes pre-response latency from working and done timing", async () => {
		vi.useFakeTimers();
		const renderer = createRenderer(settingsDir);
		const finalText = "hello world";
		const expectedTps = Math.round(estimateTokens(finalText) / 2);
		const assistantStartMessage: AssistantMessage = baseAssistantMessage();
		const assistantStreamingMessage: AssistantMessage = {
			...baseAssistantMessage(),
			content: [{ type: "text", text: finalText }],
		};
		const assistantStreamingEvent: AssistantMessageEvent = {
			type: "text_delta",
			contentIndex: 0,
			delta: finalText,
			partial: assistantStreamingMessage,
		};

		try {
			await handleRendererEvent(renderer, { type: "agent_start" });
			vi.advanceTimersByTime(5_000);
			expect(readStatusText(renderer)).toContain("Working (0s • 0 tps • esc to interrupt)");

			await handleRendererEvent(renderer, { type: "message_start", message: assistantStartMessage });
			vi.advanceTimersByTime(2_000);
			await handleRendererEvent(renderer, {
				type: "message_update",
				message: assistantStreamingMessage,
				assistantMessageEvent: assistantStreamingEvent,
			});

			expect(readStatusText(renderer)).toContain(`Working (2s • ${expectedTps} tps • esc to interrupt)`);

			await handleRendererEvent(renderer, { type: "message_end", message: assistantStreamingMessage });
			await handleRendererEvent(renderer, { type: "agent_end", messages: [assistantStreamingMessage] });

			expect(readChatText(renderer)).toContain(`Done after 2s - ${expectedTps} tps`);
		} finally {
			renderer.stop();
			vi.useRealTimers();
		}
	});

	it("excludes tool execution and inter-turn waiting from tps timing", async () => {
		vi.useFakeTimers();
		const renderer = createRenderer(settingsDir);
		const firstText = "thinking phase";
		const toolCallText = 'bash {"command":"echo hi"}';
		const finalText = "final answer";
		const totalEstimatedTokens = estimateTokens(`${firstText}\n\n${toolCallText}\n\n${finalText}`);
		const expectedTps = Math.round(totalEstimatedTokens / 4);

		const assistantStartMessage: AssistantMessage = baseAssistantMessage();
		const firstAssistantMessage: AssistantMessage = {
			...baseAssistantMessage(),
			content: [
				{ type: "thinking", thinking: firstText },
				{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "echo hi" } },
			],
		};
		const finalAssistantMessage: AssistantMessage = {
			...baseAssistantMessage(),
			content: [{ type: "text", text: finalText }],
		};

		try {
			await handleRendererEvent(renderer, { type: "agent_start" });

			// First assistant turn: 2s of actual model generation.
			await handleRendererEvent(renderer, { type: "message_start", message: assistantStartMessage });
			vi.advanceTimersByTime(2_000);
			await handleRendererEvent(renderer, {
				type: "message_update",
				message: firstAssistantMessage,
				assistantMessageEvent: {
					type: "toolcall_delta",
					contentIndex: 1,
					delta: '{"command":"echo hi"}',
					partial: firstAssistantMessage,
				},
			});
			await handleRendererEvent(renderer, { type: "message_end", message: firstAssistantMessage });

			// Tool/runtime waiting: should NOT count.
			vi.advanceTimersByTime(7_000);

			// Second assistant turn: another 2s of actual model generation.
			await handleRendererEvent(renderer, { type: "message_start", message: finalAssistantMessage });
			vi.advanceTimersByTime(2_000);
			await handleRendererEvent(renderer, {
				type: "message_update",
				message: {
					...finalAssistantMessage,
					content: [...firstAssistantMessage.content, ...finalAssistantMessage.content],
				},
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 2,
					delta: finalText,
					partial: {
						...finalAssistantMessage,
						content: [...firstAssistantMessage.content, ...finalAssistantMessage.content],
					},
				},
			});
			await handleRendererEvent(renderer, {
				type: "message_end",
				message: {
					...finalAssistantMessage,
					content: [...firstAssistantMessage.content, ...finalAssistantMessage.content],
				},
			});
			await handleRendererEvent(renderer, {
				type: "agent_end",
				messages: [firstAssistantMessage, finalAssistantMessage],
			});

			expect(readChatText(renderer)).toContain(`Done after 4s - ${expectedTps} tps`);
		} finally {
			renderer.stop();
			vi.useRealTimers();
		}
	});
});

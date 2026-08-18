import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai/compat";
import { AgentSession } from "../../src/core/agent-session.ts";
import type { ModelRuntime } from "../../src/core/model-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createTestResourceLoader } from "../utilities.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
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

function send(message: Record<string, unknown>): void {
	process.send?.(message);
}

const [mode, sessionFile, tempDir] = process.argv.slice(2);
if (!mode || !sessionFile || !tempDir) {
	throw new Error("Expected mode, session file, and temp directory");
}

if (mode === "owner") {
	const manager = SessionManager.open(sessionFile);
	const entryId = manager.appendCustomEntry("writer-owner", { pid: process.pid });
	send({ type: "owned", entryId });

	process.on("message", (message) => {
		if (message === "release") {
			manager.dispose();
			send({ type: "released" });
			process.exit(0);
		}
	});
} else if (mode === "contender") {
	const manager = SessionManager.open(sessionFile);
	const entriesBefore = manager.getEntries().length;
	let appendError: string | undefined;
	try {
		manager.appendCustomEntry("contender-append", { pid: process.pid });
	} catch (error) {
		appendError = error instanceof Error ? error.message : String(error);
	}
	const entriesAfterAppend = manager.getEntries().length;

	let providerCalled = false;
	const model = getModel("anthropic", "claude-sonnet-4-5")!;
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: "Test",
			tools: [],
		},
		streamFn: () => {
			providerCalled = true;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = assistantMessage("provider response");
				stream.push({ type: "start", partial: { ...message, content: [] } });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		},
	});

	const modelRuntime = {
		hasConfiguredAuth: () => true,
		checkAuth: async () => ({ type: "api_key", key: "test-key" }),
		isUsingOAuth: () => false,
	} as unknown as ModelRuntime;
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settingsManager: SettingsManager.create(tempDir, tempDir),
		cwd: tempDir,
		modelRuntime,
		resourceLoader: createTestResourceLoader(),
	});

	let promptError: string | undefined;
	try {
		await session.prompt("contender provider turn");
	} catch (error) {
		promptError = error instanceof Error ? error.message : String(error);
	}

	send({
		type: "contender-result",
		appendError,
		entriesBefore,
		entriesAfterAppend,
		promptError,
		providerCalled,
	});
	session.dispose();
	process.exit(0);
} else if (mode === "handoff") {
	const manager = SessionManager.open(sessionFile);
	const entryId = manager.appendCustomEntry("handoff-owner", { pid: process.pid });
	manager.dispose();
	send({ type: "handoff-result", entryId });
	process.exit(0);
} else {
	throw new Error(`Unknown mode: ${mode}`);
}

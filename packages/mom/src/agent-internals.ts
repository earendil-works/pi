export interface AgentRunResult {
	stopReason: string;
	errorMessage?: string;
	fatalInitializationError?: boolean;
}

export interface AgentSessionPromptInternals {
	_baseSystemPrompt: string;
	_rebuildSystemPrompt(toolNames: string[]): string;
	getActiveToolNames(): string[];
	agent: {
		state: {
			systemPrompt: string;
		};
	};
}

export type InputPreflightResult =
	| { action: "continue" }
	| { action: "transform"; text: string; images?: unknown[] }
	| { action: "handled" };

export interface AssistantProgressPart {
	type: string;
	text?: string;
	thinking?: string;
}

export interface AssistantProgressPublisher {
	respond(text: string, shouldLog: boolean): Promise<void>;
	respondInThread(text: string): Promise<void>;
}

export interface AssistantProgressQueue {
	enqueue(fn: () => Promise<void>, errorContext: string): void;
}

function getPromptSessionInternals(session: unknown): AgentSessionPromptInternals {
	const promptSession = session as Partial<AgentSessionPromptInternals>;

	if (
		typeof promptSession._rebuildSystemPrompt !== "function" ||
		typeof promptSession.getActiveToolNames !== "function" ||
		typeof promptSession.agent?.state?.systemPrompt !== "string" ||
		!("_baseSystemPrompt" in promptSession)
	) {
		throw new Error("Unsupported @mariozechner/pi-coding-agent AgentSession shape for mom system-prompt refresh");
	}

	return promptSession as AgentSessionPromptInternals;
}

export function refreshSessionBaseSystemPrompt(session: unknown): void {
	// Intentional narrow private seam: AgentSession.prompt() reads _baseSystemPrompt on every turn
	// when extensions are enabled, so mom must refresh that canonical prompt, not just agent.state.systemPrompt
	const promptSession = getPromptSessionInternals(session);
	const nextBaseSystemPrompt = promptSession._rebuildSystemPrompt(promptSession.getActiveToolNames());
	promptSession._baseSystemPrompt = nextBaseSystemPrompt;
	promptSession.agent.state.systemPrompt = nextBaseSystemPrompt;
}

export function refreshSessionBaseSystemPromptForRun(session: unknown): AgentRunResult | undefined {
	try {
		refreshSessionBaseSystemPrompt(session);
		return undefined;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			stopReason: "error",
			errorMessage: message,
			fatalInitializationError: true,
		};
	}
}

export function getAssistantProgressMessages(
	content: AssistantProgressPart[] | undefined,
	hideThinkingBlock: boolean,
): string[] {
	if (!content) {
		return [];
	}

	const messages: string[] = [];
	if (!hideThinkingBlock) {
		for (const part of content) {
			if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim().length > 0) {
				messages.push(`_${part.thinking}_`);
			}
		}
	}

	for (const part of content) {
		if (part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0) {
			messages.push(part.text);
		}
	}

	return messages;
}

export function enqueueAssistantProgressMessages({
	content,
	hideThinkingBlock,
	clearThinkingTimer,
	queue,
	publisher,
}: {
	content: AssistantProgressPart[] | undefined;
	hideThinkingBlock: boolean;
	clearThinkingTimer: () => void;
	queue: AssistantProgressQueue;
	publisher: AssistantProgressPublisher;
}): void {
	for (const message of getAssistantProgressMessages(content, hideThinkingBlock)) {
		clearThinkingTimer();
		queue.enqueue(() => publisher.respond(message, false), "assistant progress");
	}
}

export async function shortCircuitHandledPreflight(
	preflight: InputPreflightResult,
	flushPendingSlackEffects: () => Promise<void>,
	flushQueue: () => Promise<void>,
): Promise<AgentRunResult | undefined> {
	if (preflight.action !== "handled") {
		return undefined;
	}

	await flushPendingSlackEffects();
	await flushQueue();
	return { stopReason: "handled" };
}

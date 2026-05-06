import type { AgentMessage, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { AgentSessionEvent, SessionStats } from "@mariozechner/pi-coding-agent";

export type PiModel = Model<Api>;

export interface WebSessionSummary {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	created: string;
	modified: string;
	messageCount: number;
	firstMessage: string;
}

export interface WebCommand {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
	path?: string;
	location?: string;
}

export interface WebTool {
	name: string;
	description: string;
	active: boolean;
	source: string;
}

export interface WebState {
	cwd: string;
	agentDir: string;
	diagnostics: Array<{ type: "info" | "warning" | "error"; message: string }>;
	model: PiModel | null;
	availableModels: PiModel[];
	thinkingLevel: ThinkingLevel;
	availableThinkingLevels: ThinkingLevel[];
	isStreaming: boolean;
	isCompacting: boolean;
	isRetrying: boolean;
	isBashRunning: boolean;
	autoRetryEnabled: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	session: {
		id: string;
		name?: string;
		file?: string;
	};
	queue: {
		steering: readonly string[];
		followUp: readonly string[];
	};
	stats: SessionStats;
	messages: AgentMessage[];
	commands: WebCommand[];
	tools: WebTool[];
	sessions: WebSessionSummary[];
	modelFallbackMessage?: string;
}

export interface ChatImageInput {
	data: string;
	mimeType: string;
	name?: string;
}

export interface ChatRequest {
	message: string;
	images?: ChatImageInput[];
	streamingBehavior?: "steer" | "followUp";
}

export type ControlRequest =
	| { action: "abort" }
	| { action: "newSession" }
	| { action: "compact"; customInstructions?: string }
	| { action: "setModel"; provider: string; modelId: string }
	| { action: "cycleModel"; direction?: "forward" | "backward" }
	| { action: "setThinkingLevel"; level: ThinkingLevel }
	| { action: "cycleThinkingLevel" }
	| { action: "setSessionName"; name: string }
	| { action: "switchSession"; sessionPath: string }
	| { action: "setSteeringMode"; mode: "all" | "one-at-a-time" }
	| { action: "setFollowUpMode"; mode: "all" | "one-at-a-time" }
	| { action: "setAutoRetry"; enabled: boolean };

export type ChatStreamEvent =
	| { type: "state"; state: WebState }
	| { type: "preflight"; success: boolean }
	| { type: "agent_event"; event: AgentSessionEvent }
	| { type: "done"; state: WebState }
	| { type: "error"; error: string; state?: WebState };

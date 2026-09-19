import type { ConversationView, ModelRef } from "@earendil-works/pi-agent-core/experimental/pico3";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";

export type AuthPromptRequest = AuthPrompt extends infer Prompt
	? Prompt extends unknown
		? Omit<Prompt, "signal">
		: never
	: never;

export interface MicroModelSummary extends ModelRef {
	name: string;
	contextWindow: number;
	maxTokens: number;
}

export interface MicroProviderAccount {
	id: string;
	name: string;
	authType: "oauth" | "api_key";
	configured: boolean;
	source?: string;
	interactive: boolean;
	methodName?: string;
}

export interface MicroModelsView {
	models: readonly MicroModelSummary[];
	accounts: readonly MicroProviderAccount[];
	refreshing: boolean;
}

export interface MicroAuthView {
	providerId: string;
	providerName: string;
	authType: "oauth" | "api_key";
	notices: readonly AuthEvent[];
	prompt?: { id: string; request: AuthPromptRequest };
}

export interface MicroNotice {
	id: number;
	level: "info" | "warning" | "error";
	message: string;
}

export interface MicroUsageView {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalCost: number;
	lastCacheHitRate?: number;
	contextTokens: number | null;
	contextWindow: number;
	contextPercent: number | null;
}

/** Everything the TUI may render. No live harness, model, storage, or auth objects cross this boundary. */
export interface MicroView {
	session: { id: string; path: string; cwd: string };
	conversation: ConversationView;
	models: MicroModelsView;
	usage: MicroUsageView;
	auth?: MicroAuthView;
	notices: readonly MicroNotice[];
	fatal?: string;
}

export interface MicroViewSource {
	current(): MicroView;
	subscribe(listener: () => void): () => void;
}

/** Local control surface. It deliberately does not expose Pico's Harness or ConversationHandle. */
export interface MicroController {
	prompt(text: string): Promise<void>;
	steer(text: string): Promise<void>;
	followUp(text: string): Promise<void>;
	compact(instructions?: string): Promise<void>;
	abort(): Promise<void>;
	cycleThinking(): Promise<void>;
	setModel(model: ModelRef): Promise<void>;
	refreshModels(): Promise<void>;
	login(providerId: string, authType: "oauth" | "api_key"): Promise<void>;
	replyAuth(requestId: string, answer: string | null): Promise<void>;
	cancelLogin(): Promise<void>;
}

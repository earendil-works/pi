import { type Context, defineService } from "@earendil-works/chord";

export interface AgentPromptImage {
	type: "image";
	data: string;
	mimeType: string;
}

export interface AgentPromptRequest {
	message: string;
	images: AgentPromptImage[] | null;
}

export interface AgentOperationError {
	code: string;
	message: string;
}

/** `operationId` identifies the durable submission of a prompt, or the task of a compaction. */
export type AgentOperationResponse =
	| { accepted: true; operationId: string; error: null }
	| { accepted: false; operationId: null; error: AgentOperationError };

/** `entryId` identifies the durable submission; `cancelQueued()` withdraws it while it is still queued. */
export type AgentQueueResponse =
	| { accepted: true; entryId: string; error: null }
	| { accepted: false; entryId: null; error: AgentOperationError };

/** The settled outcome of a prompt: the answer's text, or why it got none. */
export type AgentPromptResult =
	| { status: "done"; text: string; reason: null }
	| { status: "unanswered"; text: null; reason: string };

export interface AgentCompactionRequest {
	customInstructions: string | null;
}

/** Presentation-safe command facade over the worker-owned root conversation. */
export interface AgentController {
	/** Start a run; rejected with `busy` while one is active. */
	prompt(request: AgentPromptRequest, context: Context): Promise<AgentOperationResponse>;
	/** Steer the active run, or start one when idle. */
	steer(request: AgentPromptRequest, context: Context): Promise<AgentQueueResponse>;
	/** Queue input for after the active run, or start one when idle. */
	followUp(request: AgentPromptRequest, context: Context): Promise<AgentQueueResponse>;
	cancelQueued(
		entryId: string,
		context: Context,
	): Promise<{ outcome: "cancelled" | "already_consumed" | "not_found" }>;
	/** Withdraw queued input and abort the active run and compaction. */
	abort(context: Context): Promise<void>;
	compact(request: AgentCompactionRequest, context: Context): Promise<AgentOperationResponse>;
	/** Wait until the prompt with this `operationId` is answered or settles unanswered. */
	waitForPrompt(operationId: string, context: Context): Promise<AgentPromptResult>;
}

export const AgentController = defineService<AgentController>("pi.agent-controller");

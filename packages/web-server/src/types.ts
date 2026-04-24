import type { AgentEvent, AgentMessage, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";

export type ClientMessage =
	| { type: "create_session"; cwd?: string }
	| { type: "send_message"; sessionId: string; message: string }
	| { type: "abort"; sessionId: string }
	| { type: "set_model"; sessionId: string; provider: string; modelId: string }
	| { type: "get_available_models"; sessionId: string }
	| { type: "set_thinking_level"; sessionId: string; level: ThinkingLevel }
	| { type: "get_state"; sessionId: string };

export type ServerMessage =
	| { type: "session_created"; sessionId: string; state: SessionState }
	| { type: "event"; sessionId: string; event: AgentEvent }
	| { type: "state"; sessionId: string; state: SessionState }
	| { type: "models"; sessionId: string; models: Model<any>[] }
	| { type: "model_set"; sessionId: string; model: Model<any> }
	| { type: "error"; sessionId?: string; message: string }
	| { type: "ack"; sessionId?: string; command: string };

export interface SessionState {
	model?: Model<any>;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	messages: AgentMessage[];
}

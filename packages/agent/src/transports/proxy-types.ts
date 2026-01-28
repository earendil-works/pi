import type { StopReason, Usage } from "@kennyfrc/mu-ai";

/**
 * Event types emitted by the proxy server.
 * The server strips the `partial` field from delta events to reduce bandwidth.
 * Clients reconstruct the partial message from these events.
 */
export type ProxyAssistantMessageEvent =
	| { type: "start" }
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; contentSignature?: string }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "thinking_end"; contentIndex: number; contentSignature?: string }
	| { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number }
	| { type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse">; usage: Usage }
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; errorMessage: string; usage: Usage };

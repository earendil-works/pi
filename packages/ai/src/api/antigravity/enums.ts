// Adapted from pi-antigravity (MIT), Copyright (c) 2026 Rahul Arya.
// See LICENSE in this directory.
export const ThinkingEffort = {
	Off: "off",
	Minimal: "minimal",
	Low: "low",
	Medium: "medium",
	High: "high",
	Xhigh: "xhigh",
} as const;
export type ThinkingEffort = (typeof ThinkingEffort)[keyof typeof ThinkingEffort];

export const ToolChoice = {
	Auto: "auto",
	None: "none",
	Any: "any",
	Required: "required",
} as const;
export type ToolChoice = (typeof ToolChoice)[keyof typeof ToolChoice];

export const GeminiToolCallingMode = {
	None: "NONE",
	Any: "ANY",
	Auto: "AUTO",
	Validated: "VALIDATED",
} as const;
export type GeminiToolCallingMode = (typeof GeminiToolCallingMode)[keyof typeof GeminiToolCallingMode];

export const GeminiRole = {
	User: "user",
	Model: "model",
} as const;
export type GeminiRole = (typeof GeminiRole)[keyof typeof GeminiRole];

export const AntigravityRequestType = {
	Agent: "agent",
} as const;
export type AntigravityRequestType = (typeof AntigravityRequestType)[keyof typeof AntigravityRequestType];

export const AntigravityUserAgent = {
	Antigravity: "antigravity",
} as const;
export type AntigravityUserAgent = (typeof AntigravityUserAgent)[keyof typeof AntigravityUserAgent];

export const StopReason = {
	Stop: "stop",
	Length: "length",
	ToolUse: "toolUse",
	Error: "error",
} as const;
export type StopReason = (typeof StopReason)[keyof typeof StopReason];

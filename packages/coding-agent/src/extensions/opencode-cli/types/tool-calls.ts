export type ParsedToolCall = {
	name: string;
	arguments: Record<string, unknown>;
};

export type ToolCallParseResult =
	| { ok: true; calls: ParsedToolCall[]; cleanedText?: string }
	| {
			ok: false;
			rejection:
				| { reason: "malformed_markers" }
				| { reason: "invalid_payload" }
				| { reason: "incomplete_dsml" }
				| { reason: "unavailable_tool"; toolName: string };
	  };

import type { AssistantMessage, Tool, ToolCall } from "../types.js";
export declare function normalizeToolNameWithTools(name: string, tools: Tool[] | undefined): string;
export declare function upsertToolCallContent(content: AssistantMessage["content"], toolCall: ToolCall): {
    contentIndex: number;
    inserted: boolean;
};
export declare function recoverToolCallFromTextContent(content: AssistantMessage["content"], tools: Tool[] | undefined, normalizeToolName: (name: string) => string, parseArguments: (raw: string | undefined, toolName: string) => Record<string, unknown>): ToolCall | null;
//# sourceMappingURL=tool-call-recovery.d.ts.map
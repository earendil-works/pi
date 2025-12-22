import type { Tool, ToolCall } from "../types.js";
/**
 * Validates tool call arguments against the tool's TypeBox schema
 * @param tool The tool definition with TypeBox schema
 * @param toolCall The tool call from the LLM
 * @returns The validated arguments
 * @throws Error with formatted message if validation fails
 */
export declare function validateToolArguments(tool: Tool, toolCall: ToolCall): any;
//# sourceMappingURL=validation.d.ts.map

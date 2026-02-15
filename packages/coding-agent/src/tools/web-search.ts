import type { AgentTool } from "@kennyfrc/mu-ai";
import {
	createWebSearchTool,
	type WebSearchDetails,
	type webSearchArgsSchema,
} from "../extensions/presets/web-tools.js";
import { getToolDescription } from "../prompts/index.js";

export const webSearchTool: AgentTool<typeof webSearchArgsSchema, WebSearchDetails> = {
	...createWebSearchTool(),
	description: getToolDescription("web_search"),
};

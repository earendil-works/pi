import type { AgentTool } from "@kennyfrc/mu-ai";
import { createFetchTool, type FetchDetails, type fetchArgsSchema } from "../extensions/presets/web-tools.js";
import { getToolDescription } from "../prompts/index.js";

export const fetchTool: AgentTool<typeof fetchArgsSchema, FetchDetails> = {
	...createFetchTool(),
	description: getToolDescription("fetch"),
};

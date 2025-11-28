import type { AgentTool } from "@mariozechner/pi-ai";

export { bashTool } from "./bash.js";
export { editTool } from "./edit.js";
export { findTool } from "./find.js";
export { grepTool } from "./grep.js";
export { lsTool } from "./ls.js";
export { readTool } from "./read.js";
export { writeTool } from "./write.js";

import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { findTool } from "./find.js";
import { grepTool } from "./grep.js";
import { lsTool } from "./ls.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";

// Default tools for full access mode
export const codingTools: AgentTool<any>[] = [readTool, bashTool, editTool, writeTool];

// All available tools (including read-only exploration tools)
export const allTools = {
	read: readTool,
	bash: bashTool,
	edit: editTool,
	write: writeTool,
	grep: grepTool,
	find: findTool,
	ls: lsTool,
};

export type ToolName = keyof typeof allTools;

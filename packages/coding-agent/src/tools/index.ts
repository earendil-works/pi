import type { AgentTool } from "@mariozechner/pi-ai";

export { bashTool } from "./bash.js";
export { editTool } from "./edit.js";
export { findTool } from "./find.js";
export { grepTool } from "./grep.js";
export { listThreadsTool } from "./list-threads.js";
export { lsTool } from "./ls.js";
export { readTool } from "./read.js";
export { readThreadTool } from "./read-thread.js";
export { writeTool } from "./write.js";

import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { findTool } from "./find.js";
import { grepTool } from "./grep.js";
import { listThreadsTool } from "./list-threads.js";
import { lsTool } from "./ls.js";
import { readTool } from "./read.js";
import { readThreadTool } from "./read-thread.js";
import { writeTool } from "./write.js";

// Default tools for full access mode
export const codingTools: AgentTool<any>[] = [readTool, bashTool, editTool, writeTool, listThreadsTool, readThreadTool];

// All available tools (including read-only exploration tools)
export const allTools = {
	read: readTool,
	bash: bashTool,
	edit: editTool,
	write: writeTool,
	grep: grepTool,
	find: findTool,
	ls: lsTool,
	list_threads: listThreadsTool,
	read_thread: readThreadTool,
};

export type ToolName = keyof typeof allTools;

// Note: Tools have heterogeneous parameter schemas; we let TypeScript infer the array type.

export { applyPatchTool } from "./apply-patch.js";
export { bashTool } from "./bash.js";
export { editTool } from "./edit.js";
export { execCommandTool } from "./exec-command.js";
export { fetchTool } from "./fetch.js";
export { globTool } from "./glob.js";
export { grepTool } from "./grep.js";
export { handoffTool } from "./handoff.js";
export { listThreadsTool } from "./list-threads.js";
export { readTool } from "./read.js";
export { readImageTool } from "./read-image.js";
export { readThreadTool } from "./read-thread.js";
export { todoTool } from "./todo.js";
export { todowriteTool } from "./todowrite.js";
export { updatePlanTool } from "./update-plan.js";
export { viewImageTool } from "./view-image.js";
export { webSearchTool } from "./web-search.js";
export { writeTool } from "./write.js";

import { applyPatchTool } from "./apply-patch.js";
import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { execCommandTool } from "./exec-command.js";
import { fetchTool } from "./fetch.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { handoffTool } from "./handoff.js";
import { listThreadsTool } from "./list-threads.js";
import { readTool } from "./read.js";
import { readImageTool } from "./read-image.js";
import { readThreadTool } from "./read-thread.js";
import { todoTool } from "./todo.js";
import { todowriteTool } from "./todowrite.js";
import { updatePlanTool } from "./update-plan.js";
import { viewImageTool } from "./view-image.js";
import { webSearchTool } from "./web-search.js";
import { writeTool } from "./write.js";

// Default tools for full access mode
export const codingTools = [
	readTool,
	bashTool,
	editTool,
	writeTool,
	listThreadsTool,
	readThreadTool,
	readImageTool,
	todoTool,
	handoffTool,
];

// All available tools (tool names are lowercase snake_case)
export const allTools = {
	read: readTool,
	bash: bashTool,
	edit: editTool,
	apply_patch: applyPatchTool,
	write: writeTool,
	grep: grepTool,
	glob: globTool,
	list_threads: listThreadsTool,
	read_thread: readThreadTool,
	read_image: readImageTool,
	todo: todoTool,
	todo_write: todowriteTool,
	handoff: handoffTool,

	// Codex-style minimal tools
	exec_command: execCommandTool,
	view_image: viewImageTool,
	update_plan: updatePlanTool,
	web_search: webSearchTool,
	fetch: fetchTool,
};

export type ToolName = keyof typeof allTools;

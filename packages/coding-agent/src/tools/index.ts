// Note: Tools have heterogeneous parameter schemas; we let TypeScript infer the array type.

export { applyPatchTool } from "./apply-patch.js";
export { bashTool } from "./bash.js";
export { editTool } from "./edit.js";
export { execCommandTool } from "./exec-command.js";
export { globTool } from "./glob.js";
export { grepTool } from "./grep.js";
export { handoffTool } from "./handoff.js";
export { listThreadsTool } from "./list-threads.js";
export { readTool } from "./read.js";
export { readImageTool } from "./read-image.js";
export { readThreadTool } from "./read-thread.js";
export { todowriteTool } from "./todowrite.js";
export { writeTool } from "./write.js";

import { applyPatchTool } from "./apply-patch.js";
import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { execCommandTool } from "./exec-command.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { handoffTool } from "./handoff.js";
import { listThreadsTool } from "./list-threads.js";
import { readTool } from "./read.js";
import { readImageTool } from "./read-image.js";
import { readThreadTool } from "./read-thread.js";
import { todowriteTool } from "./todowrite.js";
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
	todo_write: todowriteTool,
	handoff: handoffTool,

	// Codex-style minimal tools
	exec_command: execCommandTool,
};

export type ToolName = keyof typeof allTools;

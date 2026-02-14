import type { AgentTool } from "@kennyfrc/mu-ai";

export { applyPatchTool } from "./apply-patch.js";
export { applyPatchFreeformTool } from "./apply-patch-freeform.js";
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
export { todoTool } from "./todo.js";
export { todowriteTool } from "./todowrite.js";
export { updatePlanTool } from "./update-plan.js";
export { viewImageTool } from "./view-image.js";
export { writeTool } from "./write.js";

import { applyPatchTool } from "./apply-patch.js";
import { applyPatchFreeformTool } from "./apply-patch-freeform.js";
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
import { todoTool } from "./todo.js";
import { updatePlanTool } from "./update-plan.js";
import { viewImageTool } from "./view-image.js";
import { writeTool } from "./write.js";

// Default tools for full access mode
export const codingTools: AgentTool<any>[] = [
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

// All available tools (TitleCase keys match tool.name)
export const allTools = {
	Read: readTool,
	Bash: bashTool,
	Edit: editTool,
	ApplyPatch: applyPatchTool,
	Write: writeTool,
	Grep: grepTool,
	Glob: globTool,
	ListThreads: listThreadsTool,
	ReadThread: readThreadTool,
	ReadImage: readImageTool,
	Todo: todoTool,
	Handoff: handoffTool,

	// Codex-style minimal tools (snake_case)
	exec_command: execCommandTool,
	apply_patch: applyPatchFreeformTool,
	view_image: viewImageTool,
	update_plan: updatePlanTool,
};

export type ToolName = keyof typeof allTools;

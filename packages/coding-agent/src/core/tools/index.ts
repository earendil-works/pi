export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find.ts";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.ts";
export {
	createLocalPowerShellOperations,
	createPowerShellTool,
	createPowerShellToolDefinition,
	type PowerShellOperations,
	type PowerShellSpawnContext,
	type PowerShellSpawnHook,
	type PowerShellToolDetails,
	type PowerShellToolInput,
	type PowerShellToolOptions,
} from "./powershell.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.ts";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.ts";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import { createPowerShellTool, createPowerShellToolDefinition, type PowerShellToolOptions } from "./powershell.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName = "read" | "bash" | "powershell" | "edit" | "write" | "grep" | "find" | "ls";
export const allToolNames: Set<ToolName> = new Set([
	"read",
	"bash",
	"powershell",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
]);

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	powershell?: PowerShellToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
}

export function createToolDefinition(toolName: ToolName, customCwd?: string, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "read":
			return createReadToolDefinition(customCwd, options?.read);
		case "bash":
			return createBashToolDefinition(customCwd, options?.bash);
		case "powershell":
			return createPowerShellToolDefinition(customCwd, options?.powershell);
		case "edit":
			return createEditToolDefinition(customCwd, options?.edit);
		case "write":
			return createWriteToolDefinition(customCwd, options?.write);
		case "grep":
			return createGrepToolDefinition(customCwd, options?.grep);
		case "find":
			return createFindToolDefinition(customCwd, options?.find);
		case "ls":
			return createLsToolDefinition(customCwd, options?.ls);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, customCwd?: string, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "read":
			return createReadTool(customCwd, options?.read);
		case "bash":
			return createBashTool(customCwd, options?.bash);
		case "powershell":
			return createPowerShellTool(customCwd, options?.powershell);
		case "edit":
			return createEditTool(customCwd, options?.edit);
		case "write":
			return createWriteTool(customCwd, options?.write);
		case "grep":
			return createGrepTool(customCwd, options?.grep);
		case "find":
			return createFindTool(customCwd, options?.find);
		case "ls":
			return createLsTool(customCwd, options?.ls);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createCodingToolDefinitions(customCwd?: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(customCwd, options?.read),
		createBashToolDefinition(customCwd, options?.bash),
		createEditToolDefinition(customCwd, options?.edit),
		createWriteToolDefinition(customCwd, options?.write),
	];
}

export function createReadOnlyToolDefinitions(customCwd?: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(customCwd, options?.read),
		createGrepToolDefinition(customCwd, options?.grep),
		createFindToolDefinition(customCwd, options?.find),
		createLsToolDefinition(customCwd, options?.ls),
	];
}

export function createAllToolDefinitions(customCwd?: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		read: createReadToolDefinition(customCwd, options?.read),
		bash: createBashToolDefinition(customCwd, options?.bash),
		powershell: createPowerShellToolDefinition(customCwd, options?.powershell),
		edit: createEditToolDefinition(customCwd, options?.edit),
		write: createWriteToolDefinition(customCwd, options?.write),
		grep: createGrepToolDefinition(customCwd, options?.grep),
		find: createFindToolDefinition(customCwd, options?.find),
		ls: createLsToolDefinition(customCwd, options?.ls),
	};
}

export function createCodingTools(customCwd?: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(customCwd, options?.read),
		createBashTool(customCwd, options?.bash),
		createEditTool(customCwd, options?.edit),
		createWriteTool(customCwd, options?.write),
	];
}

export function createReadOnlyTools(customCwd?: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(customCwd, options?.read),
		createGrepTool(customCwd, options?.grep),
		createFindTool(customCwd, options?.find),
		createLsTool(customCwd, options?.ls),
	];
}

export function createAllTools(customCwd?: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		read: createReadTool(customCwd, options?.read),
		bash: createBashTool(customCwd, options?.bash),
		powershell: createPowerShellTool(customCwd, options?.powershell),
		edit: createEditTool(customCwd, options?.edit),
		write: createWriteTool(customCwd, options?.write),
		grep: createGrepTool(customCwd, options?.grep),
		find: createFindTool(customCwd, options?.find),
		ls: createLsTool(customCwd, options?.ls),
	};
}

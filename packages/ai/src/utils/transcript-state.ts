import type { SystemMessage, Tool, ToolReference, TranscriptContext } from "../types.ts";
import { getCurrentTools, getInitialTools } from "./normalize-context.ts";

export interface ResolvedTranscriptTools {
	requestTools: Tool[];
	getAdditions(message: SystemMessage): Tool[];
}

export interface ToolStateChanges {
	toolsAdded: Tool[];
	toolsRemoved: ToolReference[];
}

/** Strip executable and display-only fields from a tool before transcript comparison or persistence. */
export function toToolDeclaration(tool: Tool): Tool {
	return {
		name: tool.name,
		description: tool.description,
		parameters: JSON.parse(JSON.stringify(tool.parameters)) as Tool["parameters"],
		...(tool.constrainedSampling === undefined ? {} : { constrainedSampling: tool.constrainedSampling }),
	};
}

function declarationsEqual(left: Tool, right: Tool): boolean {
	return JSON.stringify(toToolDeclaration(left)) === JSON.stringify(toToolDeclaration(right));
}

/** Compare two complete tool states. A changed definition is a removal followed by an addition. */
export function getToolStateChanges(previous: readonly Tool[], current: readonly Tool[]): ToolStateChanges {
	const previousTools = new Map(previous.map((tool) => [tool.name, tool]));
	const currentTools = new Map(current.map((tool) => [tool.name, tool]));
	return {
		toolsAdded: current
			.filter((tool) => {
				const previousTool = previousTools.get(tool.name);
				return previousTool === undefined || !declarationsEqual(previousTool, tool);
			})
			.map(toToolDeclaration),
		toolsRemoved: previous
			.filter((tool) => {
				const currentTool = currentTools.get(tool.name);
				return currentTool === undefined || !declarationsEqual(tool, currentTool);
			})
			.map((tool) => ({ name: tool.name })),
	};
}

/** Every definition referenced by transcript tool state, in first-declaration order. */
export function getDeclaredTools(context: TranscriptContext): Tool[] {
	const definitions = new Map<string, Tool>();
	for (const message of context.messages) {
		if (message.role !== "system") continue;
		for (const tool of message.toolsAdded ?? []) definitions.set(tool.name, tool);
	}
	return [...definitions.values()];
}

/** Whether tool history contains a removal or same-name redeclaration that an addition-only transport cannot replay. */
export function hasNonAdditiveToolChanges(context: TranscriptContext): boolean {
	const declared = new Set<string>();
	for (const message of context.messages) {
		if (message.role !== "system") continue;
		if ((message.toolsRemoved?.length ?? 0) > 0) return true;
		for (const tool of message.toolsAdded ?? []) {
			if (declared.has(tool.name)) return true;
			declared.add(tool.name);
		}
	}
	return false;
}

/** Resolve top-level declarations and native additions directly from transcript system messages. */
export function resolveTranscriptTools(
	context: TranscriptContext,
	supportsToolAdditions: boolean,
): ResolvedTranscriptTools {
	if (!supportsToolAdditions || hasNonAdditiveToolChanges(context)) {
		return { requestTools: getCurrentTools(context), getAdditions: () => [] };
	}

	const requestTools = getInitialTools(context);
	const loadedNames = new Set(requestTools.map((tool) => tool.name));
	return {
		requestTools,
		getAdditions(message) {
			const additions: Tool[] = [];
			for (const tool of message.toolsAdded ?? []) {
				if (loadedNames.has(tool.name)) continue;
				loadedNames.add(tool.name);
				additions.push(tool);
			}
			return additions;
		},
	};
}

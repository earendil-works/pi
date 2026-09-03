import type { Context, SystemMessage, Tool } from "../types.ts";
import { resolveMessageToolChange } from "./system-messages.ts";

type ToolNameNormalizer = (name: string) => string;

const identityToolName: ToolNameNormalizer = (name) => name;

export interface ToolPlacementOptions {
	/** Whether a tool marked on a tool result can load at that result. */
	toolResultMarkers: boolean;
	/** Whether a tool carried by a system message can load at that message. */
	systemMarkers: boolean | ((message: SystemMessage, index: number) => boolean);
	normalizeName?: ToolNameNormalizer;
}

export interface ToolPlacement {
	/**
	 * Tools declared from the first request on. Sorted by normalized name so the
	 * order depends only on the set of names, never on when a tool was removed
	 * or which order the caller listed the active tools in.
	 */
	immediate: Tool[];
	/** Tools that load at a transcript marker, keyed by normalized name, in marker order. */
	deferred: Map<string, Tool>;
}

/** Every tool a request must declare, for transports without deferred loading. */
export function declaredTools(context: Context): Tool[] {
	return splitDeferredTools(context, { toolResultMarkers: false, systemMarkers: false }).immediate;
}

/**
 * Decide which tools a request declares and where each definition loads.
 *
 * The declared set is append-only for the life of a conversation: every tool in
 * `Context.tools` plus every tool a system message added or removed earlier. A
 * removed tool stays declared, because dropping it would change the cached
 * prefix; the transport withdraws it in the transcript or the harness rejects
 * calls to it. Definitions carried by messages win over `Context.tools` so the
 * rendered history does not change when a tool's live definition changes.
 */
export function splitDeferredTools(context: Context, options: ToolPlacementOptions): ToolPlacement {
	const normalizeName = options.normalizeName ?? identityToolName;
	const canAnchorSystemMarker =
		typeof options.systemMarkers === "function" ? options.systemMarkers : () => options.systemMarkers === true;

	const definitions = new Map<string, Tool>();
	for (const message of context.messages) {
		if (message.role !== "system") continue;
		for (const tool of [...(message.toolsRemoved ?? []), ...(message.toolsAdded ?? [])]) {
			const name = normalizeName(tool.name);
			if (!definitions.has(name)) definitions.set(name, tool);
		}
	}
	const activeTools = new Map<string, Tool>();
	for (const tool of context.tools ?? []) activeTools.set(normalizeName(tool.name), tool);
	for (const [name, tool] of activeTools) {
		if (!definitions.has(name)) definitions.set(name, tool);
	}

	const deferred = new Map<string, Tool>();
	const usedNames = new Set<string>();
	const placedImmediate = new Set<string>();
	const placeMarked = (name: string): void => {
		const definition = definitions.get(name);
		if (definition === undefined || deferred.has(name) || placedImmediate.has(name)) return;
		if (usedNames.has(name)) placedImmediate.add(name);
		else deferred.set(name, definition);
	};
	context.messages.forEach((message, index) => {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") usedNames.add(normalizeName(block.name));
			}
			return;
		}
		if (message.role === "toolResult") {
			if (!options.toolResultMarkers) return;
			for (const name of resolveMessageToolChange(message).addedNames) placeMarked(normalizeName(name));
			return;
		}
		if (message.role === "system" && canAnchorSystemMarker(message, index)) {
			for (const tool of message.toolsAdded ?? []) placeMarked(normalizeName(tool.name));
		}
	});

	const immediate = [...definitions]
		.filter(([name]) => !deferred.has(name))
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([, tool]) => tool);
	return { immediate, deferred };
}

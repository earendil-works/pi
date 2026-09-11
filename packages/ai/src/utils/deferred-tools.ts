import type { Context, Message, Tool } from "../types.ts";

export type ToolNameNormalizer = (name: string) => string;

const identityToolName: ToolNameNormalizer = (name) => name;

export interface ToolChange {
	added: Tool[];
	removed: Tool[];
}

export interface ToolHistory {
	/** Initial availability before any transcript transitions. */
	initial: Tool[];
	/** All definitions known anywhere in the context. */
	definitions: Map<string, Tool>;
	/** Tool changes keyed by the transcript message that records them. */
	changes: Map<Message, ToolChange>;
}

/** Resolve initial tools, transcript definitions, and chronological availability changes. */
export function resolveToolHistory(
	context: Context,
	normalizeName: ToolNameNormalizer = identityToolName,
): ToolHistory {
	const definitions = new Map<string, Tool>();
	const initial = new Map<string, Tool>();
	for (const tool of context.tools ?? []) {
		const name = normalizeName(tool.name);
		definitions.set(name, tool);
		initial.set(name, tool);
	}
	for (const message of context.messages) {
		if (message.role !== "system") continue;
		for (const tool of [...(message.toolsAdded ?? []), ...(message.toolsRemoved ?? [])]) {
			const name = normalizeName(tool.name);
			if (!definitions.has(name)) definitions.set(name, tool);
		}
	}

	const changes = new Map<Message, ToolChange>();
	const seen = new Set<string>();
	for (const message of context.messages) {
		if (message.role === "system") {
			const added = message.toolsAdded ?? [];
			const removed = message.toolsRemoved ?? [];
			if (added.length > 0 || removed.length > 0) changes.set(message, { added, removed });
			for (const tool of added) seen.add(normalizeName(tool.name));
		} else if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "toolCall") seen.add(normalizeName(part.name));
			}
		} else if (message.role === "toolResult" && message.addedToolNames) {
			const added: Tool[] = [];
			for (const rawName of message.addedToolNames) {
				const name = normalizeName(rawName);
				const tool = definitions.get(name);
				if (tool && !seen.has(name)) {
					added.push(tool);
					initial.delete(name);
					seen.add(name);
				}
			}
			if (added.length > 0) changes.set(message, { added, removed: [] });
		}
	}

	return { initial: [...initial.values()], definitions, changes };
}

/** All tool definitions known to the context, sorted for stable fallback declarations. */
export function declaredTools(context: Context): Tool[] {
	return [...resolveToolHistory(context).definitions.entries()]
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([, tool]) => tool);
}

export interface ToolPlacementOptions {
	/** Whether a deprecated tool-result marker can load a tool at that result. */
	toolResultMarkers: boolean;
	/** Whether a system transition can load a tool at that message. */
	systemMarkers: boolean;
	normalizeName?: ToolNameNormalizer;
}

export interface ToolPlacement {
	/** Tools declared from the first request on. */
	immediate: Tool[];
	/** Tools that load at a transcript marker, keyed by normalized name, in marker order. */
	deferred: Map<string, Tool>;
}

/** Decide which known definitions are immediate and which can load at transcript markers. */
export function splitDeferredTools(context: Context, options: ToolPlacementOptions): ToolPlacement {
	const normalizeName = options.normalizeName ?? identityToolName;
	const history = resolveToolHistory(context, normalizeName);
	const initialNames = new Set(history.initial.map((tool) => normalizeName(tool.name)));
	const deferred = new Map<string, Tool>();

	for (const message of context.messages) {
		const markerEnabled =
			(message.role === "toolResult" && options.toolResultMarkers) ||
			(message.role === "system" && options.systemMarkers);
		if (!markerEnabled) continue;
		for (const tool of history.changes.get(message)?.added ?? []) {
			const name = normalizeName(tool.name);
			if (!initialNames.has(name) && !deferred.has(name)) deferred.set(name, tool);
		}
	}

	const immediate = [...history.definitions.entries()]
		.filter(([name]) => !deferred.has(name))
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([, tool]) => tool);
	return { immediate, deferred };
}

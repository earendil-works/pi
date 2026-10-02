import type { Context } from "@earendil-works/chord";
import type { Message, SystemMessage, Tool, ToolReference } from "@earendil-works/pi-ai";
import { declarationsEqual, getCurrentTools, toToolDeclaration } from "@earendil-works/pi-ai/utils/transcript";
import { SystemEntry } from "../entries.ts";
import type { ContextEdit, TypedEntryDraft } from "../types.ts";
import type { ContextView, PromptInput, PromptSection, ToolRegistration } from "./types.ts";

/** Sections in effect after replaying system messages in order: set in place, `null` deletes, re-adding appends. */
export function replaySections(messages: readonly Message[]): Map<string, string> {
	const shown = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "system" || message.sections === undefined) continue;
		for (const [key, value] of Object.entries(message.sections)) {
			if (value === null) shown.delete(key);
			else shown.set(key, value);
		}
	}
	return shown;
}

/**
 * Render the agent's sections in order. `undefined` omits a section; tagged text is wrapped as `<key>\n...\n</key>`. A
 * section that throws keeps its shown text, if any, and is reported; errors after `context` is aborted propagate.
 */
export async function renderSections<Tool extends ToolRegistration>(
	sections: readonly PromptSection<Tool>[],
	input: PromptInput<Tool>,
	shown: ReadonlyMap<string, string>,
	report: (error: unknown) => void,
	context: Context,
): Promise<Map<string, string>> {
	const desired = new Map<string, string>();
	for (const section of sections) {
		let text: string | undefined;
		try {
			text = await section.render(input, context);
		} catch (error) {
			if (context.abortSignal?.aborted) throw error;
			report(error);
			const kept = shown.get(section.key);
			if (kept !== undefined) desired.set(section.key, kept);
			continue;
		}
		if (text === undefined) continue;
		desired.set(section.key, section.tag === false ? text : `<${section.key}>\n${text}\n</${section.key}>`);
	}
	return desired;
}

type SystemDraft = TypedEntryDraft<never>;

type ToolChanges = { readonly toolsRemoved: ToolReference[]; readonly toolsAdded: Tool[] };

/**
 * Plan the `pi.system` entries that make the replayed sections and tools of `view` equal `desired` and `tools` in values
 * and order.
 *
 * - A head marker with no later `pi.system` entry in context: one complete baseline that omits every retained earlier
 *   `pi.system` entry, written even when it restates the replayed values.
 * - Otherwise, when a minimal section patch would leave a different order: remove every shown section, then re-add
 *   every desired section in order.
 * - Otherwise the minimal patch of changed values and `null` removals, or nothing.
 *
 * Tool changes ride on the last planned entry, or on one entry of their own.
 */
export function planSystemEntries(
	view: ContextView,
	desired: ReadonlyMap<string, string>,
	tools: readonly Tool[],
	timestamp: number,
): SystemDraft[] {
	const head = view.head;
	if (head !== undefined && !view.entries.some((entry) => SystemEntry.is(entry) && entry.id > head.id)) {
		const edits: ContextEdit[] = view.entries
			.filter((entry) => SystemEntry.is(entry))
			.map((entry) => ({ target: entry.id, action: "omit" }));
		const baseline = systemEntry(
			Object.fromEntries(desired),
			{ toolsRemoved: [], toolsAdded: tools.map(toToolDeclaration) },
			timestamp,
		);
		return [edits.length === 0 ? baseline : { ...baseline, edits }];
	}
	const sections = planSections(replaySections(view.messages), desired);
	const changes = planTools(getCurrentTools(view.messages), tools);
	if (changes.toolsRemoved.length === 0 && changes.toolsAdded.length === 0) {
		return sections.map((patch) => systemEntry(patch, undefined, timestamp));
	}
	if (sections.length === 0) return [systemEntry(undefined, changes, timestamp)];
	return sections.map((patch, index) =>
		systemEntry(patch, index === sections.length - 1 ? changes : undefined, timestamp),
	);
}

/**
 * Tool changes from `offered` to `desired`. A changed declaration is removed and re-added. Replay keeps retained tools
 * in place and appends additions; when that would not yield the desired order, every offered tool is removed and
 * every desired tool re-added in order.
 */
function planTools(offered: readonly Tool[], desired: readonly Tool[]): ToolChanges {
	const wanted = new Map(desired.map((tool) => [tool.name, tool]));
	const kept = offered.filter((tool) => {
		const next = wanted.get(tool.name);
		return next !== undefined && declarationsEqual(tool, next);
	});
	const keptNames = new Set(kept.map((tool) => tool.name));
	const added = desired.filter((tool) => !keptNames.has(tool.name));
	const replayed = [...kept, ...added];
	if (replayed.some((tool, index) => tool.name !== desired[index]!.name)) {
		return {
			toolsRemoved: offered.map((tool) => ({ name: tool.name })),
			toolsAdded: desired.map(toToolDeclaration),
		};
	}
	return {
		toolsRemoved: offered.filter((tool) => !keptNames.has(tool.name)).map((tool) => ({ name: tool.name })),
		toolsAdded: added.map(toToolDeclaration),
	};
}

/** Section patches: none, the minimal patch, or a remove-all/re-add-all pair when the order would differ. */
function planSections(
	shown: ReadonlyMap<string, string>,
	desired: ReadonlyMap<string, string>,
): Record<string, string | null>[] {
	const patchedOrder = [
		...[...shown.keys()].filter((key) => desired.has(key)),
		...[...desired.keys()].filter((key) => !shown.has(key)),
	];
	const desiredOrder = [...desired.keys()];
	if (patchedOrder.some((key, index) => key !== desiredOrder[index])) {
		return [Object.fromEntries([...shown.keys()].map((key) => [key, null])), Object.fromEntries(desired)];
	}

	const patch: Record<string, string | null> = {};
	for (const [key, value] of shown) {
		const next = desired.get(key);
		if (next !== value) patch[key] = next ?? null;
	}
	for (const [key, value] of desired) if (!shown.has(key)) patch[key] = value;
	return Object.keys(patch).length === 0 ? [] : [patch];
}

function systemEntry(
	sections: Record<string, string | null> | undefined,
	tools: ToolChanges | undefined,
	timestamp: number,
): SystemDraft {
	const message: SystemMessage = {
		role: "system",
		content: "",
		...(sections === undefined ? {} : { sections }),
		...(tools === undefined || tools.toolsRemoved.length === 0 ? {} : { toolsRemoved: tools.toolsRemoved }),
		...(tools === undefined || tools.toolsAdded.length === 0 ? {} : { toolsAdded: tools.toolsAdded }),
		timestamp,
	};
	return { model: [message] };
}

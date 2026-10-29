import { copyJson, type Draft } from "@earendil-works/chord";
import { defineDoc } from "../documents.ts";
import { documentRetention, persistWithin } from "../session/session.ts";
import type { ConversationId, ConversationRecord, Tx } from "../types.ts";
import type {
	Agent,
	AgentChange,
	AgentState,
	CompactionPolicy,
	ConversationRetryPolicy,
	Extension,
	HarnessSettings,
	ProgressPolicy,
	PromptSection,
	RegistrySnapshot,
	Settings,
	ToolRegistration,
} from "./types.ts";

export const DEFAULT_RETRY_POLICY: ConversationRetryPolicy = {
	enabled: true,
	maxRetries: 3,
	baseDelayMs: 2000,
	maxAgentDelayMs: 60000,
};

export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
	backgroundTokens: 32768,
};

export const DEFAULT_PROGRESS_POLICY: ProgressPolicy = {
	partialIntervalMs: 100,
	outputIntervalMs: 100,
	persistWithinMs: 1_000,
};

/** The reserved section key of the agent's `instructions`. */
export const INSTRUCTIONS_KEY = "instructions";

/** Built-in agent document; rewindable so forks start from the agent at their fork entry. */
export const AgentDoc = defineDoc<AgentState>({
	kind: "pi.agent",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({}),
	checkpointWhen: () => true,
});

/** Default `settings.contextRetentionMs`: ten minutes. */
const DEFAULT_CONTEXT_RETENTION_MS = 600_000;

/** Default `settings.restartLimit`. */
export const DEFAULT_RESTART_LIMIT = 5;

/** A restart limit as given when it is a number of restarts, `1` or more, rounded down (`Infinity`: no task ends for restarts); else the default. */
function restartLimit(limit: number | undefined): number {
	return typeof limit === "number" && limit >= 1 ? Math.floor(limit) : DEFAULT_RESTART_LIMIT;
}

/** Resolve the host settings: every field over its built-in default, object fields merged. */
export function resolveSettings(settings: HarnessSettings | undefined): Settings {
	const extensions = settings?.extensions;
	return {
		...(extensions === undefined ? {} : { extensions }),
		stream: { ...settings?.stream },
		retry: { ...DEFAULT_RETRY_POLICY, ...settings?.retry },
		compaction: { ...DEFAULT_COMPACTION_POLICY, ...settings?.compaction },
		// Field by field, so an explicitly undefined interval keeps its default.
		progress: {
			partialIntervalMs: settings?.progress?.partialIntervalMs ?? DEFAULT_PROGRESS_POLICY.partialIntervalMs,
			outputIntervalMs: settings?.progress?.outputIntervalMs ?? DEFAULT_PROGRESS_POLICY.outputIntervalMs,
			persistWithinMs: persistWithin(settings?.progress?.persistWithinMs),
		},
		toolExecution: settings?.toolExecution ?? "parallel",
		steeringMode: settings?.steeringMode ?? "one-at-a-time",
		followUpMode: settings?.followUpMode ?? "one-at-a-time",
		contextRetentionMs: settings?.contextRetentionMs ?? DEFAULT_CONTEXT_RETENTION_MS,
		documentRetentionMs: documentRetention(settings?.documentRetentionMs),
		afterFailedRun: settings?.afterFailedRun ?? "keep",
		restartLimit: restartLimit(settings?.restartLimit),
	};
}

/** Apply one change to `pi.agent`: a given field replaces the stored one, `null` clears it, `undefined` changes nothing. */
export async function configure(tx: Tx, conversationId: ConversationId, change: AgentChange): Promise<void> {
	const state = await tx.doc(AgentDoc, conversationId);
	applyChange(state, change);
}

/**
 * `addTools` of a tool round, applied to `tools` and `modelTools`, so the next request offers the tools: an array gets
 * each name it lacks appended, and `{ remove }` loses the names. An unset `tools` already enables every tool, so nothing
 * is written for it. An unset or object `modelTools` also gets each name appended to its `add`, which loads deferred
 * tools and has no effect for others. By name, without the registry: a tool that is not registered now, such as one of
 * an MCP server that is reconnecting, is offered once it is again.
 */
export async function addTools(tx: Tx, conversationId: ConversationId, added: readonly string[]): Promise<void> {
	const state = await tx.doc(AgentDoc, conversationId);
	const tools = state.tools;
	if (Array.isArray(tools)) {
		for (const name of added) if (!tools.includes(name)) tools.push(name);
	} else if (tools?.remove.some((name) => added.includes(name))) {
		state.tools = { remove: tools.remove.filter((name) => !added.includes(name)) };
	}
	const modelTools = state.modelTools;
	if (Array.isArray(modelTools)) {
		for (const name of added) if (!modelTools.includes(name)) modelTools.push(name);
		return;
	}
	// Assigned whole; a document write of an equal value records no change.
	const remove = (modelTools?.remove ?? []).filter((name) => !added.includes(name));
	const add = [...(modelTools?.add ?? [])];
	for (const name of added) if (!add.includes(name)) add.push(name);
	state.modelTools = { ...(remove.length === 0 ? {} : { remove }), add };
}

function applyChange(state: Draft<AgentState>, change: AgentChange): void {
	const set = <K extends keyof AgentState>(key: K, value: AgentState[K] | null | undefined) => {
		if (value === undefined) return;
		if (value === null) delete state[key];
		else state[key] = value as Draft<AgentState>[K];
	};
	set("model", change.model === undefined || change.model === null ? change.model : { ...change.model });
	set("thinkingLevel", change.thinkingLevel);
	const extensions = change.extensions;
	set(
		"extensions",
		extensions === undefined || extensions === null
			? extensions
			: isList(extensions)
				? names(extensions)
				: {
						...(extensions.add === undefined ? {} : { add: names(extensions.add) }),
						...(extensions.remove === undefined ? {} : { remove: names(extensions.remove) }),
					},
	);
	const tools = change.tools;
	set(
		"tools",
		tools === undefined || tools === null ? tools : isList(tools) ? names(tools) : { remove: names(tools.remove) },
	);
	const modelTools = change.modelTools;
	set(
		"modelTools",
		modelTools === undefined || modelTools === null
			? modelTools
			: isList(modelTools)
				? names(modelTools)
				: {
						...(modelTools.remove === undefined ? {} : { remove: names(modelTools.remove) }),
						...(modelTools.add === undefined ? {} : { add: names(modelTools.add) }),
					},
	);
	set("instructions", change.instructions);
	set("cwd", change.cwd);
	const maxTurns = change.maxTurns;
	if (maxTurns !== undefined && maxTurns !== null && !(Number.isSafeInteger(maxTurns) && maxTurns >= 1)) {
		throw new RangeError(`maxTurns must be an integer 1 or more, got ${String(maxTurns)}`);
	}
	set("maxTurns", maxTurns);
}

function isList<T>(value: readonly T[] | object): value is readonly T[] {
	return Array.isArray(value);
}

function names(items: readonly { readonly name: string }[]): string[] {
	return items.map((item) => item.name);
}

/**
 * Built-in part of every Harness commit that creates or forks a conversation, for `pi.agent`: a fork keeps its `asOf`
 * copy; a new task-owned conversation copies the stored agent of its owner task's conversation; a new ownerless one
 * starts empty.
 */
export async function createAgent(tx: Tx, conversation: ConversationRecord): Promise<void> {
	if (conversation.parent !== undefined) return;
	const agent = await tx.doc(AgentDoc, conversation.id);
	if (conversation.owner === undefined) return;
	const owner = await tx.doc(AgentDoc, conversation.owner.conversationId);
	Object.assign(agent, copyJson(owner) as AgentState);
}

/** Handlers of the selected extensions' hooks for a task name, in extension order. */
export function agentHooks(
	agent: Agent,
	taskName: string,
): { readonly extension: string; readonly handlers: object }[] {
	const handlers: { readonly extension: string; readonly handlers: object }[] = [];
	for (const extension of agent.extensions) {
		for (const hook of extension.hooks ?? []) {
			if (hook.task === taskName) handlers.push({ extension: extension.name, handlers: hook.handlers });
		}
	}
	return handlers;
}

/** The extension whose code a section of `agent` runs: the last selected one that provides or wraps it. */
export function sectionExtension(agent: Agent, key: string): string | undefined {
	let found: string | undefined;
	for (const extension of agent.extensions) {
		const provides = extension.sections?.some((section) => section.key === key) === true;
		const wraps = extension.wraps?.some((wrap) => "section" in wrap && wrap.section === key) === true;
		if (provides || wraps) found = extension.name;
	}
	return found;
}

/** The extension whose code a tool of `agent` runs: the last selected one that provides or wraps it. */
export function toolExtension(agent: Agent, name: string): string | undefined {
	let found: string | undefined;
	for (const extension of agent.extensions) {
		const provides = extension.tools?.some((tool) => tool.name === name) === true;
		const wraps = extension.wraps?.some((wrap) => "tool" in wrap && wrap.tool === name) === true;
		if (provides || wraps) found = extension.name;
	}
	return found;
}

/**
 * Resolve an agent from its stored state (absent: every field unset), a registry snapshot, and resolved settings. A
 * wrapper that throws or renames drops its target and is reported; a wrapper without a target does nothing.
 */
export function resolveAgent<Tool extends ToolRegistration>(
	state: Readonly<AgentState> | undefined,
	snapshot: RegistrySnapshot<Tool>,
	settings: Settings,
	/** Gets a wrapper's failure with the name of the wrapper's extension. */
	report: (error: unknown, extension: string) => void,
): Agent<Tool> {
	const extensions = selectExtensions(state?.extensions, snapshot, settings);

	const composed = new Map<string, Tool>();
	for (const extension of extensions) for (const tool of extension.tools ?? []) composed.set(tool.name, tool);
	const sections = new Map<string, PromptSection<Tool>>();
	for (const extension of extensions) {
		for (const section of extension.sections ?? []) sections.set(section.key, section);
	}
	for (const extension of extensions) {
		for (const wrap of extension.wraps ?? []) {
			const wrapReport = (error: unknown) => report(error, extension.name);
			if ("tool" in wrap)
				applyWrap(
					composed,
					wrap.tool,
					(tool) => wrap.wrap(tool),
					(tool) => tool.name,
					wrapReport,
				);
			else
				applyWrap(
					sections,
					wrap.section,
					(section) => wrap.wrap(section),
					(section) => section.key,
					wrapReport,
				);
		}
	}

	const enabled = filterTools([...composed.values()], state?.tools);
	const callableBy = (caller: "model" | "tools") => (tool: Tool) =>
		tool.callers === undefined || tool.callers.includes(caller);
	const modelCallable = enabled.filter(callableBy("model"));
	const tools = offeredTools(modelCallable, state?.modelTools);
	const offered = new Set(tools);
	const deferred = modelCallable.filter((tool) => tool.deferred === true && !offered.has(tool));
	const callable = enabled.filter(callableBy("tools"));

	const instructions = state?.instructions;
	const agentSections = [...sections.values()];
	if (instructions !== undefined) agentSections.push({ key: INSTRUCTIONS_KEY, render: () => instructions });

	const agent: Agent<Tool> = {
		...(state?.model === undefined ? {} : { model: state.model }),
		thinkingLevel: state?.thinkingLevel ?? "off",
		extensions,
		tools,
		callable,
		deferred,
		sections: agentSections,
		...(instructions === undefined ? {} : { instructions }),
		...(state?.cwd === undefined ? {} : { cwd: state.cwd }),
		...(state?.maxTurns === undefined ? {} : { maxTurns: state.maxTurns }),
	};
	return agent;
}

/** The tools offered to the model, as `AgentState.modelTools` describes. */
function offeredTools<Tool extends ToolRegistration>(tools: Tool[], filter: AgentState["modelTools"]): Tool[] {
	if (Array.isArray(filter)) return filterTools(tools, filter);
	const removed = new Set(filter?.remove ?? []);
	const kept = tools.filter((tool) => tool.deferred !== true && !removed.has(tool.name));
	// Loaded deferred tools follow in load order, so loading one appends to the declared tools.
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	const loaded = [...new Set(filter?.add ?? [])].flatMap((name) => {
		const tool = byName.get(name);
		return tool?.deferred === true && !removed.has(name) ? [tool] : [];
	});
	return [...kept, ...loaded];
}

/** `tools` through a stored filter: an array selects exactly its names, in its order; `{ remove }` drops names. */
function filterTools<Tool extends ToolRegistration>(tools: Tool[], filter: AgentState["tools"]): Tool[] {
	if (filter === undefined) return tools;
	if (Array.isArray(filter)) {
		const byName = new Map(tools.map((tool) => [tool.name, tool]));
		return [...new Set(filter)].flatMap((name) => {
			const tool = byName.get(name);
			return tool === undefined ? [] : [tool];
		});
	}
	const removed = new Set((filter as { remove: string[] }).remove);
	return tools.filter((tool) => !removed.has(tool.name));
}

/** Selected installed extensions: the stored array, or the default selection edited by `{ add, remove }`. */
function selectExtensions<Tool extends ToolRegistration>(
	stored: AgentState["extensions"],
	snapshot: RegistrySnapshot<Tool>,
	settings: Settings,
): Extension<Tool>[] {
	let selected: string[];
	if (Array.isArray(stored)) selected = stored;
	else {
		const base = settings.extensions?.map((extension) => extension.name) ?? snapshot.installed().map((e) => e.name);
		const edit = stored as { add?: string[]; remove?: string[] } | undefined;
		const removed = new Set(edit?.remove ?? []);
		selected = [...base, ...(edit?.add ?? [])].filter((name) => !removed.has(name));
	}
	const extensions: Extension<Tool>[] = [];
	for (const name of new Set(selected)) {
		const extension = snapshot.extension(name);
		if (extension !== undefined) extensions.push(extension);
	}
	return extensions;
}

function applyWrap<T>(
	items: Map<string, T>,
	target: string,
	wrap: (item: T) => T,
	nameOf: (item: T) => string,
	report: (error: unknown) => void,
): void {
	const item = items.get(target);
	if (item === undefined) return;
	try {
		const wrapped = wrap(item);
		if (nameOf(wrapped) !== target) throw new Error(`Wrapper renamed ${target} to ${nameOf(wrapped)}`);
		items.set(target, wrapped);
	} catch (error) {
		items.delete(target);
		report(error);
	}
}

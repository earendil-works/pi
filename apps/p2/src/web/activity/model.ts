// A turn's activity: what the agent did between a person's message and its answer. Derived from the transcript's
// items: `chatItems` keeps each response's thinking and text in the transcript, in their order, and turns each run of
// consecutive tool calls into an activity item (a wheel in the chat, expandable steps in the right-hand panel). A turn's last text is its
// answer, followed by the results meant for the person (artifacts, sent files, opened ports). A result its tool shows
// in place (an inline artifact) comes right after its call instead, splitting the run of calls around it. How much of
// that shows in the transcript, and how much goes on the wheels, is settings.json's `detail` (`Detail`).
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ComponentType } from "react";
import type { Item, NestedCall, ToolView } from "../transcript.ts";

export type StepStatus = "running" | "done" | "error";
/** One tool call of an activity. */
export type Step = { id: string; tool: ToolView; status: StepStatus };
/**
 * How much of a turn the transcript shows (settings.json `detail`), the rest on its wheels:
 * 1. only the answer and its results; the turn's thinking, texts and calls on one wheel;
 * 2. the agent's texts between its calls too; thinking and calls on a wheel between them (the default);
 * 3. thinking too, collapsed to a line; only runs of calls on wheels;
 * 4. thinking in full, and each call as its own row: no wheels.
 */
export type Detail = 1 | 2 | 3 | 4;
/** Owner decision: 2 (texts in the transcript, thinking and calls on wheels between them). */
export const DEFAULT_DETAIL: Detail = 2;
/** A thinking block or a text on a wheel (detail 1 and 2). */
export type Words = { kind: "thought" | "text"; id: string; text: string; live: boolean };
/** What a wheel rolls through, in order: its tool calls, and at detail 1 and 2 thinking (and texts) among them. */
export type WheelEntry = { kind: "call"; step: Step } | Words;

/** The latest thought above a working wheel's non-thinking step; never repeat the thought currently on the wheel. */
export function thoughtPreview(entries: readonly WheelEntry[], working: boolean, thought?: string): string | undefined {
	if (!working || entries.at(-1)?.kind === "thought") return;
	return entries.findLast((entry): entry is Words => entry.kind === "thought")?.text ?? thought;
}

/** The items the chat shows: the transcript's people, markers and failures, and each turn's parts in order. */
export type ChatItem =
	| Exclude<Item, { type: "assistant" } | { type: "tool" }>
	| {
			type: "activity";
			key: string;
			/** The run's tool calls. */
			steps: Step[];
			/** At detail 1 and 2: everything on the wheel in order, thinking (and texts) among the calls. */
			entries?: WheelEntry[];
			/** The active turn's latest thought, including one before a note that split the wheels. */
			thought?: string;
			/** At detail 4: the calls as rows, one each, not a wheel. */
			rows?: true;
			/** The agent is still at it: the row is a ticker, not a summary. */
			working: boolean;
			/** The responses whose calls it shows, for a search hit on one of them. */
			entryIds?: number[];
			/** When the run began (the response with its first call) and, once done, ended, in ms. */
			startedAt?: number;
			endedAt?: number;
	  }
	| {
			/** A thinking block, collapsed to one line in place. */
			type: "thought";
			key: string;
			entryId?: number;
			text: string;
			/** Still streaming: "Thinking…". */
			live: boolean;
			/** At detail 4: open, in full. */
			full?: true;
	  }
	| {
			/** The agent's text between its calls, as prose; the turn's last text is its answer instead. */
			type: "text";
			key: string;
			entryId?: number;
			text: string;
	  }
	| {
			type: "answer";
			key: string;
			/** The entry with the answer: for Reply. */
			entryId?: number;
			text: string;
			/** The response it ends: for a stop, an error or the length limit below it. */
			message: AssistantMessage;
			streaming: boolean;
	  }
	| {
			type: "results";
			key: string;
			/**
			 * Calls whose result is for the person: an artifact, a sent file, an opened port. After the answer, those of
			 * the whole turn; in place, the one call before it (`ToolActivity.hasResult` says which).
			 */
			tools: ToolView[];
	  };

const toolStatus = (tool: ToolView): StepStatus =>
	tool.status === "error" || tool.status === "interrupted" ? "error" : tool.status === "done" ? "done" : "running";

type Response = Extract<Item, { type: "assistant" }>;
/** A run of consecutive tool calls, with the responses that made them (for its time). */
type Calls = { type: "calls"; key: string; steps: Step[]; from: Response[]; entries?: WheelEntry[] };
/** A result shown in place, right after its call. */
type InPlace = Extract<ChatItem, { type: "results" }>;
type Part = Calls | InPlace | Extract<ChatItem, { type: "thought" | "text" }>;

/** Calls with the nested calls their tools' contributions give, by table: the same call keeps its object. */
const withNested = new WeakMap<ToolActivityTable, WeakMap<ToolView, ToolView>>();

/**
 * A call with its own calls as its tool's contribution reads them (`ToolActivity.nestedCalls`: a script's final list
 * from its result), else as Durable showed them (`tool.calls`).
 */
export function resolveNested(tool: ToolView, tools: ToolActivityTable): ToolView {
	const own = tools.get(tool.name)?.nestedCalls;
	if (!own) return tool;
	const resolved = withNested.get(tools) ?? new WeakMap<ToolView, ToolView>();
	withNested.set(tools, resolved);
	let made = resolved.get(tool);
	if (!made) {
		const calls = own(tool);
		if (calls === tool.calls) made = tool;
		else {
			const { calls: _, ...rest } = tool;
			made = calls ? { ...rest, calls } : rest;
		}
		resolved.set(tool, made);
	}
	return made;
}

const stepOf = (tool: ToolView, tools: ToolActivityTable): Step => {
	const resolved = resolveNested(tool, tools);
	return { id: tool.id, tool: resolved, status: toolStatus(resolved) };
};

/**
 * A run of responses as its parts in order: thinking, text, runs of calls (results whose call is outside the loaded
 * window join them) and results shown in place, each after its call, ending its run of calls. A run of calls that
 * comes first, or right after a result in place, is keyed by what came before it (`after`, the result), so its wheel
 * is the same row as the one that waited for it.
 */
function partsOf(run: readonly Item[], live: boolean, after: string, tools: ToolActivityTable): Part[] {
	const parts: Part[] = [];
	const calls = (key: string, from?: Response): Calls => {
		const last = parts.at(-1);
		if (last?.type === "calls") {
			if (from && last.from.at(-1) !== from) last.from.push(from);
			return last;
		}
		const made: Calls = {
			type: "calls",
			key: !last ? `activity:${after}` : last.type === "results" ? `activity:${last.key}` : key,
			steps: [],
			from: from ? [from] : [],
		};
		parts.push(made);
		return made;
	};
	const call = (key: string, tool: ToolView, from?: Response) => {
		const step = stepOf(tool, tools);
		calls(key, from).steps.push(step);
		if (placement(step.tool, tools) === "inline")
			parts.push({ type: "results", key: `results:${tool.id}`, tools: [step.tool] });
	};
	for (const item of run) {
		if (item.type === "tool") {
			call(`activity:${item.key}`, item.tool);
			continue;
		}
		if (item.type !== "assistant") continue;
		const tools = new Map(item.tools.map((tool) => [tool.id, tool]));
		const last = item.message.content.length - 1;
		const entry = item.entryId === undefined ? {} : { entryId: item.entryId };
		for (const [index, part] of item.message.content.entries()) {
			const key = `${item.key}:${index}`;
			if (part.type === "thinking" && part.thinking.trim()) {
				const thinking = item.streaming && live && index === last;
				const before = parts.at(-1);
				// Thinking right after thinking (nothing shown between them) is one thought: its texts in order.
				if (before?.type === "thought")
					parts[parts.length - 1] = {
						...before,
						text: `${before.text}\n\n${part.thinking}`,
						live: thinking,
					};
				else parts.push({ type: "thought", key: `thought:${key}`, ...entry, text: part.thinking, live: thinking });
			} else if (part.type === "text" && part.text.trim())
				parts.push({ type: "text", key: `text:${key}`, ...entry, text: part.text });
			else if (part.type === "toolCall") {
				const tool = tools.get(part.id) ?? {
					id: part.id,
					name: part.name,
					args: part.arguments ?? {},
					status: "pending" as const,
					output: "",
					images: [],
				};
				call(`activity:${key}`, tool, item);
			}
		}
	}
	return parts;
}

/** A run of calls as its wheel: live while it is the turn's last part and the agent works. */
function activityOf(calls: Calls, responses: readonly Response[], working: boolean): ChatItem {
	const first = calls.from[0];
	const last = calls.from.at(-1);
	const startedAt = first?.message.timestamp;
	// Done: when the next response began, or the last response's calls ended.
	const next = last ? responses[responses.indexOf(last) + 1] : undefined;
	const endedAt =
		working || !last
			? undefined
			: (next?.message.timestamp ??
				last.message.timestamp + last.tools.reduce((sum, each) => sum + (each.durationMs ?? 0), 0));
	const entryIds = calls.from.flatMap((item) => (item.entryId === undefined ? [] : [item.entryId]));
	return {
		type: "activity",
		key: calls.key,
		steps: calls.steps,
		working,
		entryIds,
		...(startedAt ? { startedAt } : {}),
		...(startedAt && endedAt ? { endedAt } : {}),
	};
}

/**
 * A run's chat items: its thinking, texts and runs of calls in order, the answer (its last text, when nothing came
 * after it), the results. `after`: the key of the item before the run.
 */
function runItems(
	run: readonly Item[],
	working: boolean,
	after: string,
	tools: ToolActivityTable,
	detail: Detail,
): ChatItem[] {
	const first = run[0]!;
	let parts = partsOf(run, working, after, tools);
	// At detail 1 the turn has one wheel: results meant to show in place join those after the answer (still drawn in
	// full there), rather than splitting it.
	if (detail === 1) parts = parts.filter((part) => part.type !== "results");
	const responses = run.filter((item): item is Response => item.type === "assistant");
	const response = responses.at(-1);
	const last = parts.at(-1);
	// The run's last text is its answer, when nothing came after it. At detail 1 only once the run is over: while the
	// agent works a text may still turn out to be a note (a call follows), so it stays on the wheel until then, and the
	// answer arrives in the transcript once, when the agent stopped (the row fades in, as new rows do).
	const answer = last?.type === "text" && !(detail === 1 && working) ? last : undefined;
	if (answer) parts.pop();
	const thought = parts.findLast((part) => part.type === "thought");
	// What goes on the wheels with the calls (detail 1: thinking and texts; 2: thinking), merged into them.
	if (detail <= 2) parts = wheels(parts, responses, after, detail === 1 ? ["thought", "text"] : ["thought"]);
	const final = parts.at(-1);
	const notice =
		response && ["error", "aborted", "length"].includes(response.message.stopReason) && !response.streaming;
	const items: ChatItem[] = parts.map((part) =>
		part.type === "calls"
			? {
					...activityOf(part, responses, working && !answer && part === final),
					...(part.entries ? { entries: part.entries } : {}),
					...(detail <= 2 && working && !answer && part === final && thought ? { thought: thought.text } : {}),
					...(detail === 4 ? { rows: true as const } : {}),
				}
			: part.type === "thought" && detail === 4
				? { ...part, full: true as const }
				: part,
	);
	// Working on a response that shows nothing yet (the first, or the next after a result in place): the activity row,
	// waiting.
	if (working && !answer && (!final || final.type === "results"))
		items.push({
			type: "activity",
			key: `activity:${final ? final.key : after}`,
			steps: [],
			working: true,
			...(detail <= 2 && thought ? { thought: thought.text } : {}),
		});
	if (response && (answer || notice))
		items.push({
			type: "answer",
			// The answer is its text's row: a text that turns out not to be the last (a call follows) keeps its row.
			key: answer?.key ?? `answer:${response.key}`,
			...(response.entryId !== undefined ? { entryId: response.entryId } : {}),
			text: answer?.text ?? "",
			message: response.message,
			streaming: response.streaming,
		});
	const results = parts.flatMap((part) =>
		part.type === "calls"
			? part.steps.flatMap((step) => {
					const where = placement(step.tool, tools);
					return where === "after" || (where === "inline" && detail === 1) ? [step.tool] : [];
				})
			: [],
	);
	if (results.length) items.push({ type: "results", key: `results:${first.key}`, tools: results });
	return items;
}

/**
 * Parts with the thinking or texts of `kinds` merged into the runs of calls around them: each stretch between the
 * parts that stay in the transcript is one wheel, keyed by its first part (the turn's first by the item before the run,
 * `after`, as the wheel that waited for it), timed by the responses of its calls and thinking.
 */
function wheels(
	parts: readonly Part[],
	responses: readonly Response[],
	after: string,
	kinds: readonly ("thought" | "text")[],
): Part[] {
	const merged: Part[] = [];
	for (const part of parts) {
		// A result in place, or what this level keeps in the transcript, stands between wheels.
		if (part.type === "results" || (part.type !== "calls" && !kinds.includes(part.type))) {
			merged.push(part);
			continue;
		}
		let wheel = merged.at(-1);
		if (wheel?.type !== "calls") {
			// After a result in place, the wheel is the row that waited there (`activity:<result>`), as a run of calls is.
			const key = !wheel
				? `activity:${after}`
				: part.type === "calls"
					? part.key
					: wheel.type === "results"
						? `activity:${wheel.key}`
						: `activity:${part.key}`;
			wheel = { type: "calls", key, steps: [], from: [], entries: [] };
			merged.push(wheel);
		}
		const from =
			part.type === "calls" ? part.from : responses.filter((response) => response.entryId === part.entryId);
		for (const response of from) if (!wheel.from.includes(response)) wheel.from.push(response);
		if (part.type === "calls") {
			wheel.steps.push(...part.steps);
			wheel.entries?.push(...part.steps.map((step): WheelEntry => ({ kind: "call", step })));
		} else
			wheel.entries?.push({
				kind: part.type,
				id: part.key,
				text: part.text,
				live: part.type === "thought" && part.live,
			});
	}
	// In the responses' order: the first and last time the wheel.
	for (const part of merged)
		if (part.type === "calls") part.from.sort((a, b) => responses.indexOf(a) - responses.indexOf(b));
	return merged;
}

/** A run's items, kept while its members and state are the same, so unchanged rows keep their identity. */
const runs = new WeakMap<
	Item,
	{ members: readonly Item[]; working: boolean; tools: ToolActivityTable; detail: Detail; items: ChatItem[] }
>();

/** The items made last, by key, for keeping the ones a rebuilt run shows the same (the newest `RECENT`). */
const recent = new Map<string, ChatItem>();
const RECENT = 2_000;

/** Whether two calls show the same: the same tool view, or one with the same state (a streaming call rebuilt). */
const sameTool = (one: ToolView, other: ToolView): boolean =>
	one === other ||
	(one.id === other.id &&
		one.name === other.name &&
		one.status === other.status &&
		one.output === other.output &&
		one.details === other.details &&
		one.durationMs === other.durationMs &&
		one.calls === other.calls &&
		one.images.length === other.images.length &&
		one.images.every((image, index) => image === other.images[index]) &&
		JSON.stringify(one.args) === JSON.stringify(other.args));

/** Whether two steps show the same: the same call in the same state. */
const sameStep = (step: Step, same: Step): boolean =>
	step.id === same.id && step.status === same.status && sameTool(step.tool, same.tool);

/** Whether two wheel entries (detail 1 and 2) show the same: the same step, or the same words in the same state. */
function sameEntry(entry: WheelEntry, same: WheelEntry): boolean {
	if (entry.kind === "call") return same.kind === "call" && sameStep(entry.step, same.step);
	return same.kind === entry.kind && same.id === entry.id && same.text === entry.text && same.live === entry.live;
}

const sameValue = (one: unknown, other: unknown): boolean =>
	one === other ||
	(Array.isArray(one) &&
		Array.isArray(other) &&
		one.length === other.length &&
		one.every((value, index) => {
			const that: unknown = other[index];
			if (value === that) return true;
			if (!value || !that || typeof value !== "object" || typeof that !== "object") return false;
			// An entry on a wheel (detail 1 and 2).
			if ("kind" in value && "kind" in that) return sameEntry(value as WheelEntry, that as WheelEntry);
			// A step: the same call in the same state.
			if ("tool" in value && "tool" in that) return sameStep(value as Step, that as Step);
			if ("id" in value && "id" in that) return sameTool(value as ToolView, that as ToolView);
			return false;
		}));

/** Whether an item rebuilt shows the same as before: then the earlier object stays, and its row does not render. */
function sameItem(one: ChatItem, other: ChatItem): boolean {
	if (one.type !== other.type || one.key !== other.key) return false;
	const keys = Object.keys(one) as (keyof ChatItem)[];
	return (
		keys.length === Object.keys(other).length &&
		keys.every((key) => sameValue(one[key], other[key as keyof typeof other]))
	);
}

/**
 * Whether a run's own entries say it is not over: a response still streaming or one that asked for calls (the next
 * one has not come), or a call without its result.
 */
function unfinished(run: readonly Item[]): boolean {
	const last = run.findLast((item) => item.type === "assistant");
	if (!last || last.type !== "assistant") return false;
	return (
		last.streaming ||
		last.message.stopReason === "toolUse" ||
		last.tools.some((tool) => tool.status === "pending" || tool.status === "running")
	);
}

/**
 * The chat's items: the agent's responses between two people's messages (or markers and failures) become one run,
 * shown as its thinking, texts and runs of calls in order, its answer and its results. `working`: the agent is at it,
 * so the last run is live. `known`: whether `working` comes from the server's live state; until it does (the
 * transcript kept on this device), a last run whose entries say it is not over shows as live rather than finished.
 * `tools`: the tools' contributions, which say which calls made results for the person. `detail`: how much of a turn
 * shows in the transcript (settings.json `detail`).
 */
export function chatItems(
	items: readonly Item[],
	working: boolean,
	known: boolean,
	tools: ToolActivityTable,
	detail: Detail = DEFAULT_DETAIL,
): ChatItem[] {
	const result: ChatItem[] = [];
	let run: Item[] = [];
	let after = "start";
	const flush = (last: boolean) => {
		const live = last && (working || (!known && unfinished(run)));
		// Working before the first response: the activity row, waiting.
		if (!run.length) {
			if (live) result.push({ type: "activity", key: `activity:${after}`, steps: [], working: true });
			return;
		}
		const cached = runs.get(run[0]!);
		if (
			cached &&
			cached.working === live &&
			cached.tools === tools &&
			cached.detail === detail &&
			cached.members.length === run.length &&
			cached.members.every((item, index) => item === run[index])
		)
			result.push(...cached.items);
		else {
			// A member changed (a streaming delta, a result): the run's items are made again, and those that show the same
			// as before stay the same objects. Found by key: a streaming response is a new object at every delta.
			const made = runItems(run, live, after, tools, detail).map((item) => {
				const before = recent.get(item.key);
				const kept = before && sameItem(before, item) ? before : item;
				recent.delete(item.key);
				recent.set(item.key, kept);
				return kept;
			});
			for (const key of recent.keys()) {
				if (recent.size <= RECENT) break;
				recent.delete(key);
			}
			runs.set(run[0]!, { members: run, working: live, tools, detail, items: made });
			result.push(...made);
		}
		run = [];
	};
	for (const item of items) {
		if (item.type === "assistant" || item.type === "tool") {
			run.push(item);
			continue;
		}
		flush(false);
		result.push(item);
		after = item.key;
	}
	flush(true);
	return result;
}

/** A value when it is a string, else "": tools' arguments and details are JSON. */
export const stringOf = (value: unknown): string => (typeof value === "string" ? value : "");

/** A call's details as a record ({} without any). */
export const detailsOf = (tool: ToolView): Record<string, unknown> =>
	tool.details && typeof tool.details === "object" && !Array.isArray(tool.details) ? tool.details : {};

/** A file path's last part: `src/a.ts` is `a.ts`. */
export const fileName = (path: string): string => path.split("/").filter(Boolean).at(-1) ?? path;

/** A text's first non-empty line, trimmed. */
export const firstLine = (text: string): string =>
	text
		.split("\n")
		.find((line) => line.trim())
		?.trim() ?? "";

/** A text's last line, trimmed: a command's result. */
export const lastLine = (text: string): string | undefined => text.trimEnd().split("\n").at(-1)?.trim();

/** Markdown as plain words, for a one-line title: code spans, emphasis and links lose their markers. */
export const plainText = (text: string): string =>
	text
		.replace(/`([^`]*)`/g, "$1")
		.replace(/(\*\*|__|\*|_)(\S[^*_]*?)\1/g, "$2")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

/** The first sentence of a text, for a one-line description. */
export const sentence = (text: string): string => {
	const line = firstLine(text);
	const end = line.search(/[.!?](\s|$)/);
	return end > 0 ? line.slice(0, end + 1) : line;
};

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The kind of work a step is, for its icon: the activity's vocabulary, which tools pick from. */
export type Kind =
	| "command"
	| "search"
	| "read"
	| "edit"
	| "script"
	| "agent"
	| "artifact"
	| "file"
	| "port"
	| "message"
	| "handoff"
	| "tool";
/** A step's words: a verb and what it acted on, styled by what that is (a file, a command, the agent's words). */
export type Label = { kind: Kind; verb?: string; object?: string; style?: "file" | "code" | "words"; extra?: string };
/** A step for the sheet: its label in the past tense and, if there is more to say, a description. */
export type Described = { label: Label; description?: string; mono?: boolean };

/**
 * How a tool's calls show in the chat, contributed by the plugin that owns the tool (`ToolActivities`, keyed by tool
 * name). Every part is optional; a tool without a contribution, or a part left out, gets the generic one: the tool's
 * name and its first short string argument, a generic icon, its input as JSON and its output.
 */
export type ToolActivity = {
	/** The call's words in the past tense ("Ran npm test"), and a description (its result, why it failed). */
	describe?: (step: Step) => Described;
	/** Its words while it runs ("Running npm test"); without it, `describe`'s. */
	running?: (step: Step) => Label;
	/** Its main argument for its row in the sheet (`cwd`: the session's working directory, for relative paths). */
	argument?: (tool: ToolView, cwd: string | undefined) => string;
	/** How a failed call's row says it failed ("exit 1"); without it, "failed". */
	failure?: (tool: ToolView) => string | undefined;
	/**
	 * What a finished run's summary says for `count` of these calls ("ran a command", "ran 3 commands"). Tools that
	 * share the function count together (write and edit: "edited 2 files").
	 */
	summary?: (count: number) => string;
	/**
	 * Whether a call made something for the person, shown by `Result`, and where: after the turn's answer (an artifact's
	 * card, a sent file, an opened port), or in place, right after the call (an artifact the agent asked to show
	 * inline: the run of calls splits around it). `false` or absent: nothing.
	 */
	hasResult?: (tool: ToolView) => ResultPlacement | false;
	/** The call's inline detail; `NestedCalls` expands the calls it made in place. */
	Detail?: ComponentType<{ step: Step }>;
	/**
	 * The calls this call made to other tools (a script's), when its tool keeps their final list in its result's
	 * `details`: read from there once settled. `tool.calls` holds the ones Durable shows (live, or the last seen); return
	 * it, or a list built from it, otherwise. Without it, `tool.calls`.
	 */
	nestedCalls?: (tool: ToolView) => readonly NestedCall[] | undefined;
	/**
	 * How an entry of this call's own calls that groups `count` identical calls in a row says so ("20 runs, 1 failed").
	 * Without it, the summary of those calls ("Ran 20 commands · 1 failed").
	 */
	repeated?: (count: number, failed: number) => string;
	/** How the input of another call's call of this tool shows in its detail (a command line); without it, JSON. */
	CallInput?: ComponentType<{ call: NestedCall }>;
	/** What the detail of another call's call of this tool adds below its input and output (a link to what it made). */
	CallDetail?: ComponentType<{ call: NestedCall }>;
	/**
	 * The call's result for the person, where `hasResult` places it; `inline`: in the chat (an inline artifact shows
	 * itself too), not in a detail.
	 */
	Result?: ComponentType<{ tool: ToolView; inline: boolean }>;
};
/** Where a call's result for the person shows: after the turn's answer, or in place, right after the call. */
export type ResultPlacement = "after" | "inline";
/** Contributions by tool name. */
export type ToolActivityTable = ReadonlyMap<string, ToolActivity>;

/** A tool's first short string argument: what the generic label names. */
function shortArgument(tool: ToolView): string {
	const value = Object.values(tool.args).find((each) => typeof each === "string" && each.trim());
	return typeof value === "string" ? firstLine(value).slice(0, 120) : "";
}

/** The first line of a failed call's output: what went wrong. */
export const failureOf = (step: Step): string | undefined =>
	step.status === "error" ? firstLine(step.tool.output) || undefined : undefined;

/** The plain words of a label, for screen readers and tests. */
export const plain = (label: Label) => [label.verb, label.object, label.extra].filter(Boolean).join(" ");

/** A step for the sheet: its tool's words, or the tool's name and first short argument. */
export function describe(step: Step, tools: ToolActivityTable): Described {
	const own = tools.get(step.tool.name)?.describe;
	if (own) return own(step);
	const object = shortArgument(step.tool);
	return {
		label: { kind: "tool", verb: step.tool.name, ...(object ? { object, style: "code" as const } : {}) },
		...(failureOf(step) ? { description: failureOf(step) } : {}),
		mono: true,
	};
}

/** A step for the ticker: its label in the present tense while it runs. */
export function live(step: Step, tools: ToolActivityTable): Label {
	const running = tools.get(step.tool.name)?.running;
	return step.status === "running" && running ? running(step) : describe(step, tools).label;
}

/** A call's main argument for its row in the sheet. */
export function argumentOf(tool: ToolView, tools: ToolActivityTable, cwd: string | undefined): string {
	const own = tools.get(tool.name)?.argument;
	return own ? own(tool, cwd) : shortArgument(tool);
}

/** Where a call's result for the person shows, if it made one. */
export const placement = (tool: ToolView, tools: ToolActivityTable): ResultPlacement | false =>
	tools.get(tool.name)?.hasResult?.(tool) || false;

/** A duration as a reader says it: 12s, 1m 05s, 1h 02m. */
export function elapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** A step's state for its row in the sheet: done with its time, how it failed, running. */
export function stepState(step: Step, tools: ToolActivityTable): string {
	const { tool } = step;
	if (step.status === "running") return "● running";
	if (step.status === "error")
		return `✗ ${tool.status === "interrupted" ? "interrupted" : (tools.get(tool.name)?.failure?.(tool) ?? "failed")}`;
	const ms = tool.durationMs;
	if (ms === undefined) return "✓";
	return `✓ ${ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : elapsed(ms)}`;
}

/** The summary's words for a tool without its own: "used web_fetch", "used web_fetch 3 times". */
const usedTool = (name: string) => (count: number) => (count === 1 ? `used ${name}` : `used ${name} ${count} times`);

/**
 * One line for a finished run of calls: the tools' own words for what they did, counted, in the order they did it
 * ("Read 3 files, ran 2 commands"). `failures: false` leaves out the failures.
 */
export function summary(steps: readonly Step[], tools: ToolActivityTable, { failures = true } = {}): string {
	// Keyed by the words' function (tools sharing it count together), or by the name of a tool without one.
	const counts = new Map<unknown, { words: (count: number) => string; count: number }>();
	for (const step of steps) {
		const own = tools.get(step.tool.name)?.summary;
		const key = own ?? step.tool.name;
		const entry = counts.get(key) ?? { words: own ?? usedTool(step.tool.name), count: 0 };
		entry.count++;
		counts.set(key, entry);
	}
	const parts = [...counts.values()].map(({ words, count }) => words(count));
	const errors = failures ? steps.filter((step) => step.status === "error").length : 0;
	return `${capitalized(parts.join(", ") || "done")}${errors ? ` · ${errors} failed` : ""}`;
}

/** A tool's arguments, parsed when a settled list kept them as JSON text (cut texts stay unparsed). */
export const parsedArgs = (args: NestedCall["args"]): Record<string, unknown> => {
	if (typeof args !== "string") return args;
	try {
		const value: unknown = JSON.parse(args);
		return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	} catch {
		return {};
	}
};

export const callStatus = (status: string): StepStatus =>
	status === "error" || status === "interrupted" ? "error" : status === "done" ? "done" : "running";

/** Consecutive calls of a script with the same tool and arguments, as one timeline entry. */
export type CallGroup = {
	key: string;
	calls: NestedCall[];
	label: Label;
	description?: string;
	mono?: boolean;
	status: StepStatus;
};

/** A nested call as a call of its own, for its tool's words. */
const nestedTool = (call: NestedCall): ToolView => ({
	id: call.id,
	name: call.name,
	args: parsedArgs(call.args),
	status: call.status,
	output: "",
	images: [],
});

/**
 * A call's own calls (a script's), repeated identical calls in a row merged: 20 test runs are one entry, described by
 * the calling tool's words for repeats (`parent`: its name).
 */
export function groupCalls(calls: readonly NestedCall[], tools: ToolActivityTable, parent: string): CallGroup[] {
	const groups: CallGroup[] = [];
	for (const call of calls) {
		const last = groups.at(-1);
		const first = last?.calls[0];
		if (
			last &&
			first &&
			first.depth === call.depth &&
			first.name === call.name &&
			JSON.stringify(parsedArgs(first.args)) === JSON.stringify(parsedArgs(call.args))
		) {
			last.calls.push(call);
			continue;
		}
		const status = callStatus(call.status);
		const { label, mono } = describe({ id: call.id, status, tool: nestedTool(call) }, tools);
		// A call another call made (a subagent's read inside a script) says so: the list does not indent.
		groups.push({
			key: call.id,
			calls: [call],
			label: call.depth ? { ...label, extra: "nested" } : label,
			...(mono ? { mono } : {}),
			...(call.error ? { description: call.error } : {}),
			status,
		});
	}
	const repeated = tools.get(parent)?.repeated;
	for (const group of groups) {
		const statuses = group.calls.map((call) => callStatus(call.status));
		group.status = statuses.includes("running") ? "running" : statuses.includes("error") ? "error" : "done";
		if (group.calls.length > 1) {
			const failed = statuses.filter((status) => status === "error").length;
			group.description = repeated
				? repeated(group.calls.length, failed)
				: summary(
						group.calls.map((call, index) => ({ id: call.id, tool: nestedTool(call), status: statuses[index]! })),
						tools,
					);
		} else if (!group.description && group.calls[0]?.output) group.description = lastLine(group.calls[0].output);
	}
	return groups;
}

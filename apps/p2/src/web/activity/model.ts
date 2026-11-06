// A turn's activity: what the agent did between a person's message and its answer. Derived from the transcript's
// items: `chatItems` keeps each response's thinking and text in the transcript, in their order, and turns each run of
// consecutive tool calls into an activity item (a wheel in the chat, its steps in a sheet). A turn's last text is its
// answer, followed by the results meant for the person (artifacts, sent files, opened ports).
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ComponentType } from "react";
import type { Item, NestedCall, ToolView } from "../transcript.ts";

export type StepStatus = "running" | "done" | "error";
/** One tool call of an activity. */
export type Step = { id: string; tool: ToolView; status: StepStatus };

/** The items the chat shows: the transcript's people, markers and failures, and each turn's parts in order. */
export type ChatItem =
	| Exclude<Item, { type: "assistant" } | { type: "tool" }>
	| {
			type: "activity";
			key: string;
			/** The run's tool calls. */
			steps: Step[];
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
			/** Calls whose result is for the person: an artifact, a sent file, an opened port. */
			tools: ToolView[];
	  };

const toolStatus = (tool: ToolView): StepStatus =>
	tool.status === "error" || tool.status === "interrupted" ? "error" : tool.status === "done" ? "done" : "running";

type Response = Extract<Item, { type: "assistant" }>;
/** A run of consecutive tool calls, with the responses that made them (for its time). */
type Calls = { type: "calls"; key: string; steps: Step[]; from: Response[] };
type Part = Calls | Extract<ChatItem, { type: "thought" | "text" }>;

const stepOf = (tool: ToolView): Step => ({ id: tool.id, tool, status: toolStatus(tool) });

/**
 * A run of responses as its parts in order: thinking, text, and runs of calls (results whose call is outside the
 * loaded window join them). The first part, when it is calls, is keyed by the item before the run (`after`), so its
 * wheel is the same row as the one that waited for it.
 */
function partsOf(run: readonly Item[], live: boolean, after: string): Part[] {
	const parts: Part[] = [];
	const calls = (key: string, from?: Response): Calls => {
		const last = parts.at(-1);
		if (last?.type === "calls") {
			if (from && last.from.at(-1) !== from) last.from.push(from);
			return last;
		}
		const made: Calls = {
			type: "calls",
			key: parts.length ? key : `activity:${after}`,
			steps: [],
			from: from ? [from] : [],
		};
		parts.push(made);
		return made;
	};
	for (const item of run) {
		if (item.type === "tool") {
			calls(`activity:${item.key}`).steps.push(stepOf(item.tool));
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
				calls(`activity:${key}`, item).steps.push(stepOf(tool));
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
function runItems(run: readonly Item[], working: boolean, after: string, tools: ToolActivityTable): ChatItem[] {
	const first = run[0]!;
	const parts = partsOf(run, working, after);
	const responses = run.filter((item): item is Response => item.type === "assistant");
	const response = responses.at(-1);
	const final = parts.at(-1);
	const answer = final?.type === "text" ? final : undefined;
	if (answer) parts.pop();
	const notice =
		response && ["error", "aborted", "length"].includes(response.message.stopReason) && !response.streaming;
	const items: ChatItem[] = parts.map((part) =>
		part.type === "calls" ? activityOf(part, responses, working && !answer && part === final) : part,
	);
	// Working on a response that shows nothing yet: the activity row, waiting.
	if (working && !parts.length && !answer)
		items.push({ type: "activity", key: `activity:${after}`, steps: [], working: true });
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
		part.type === "calls" ? part.steps.flatMap((step) => (isResult(step.tool, tools) ? [step.tool] : [])) : [],
	);
	if (results.length) items.push({ type: "results", key: `results:${first.key}`, tools: results });
	return items;
}

/** A run's items, kept while its members and state are the same, so unchanged rows keep their identity. */
const runs = new WeakMap<
	Item,
	{ members: readonly Item[]; working: boolean; tools: ToolActivityTable; items: ChatItem[] }
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

const sameValue = (one: unknown, other: unknown): boolean =>
	one === other ||
	(Array.isArray(one) &&
		Array.isArray(other) &&
		one.length === other.length &&
		one.every((value, index) => {
			const that: unknown = other[index];
			if (value === that) return true;
			// A step: the same call in the same state.
			if (
				value &&
				that &&
				typeof value === "object" &&
				typeof that === "object" &&
				"tool" in value &&
				"tool" in that
			) {
				const step = value as Step;
				const same = that as Step;
				return step.id === same.id && step.status === same.status && sameTool(step.tool, same.tool);
			}
			if (value && that && typeof value === "object" && typeof that === "object" && "id" in value && "id" in that)
				return sameTool(value as ToolView, that as ToolView);
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
 * `tools`: the tools' contributions, which say which calls made results for the person.
 */
export function chatItems(
	items: readonly Item[],
	working: boolean,
	known: boolean,
	tools: ToolActivityTable,
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
			cached.members.length === run.length &&
			cached.members.every((item, index) => item === run[index])
		)
			result.push(...cached.items);
		else {
			// A member changed (a streaming delta, a result): the run's items are made again, and those that show the same
			// as before stay the same objects. Found by key: a streaming response is a new object at every delta.
			const made = runItems(run, live, after, tools).map((item) => {
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
			runs.set(run[0]!, { members: run, working: live, tools, items: made });
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
	/** Whether a call made something for the person, shown after the answer by `Result` (an artifact, a port). */
	hasResult?: (tool: ToolView) => boolean;
	/** The call's detail in the sheet; `onGroup` opens one of its own calls (`tool.calls`, grouped by `groupCalls`). */
	Detail?: ComponentType<{ step: Step; onGroup: (index: number) => void }>;
	/** What the detail of a script's call of this tool adds below its input and output (a link to what it made). */
	CallDetail?: ComponentType<{ call: NestedCall }>;
	/** A result after the answer; `inline`: in the chat (an inline artifact shows itself too), not in the sheet. */
	Result?: ComponentType<{ tool: ToolView; inline: boolean }>;
};
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

/** Whether a call made something for the person, shown after the answer. */
export const isResult = (tool: ToolView, tools: ToolActivityTable): boolean =>
	tools.get(tool.name)?.hasResult?.(tool) ?? false;

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

/** A call's own calls (a script's), repeated identical calls in a row merged: 20 test runs are one entry, "×20". */
export function groupCalls(calls: readonly NestedCall[], tools: ToolActivityTable): CallGroup[] {
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
		const tool: ToolView = {
			id: call.id,
			name: call.name,
			args: parsedArgs(call.args),
			status: call.status,
			output: "",
			images: [],
		};
		const { label, mono } = describe({ id: call.id, status, tool }, tools);
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
	for (const group of groups) {
		const statuses = group.calls.map((call) => callStatus(call.status));
		group.status = statuses.includes("running") ? "running" : statuses.includes("error") ? "error" : "done";
		if (group.calls.length > 1) {
			const failed = statuses.filter((status) => status === "error").length;
			group.description = `${group.calls.length} runs${failed ? `, ${failed} failed` : ""}`;
		} else if (!group.description && group.calls[0]?.output) group.description = lastLine(group.calls[0].output);
	}
	return groups;
}

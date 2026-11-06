// A turn's activity: what the agent did between a person's message and its answer. Derived from the transcript's
// items: `chatItems` keeps each response's thinking and text in the transcript, in their order, and turns each run of
// consecutive tool calls into an activity item (a wheel in the chat, its steps in a sheet). A turn's last text is its
// answer, followed by the results meant for the person (artifacts, sent files, opened ports).
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Item, NestedCall, ToolView } from "../transcript.ts";
import { artifactOf, forwardOf, sentFileOf } from "./result-data.ts";

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

const str = (value: unknown) => (typeof value === "string" ? value : "");
const detailsOf = (tool: ToolView): Record<string, unknown> =>
	tool.details && typeof tool.details === "object" && !Array.isArray(tool.details) ? tool.details : {};

/** Whether a call's result is for the person, shown in the chat after the answer and not only in the timeline. */
export const isResult = (tool: ToolView): boolean => Boolean(artifactOf(tool) || sentFileOf(tool) || forwardOf(tool));

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
			if (part.type === "thinking" && part.thinking.trim())
				parts.push({
					type: "thought",
					key: `thought:${key}`,
					...entry,
					text: part.thinking,
					live: item.streaming && live && index === last,
				});
			else if (part.type === "text" && part.text.trim())
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
function runItems(run: readonly Item[], working: boolean, after: string): ChatItem[] {
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
			key: `answer:${response.key}`,
			...(response.entryId !== undefined ? { entryId: response.entryId } : {}),
			text: answer?.text ?? "",
			message: response.message,
			streaming: response.streaming,
		});
	const results = parts.flatMap((part) =>
		part.type === "calls" ? part.steps.flatMap((step) => (isResult(step.tool) ? [step.tool] : [])) : [],
	);
	if (results.length) items.push({ type: "results", key: `results:${first.key}`, tools: results });
	return items;
}

/** A run's items, kept while its members and state are the same, so unchanged rows keep their identity. */
const runs = new WeakMap<Item, { members: readonly Item[]; working: boolean; items: ChatItem[] }>();

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
 */
export function chatItems(items: readonly Item[], working: boolean, known = true): ChatItem[] {
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
			cached.members.length === run.length &&
			cached.members.every((item, index) => item === run[index])
		)
			result.push(...cached.items);
		else {
			const made = runItems(run, live, after);
			runs.set(run[0]!, { members: run, working: live, items: made });
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

const base = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;
const firstLine = (text: string) =>
	text
		.split("\n")
		.find((line) => line.trim())
		?.trim() ?? "";
/** Markdown as plain words, for a one-line title: code spans, emphasis and links lose their markers. */
const plainText = (text: string) =>
	text
		.replace(/`([^`]*)`/g, "$1")
		.replace(/(\*\*|__|\*|_)(\S[^*_]*?)\1/g, "$2")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

/** The first sentence of a text, for a one-line description. */
const sentence = (text: string) => {
	const line = firstLine(text);
	const end = line.search(/[.!?](\s|$)/);
	return end > 0 ? line.slice(0, end + 1) : line;
};

/** The kind of work a step is, for its icon. */
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

/** A terminal call as its tmux command line: `send-keys -t 1 C-c`. */
const terminalCommand = (args: Record<string, unknown>) =>
	[
		str(args.command),
		...(Array.isArray(args.args)
			? args.args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
			: []),
	]
		.filter(Boolean)
		.join(" ");

const SEARCH = /^\s*(rg|grep|egrep|fgrep|find|fd|ag|ack)\b/;
const lastLine = (text: string) => text.trimEnd().split("\n").at(-1)?.trim();
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The plain words of a label, for screen readers and tests. */
export const plain = (label: Label) => [label.verb, label.object, label.extra].filter(Boolean).join(" ");

/** A step for the timeline: its label in the past tense and, if there is more to say, a description. */
export function describe(step: Step): { label: Label; description?: string; mono?: boolean } {
	const { tool } = step;
	const path = str(tool.args.path);
	const details = detailsOf(tool);
	const failure = step.status === "error" ? firstLine(tool.output) || undefined : undefined;
	switch (tool.name) {
		case "bash": {
			const command = str(tool.args.command);
			const search = SEARCH.test(command);
			return {
				label: {
					kind: search ? "search" : "command",
					verb: search ? "Searched" : "Ran",
					object: command,
					style: "code",
				},
				// A failure's first line says what went wrong; a success's last line is its result.
				description: failure ?? lastLine(tool.output),
				mono: true,
			};
		}
		case "read": {
			const offset = typeof tool.args.offset === "number" ? tool.args.offset : undefined;
			const limit = typeof tool.args.limit === "number" ? tool.args.limit : undefined;
			return {
				label: { kind: "read", verb: "Read", object: base(path), style: "file" },
				description:
					failure ??
					(tool.images.length ? "Image" : offset ? `Lines ${offset}–${offset + (limit ?? 1) - 1}` : path),
			};
		}
		case "write":
			return {
				label: { kind: "edit", verb: "Wrote", object: base(path), style: "file" },
				description: failure ?? path,
			};
		case "edit":
			return {
				label: { kind: "edit", verb: "Edited", object: base(path), style: "file" },
				description: failure ?? path,
			};
		case "terminal": {
			const command = terminalCommand(tool.args);
			return {
				label: { kind: "command", verb: "Terminal", object: command, style: "code" },
				description: failure ?? lastLine(tool.output),
				mono: true,
			};
		}
		case "codemode": {
			const calls = tool.calls?.length ?? 0;
			const failed = tool.calls?.filter((call) => call.status === "error").length ?? 0;
			const comment = firstLine(str(tool.args.code)).replace(/^\/\/\s*/, "");
			return {
				label: {
					kind: "script",
					verb: "Ran a script",
					extra: calls
						? `${calls} ${calls === 1 ? "call" : "calls"}${failed ? `, ${failed} failed` : ""}`
						: undefined,
				},
				description: failure ?? comment,
			};
		}
		case "subagent": {
			const action = str(tool.args.action);
			const name = str(tool.args.name) || str(details.name);
			const verbs: Record<string, string> = {
				spawn: "Started subagent",
				send: "Messaged",
				answer: "Read the answer of",
				status: "Checked on",
				archive: "Archived",
				restore: "Restored",
				configure: "Configured",
				stop: "Stopped",
			};
			return {
				label: { kind: "agent", verb: verbs[action] ?? "Subagent", object: name, style: "file" },
				description: failure ?? (plainText(sentence(str(tool.args.message))) || undefined),
			};
		}
		case "agent":
			// A script's one-shot agent: its label, or what it was asked.
			return {
				label: {
					kind: "agent",
					verb: "Asked an agent",
					object: str(tool.args.label) || plainText(sentence(str(tool.args.prompt))),
					style: "file",
				},
				description: failure ?? (str(tool.args.label) ? plainText(sentence(str(tool.args.prompt))) : undefined),
			};
		case "artifact":
			return {
				label: {
					kind: "artifact",
					verb: "Made",
					object: str(details.title) || str(tool.args.title) || str(tool.args.name),
					style: "file",
				},
				description:
					failure ??
					(typeof details.version === "number"
						? `${str(details.type).toUpperCase() || "Artifact"} · version ${details.version}`
						: undefined),
			};
		case "send_file":
			return {
				label: { kind: "file", verb: "Sent", object: str(details.name) || base(path), style: "file" },
				description: failure ?? path,
			};
		case "ports": {
			const action = str(tool.args.action);
			const port = typeof tool.args.port === "number" ? String(tool.args.port) : "";
			return {
				label: {
					kind: "port",
					verb: action === "open" ? "Opened port" : action === "close" ? "Closed port" : "Listed ports",
					object: port || undefined,
					style: "code",
				},
				description: failure ?? (str(tool.args.name) || undefined),
			};
		}
		case "conversations": {
			const action = str(tool.args.action);
			return {
				label: {
					kind: "message",
					verb:
						action === "send"
							? "Messaged a conversation"
							: action === "answer"
								? "Read an answer"
								: "Listed conversations",
				},
				description: failure ?? (plainText(sentence(str(tool.args.message))) || undefined),
			};
		}
		case "history_search": {
			const hits = Array.isArray(details.hits) ? details.hits.length : 0;
			return {
				label: { kind: "search", verb: "Searched the history for", object: str(tool.args.query), style: "words" },
				description:
					failure ??
					(step.status === "done"
						? `${hits ? `${hits} ${hits === 1 ? "match" : "matches"}` : "No matches"}${details.more === true ? ", and more" : ""}`
						: undefined),
			};
		}
		case "history_read": {
			const mode = str(tool.args.mode);
			const entries = Array.isArray(details.entries) ? details.entries.length : 0;
			const count = `${entries} ${entries === 1 ? "entry" : "entries"}`;
			return {
				label: {
					kind: "read",
					verb: "Read the history",
					object:
						mode === "range"
							? `#${str(tool.args.from)}${tool.args.to === undefined ? "" : `–#${str(tool.args.to)}`}`
							: undefined,
					style: "code",
				},
				description:
					failure ??
					(step.status === "done"
						? mode === "tail"
							? `${count} before the last compaction or handoff`
							: `${count}${details.truncated === true ? ", cut at the output budget" : ""}`
						: undefined),
			};
		}
		case "history_handoff":
			return {
				label: { kind: "handoff", verb: "Handed off to a new context" },
				description: failure ?? (plainText(sentence(str(tool.args.text))) || undefined),
			};
		default:
			return {
				label: { kind: "tool", verb: "Used", object: tool.name, style: "file" },
				description: failure ?? (Object.keys(tool.args).length ? JSON.stringify(tool.args) : undefined),
				mono: true,
			};
	}
}

/** A call's main argument, for its row in the sheet: the command, the file, the script's first comment. */
export function mainArgument(tool: ToolView): string {
	const { args } = tool;
	switch (tool.name) {
		case "bash":
			return firstLine(str(args.command));
		case "read":
		case "write":
		case "edit":
		case "send_file":
			return str(args.path);
		case "terminal":
			return firstLine(terminalCommand(args));
		case "codemode":
			return firstLine(str(args.code)).replace(/^\/\/\s*/, "");
		case "subagent":
			return [str(args.action), str(args.name)].filter(Boolean).join(" ");
		case "agent":
			return str(args.label) || firstLine(str(args.prompt));
		case "artifact":
			return str(args.title) || str(args.name);
		case "history_search":
			return str(args.query);
		default: {
			const value = Object.values(args).find((each) => typeof each === "string" || typeof each === "number");
			return value === undefined ? "" : firstLine(String(value));
		}
	}
}

/** A duration as a reader says it: 12s, 1m 05s, 1h 02m. */
export function elapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** A step's state for its row in the sheet: done with its time, how it failed (a command's exit code), running. */
export function stepState(step: Step): string {
	const { tool } = step;
	if (step.status === "running") return "● running";
	if (step.status === "error") {
		const code = /exit(?:ed with)? code (\d+)/i.exec(tool.output)?.[1];
		return `✗ ${code ? `exit ${code}` : tool.status === "interrupted" ? "interrupted" : "failed"}`;
	}
	const ms = tool.durationMs;
	return ms === undefined
		? "✓"
		: `✓ ${ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : elapsed(ms)}`;
}

/** A step for the ticker: its label in the present tense while it runs. */
export function live(step: Step): Label {
	if (step.status !== "running") return describe(step).label;
	const { tool } = step;
	const path = base(str(tool.args.path));
	switch (tool.name) {
		case "bash": {
			const command = firstLine(str(tool.args.command));
			const search = SEARCH.test(command);
			return {
				kind: search ? "search" : "command",
				verb: search ? "Searching" : "Running",
				object: command,
				style: "code",
			};
		}
		case "read":
			return { kind: "read", verb: "Reading", object: path, style: "file" };
		case "terminal":
			return { kind: "command", verb: "Terminal", object: firstLine(terminalCommand(tool.args)), style: "code" };
		case "write":
			return { kind: "edit", verb: "Writing", object: path, style: "file" };
		case "edit":
			return { kind: "edit", verb: "Editing", object: path, style: "file" };
		case "codemode": {
			// The calls made so far: a running script's total is not known yet.
			const calls = tool.calls?.length ?? 0;
			return {
				kind: "script",
				verb: "Running a script",
				extra: calls ? `${calls} ${calls === 1 ? "call" : "calls"}` : undefined,
			};
		}
		case "subagent":
			return { kind: "agent", verb: "Asking", object: str(tool.args.name), style: "file" };
		case "agent":
			return { ...describe(step).label, verb: "Asking an agent" };
		case "artifact":
			return { kind: "artifact", verb: "Making", object: str(tool.args.title), style: "file" };
		case "send_file":
			return { kind: "file", verb: "Sending", object: path, style: "file" };
		case "history_search":
			return { kind: "search", verb: "Searching the history for", object: str(tool.args.query), style: "words" };
		case "history_read":
			return { ...describe(step).label, verb: "Reading the history" };
		case "history_handoff":
			return { kind: "handoff", verb: "Handing off to a new context" };
		default: {
			const { label } = describe(step);
			return { ...label, verb: label.verb === "Used" ? "Using" : label.verb };
		}
	}
}

/** One line for a finished run of calls: what kinds of work it did, counted. `failures: false` leaves out the failures. */
export function summary(steps: readonly Step[], { failures = true } = {}): string {
	const count = (test: (step: Step) => boolean) => steps.filter(test).length;
	const tools = (...names: string[]) => count((step) => names.includes(step.tool.name));
	const plural = (n: number, one: string, many: string) => (n === 1 ? one : many.replace("#", String(n)));
	const known = [
		"read",
		"bash",
		"codemode",
		"edit",
		"write",
		"subagent",
		"artifact",
		"send_file",
		"history_search",
		"history_read",
		"history_handoff",
		"terminal",
	];
	const parts = [
		tools("read") ? plural(tools("read"), "read a file", "read # files") : "",
		tools("bash") ? plural(tools("bash"), "ran a command", "ran # commands") : "",
		tools("codemode") ? plural(tools("codemode"), "ran a script", "ran # scripts") : "",
		tools("edit", "write") ? plural(tools("edit", "write"), "edited a file", "edited # files") : "",
		tools("subagent") ? plural(tools("subagent"), "used a subagent", "used subagents # times") : "",
		tools("artifact") ? plural(tools("artifact"), "made an artifact", "made # artifacts") : "",
		tools("send_file") ? plural(tools("send_file"), "sent a file", "sent # files") : "",
		tools("history_search", "history_read") ? "looked through the history" : "",
		tools("history_handoff") ? "handed off" : "",
		tools("terminal") ? plural(tools("terminal"), "used the terminal", "used the terminal # times") : "",
		count((step) => !known.includes(step.tool.name))
			? plural(
					count((step) => !known.includes(step.tool.name)),
					"used a tool",
					"used # tools",
				)
			: "",
	].filter(Boolean);
	if (!parts.length) parts.push("done");
	const errors = failures ? count((step) => step.status === "error") : 0;
	return `${capitalized(parts.join(", "))}${errors ? ` · ${plural(errors, "1 failed", "# failed")}` : ""}`;
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

/** A script's calls, repeated identical calls in a row merged: 20 test runs are one entry, "×20". */
export function groupCalls(calls: readonly NestedCall[]): CallGroup[] {
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
		const { label, mono } = describe({
			id: call.id,
			status,
			tool: {
				id: call.id,
				name: call.name,
				args: parsedArgs(call.args),
				status: call.status,
				output: "",
				images: [],
			},
		});
		// A call another call made (a subagent's read inside a script) says so: the list does not indent.
		groups.push({
			key: call.id,
			calls: [call],
			label: call.depth ? { ...label, extra: "nested" } : label,
			mono,
			description: call.error,
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

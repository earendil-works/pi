// Persistent background subagents, adapted from pi-durable's
// test/examples/23-subagent-background.ts (MIT; see third-party/pi.LICENSE).
// Adds per-subagent model, thinking level and tool selection, and an optional own location (environment and cwd).

import type { AssistantMessage, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
	AssistantEntry,
	type ConversationHandle,
	type ConversationId,
	type Cursor,
	configure,
	type DocumentReader,
	defineExtension,
	defineTask,
	defineTool,
	type Harness,
	LiveDoc,
	type ModelRef,
	ROOT_CONVERSATION_ID,
	type SettledSubmissionRecord,
	type Submission,
	type ToolExecutionApi,
	type ToolRegistration,
	type Tx,
} from "@earendil-works/pi-durable";
import { arr, bool, compile, nul, obj, opt, str, union } from "@earendil-works/pi-schema";
import type { Context, JsonValue } from "@p2/app/v1";
import { type Location, type LocationInput, literal, locationText } from "@p2/app/v1";
import { mainConversation, originOf } from "@p2/app/v1/worker";
import { AGENT_MESSAGE_ENTRY, type AgentMessage, SUBAGENT_TASK_ENTRY, SubagentLocationsSchema } from "./contract.ts";
import { HISTORY_TOOLS, resolveChoice, Subagents, TEAM_TOOL } from "./contract.worker.ts";

const SUBAGENT_EXTENSION = "subagent-tools";

// Owns the subagent conversation. Background and immediately terminal, so the
// main agent's Stop and idle waits do not reach the subagent; abort({background})
// still does.
const Anchor = defineTask<null, { phase: "done" }, null>({
	name: "p2.subagent-anchor",
	version: 1,
	initial: () => ({ phase: "done" }),
	phases: {
		done: (_anchor, runtime, context) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context),
	},
	abort: (_anchor, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

/**
 * A message queued behind the subagent's current run is placed when that run ends. If the run fails, Durable keeps it
 * queued and nothing places it: the subagent goes idle with the message still queued, and the reporter would wait
 * forever (keeping the worker busy). Withdraw it then; `undefined` means withdrawn.
 */
export async function settledOrWithdrawn(
	submission: Submission,
	subagent: ConversationHandle,
	pause: () => Promise<void>,
	context: Context,
): Promise<SettledSubmissionRecord | undefined> {
	const settled = submission.wait(context);
	for (;;) {
		const idle = subagent.waitForIdle(context).then(() => true);
		if (!(await Promise.race([settled.then(() => false), idle]))) return settled;
		if ((await submission.status(context)).status !== "queued") return settled;
		// Idle while still queued: let an admission in flight settle, then withdraw.
		await pause();
		if ((await submission.status(context)).status !== "queued") return settled;
		if ((await submission.abort(context)) === "aborted") return undefined;
	}
}

/** Wait `ms` on the Harness timer inside a phase; rejects when `context` is cancelled, as when the invocation ends. */
function pause(runtime: { setTimer(callback: () => void, delayMs: number): () => void }, ms: number, context: Context) {
	return new Promise<void>((resolve, reject) => {
		const signal = context.abortSignal;
		if (signal?.aborted) return reject(signal.reason);
		const onAbort = () => {
			disarm();
			reject(signal?.reason);
		};
		const disarm = runtime.setTimer(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

const undelivered = "its previous run failed before this message was delivered; send it again";

function textOf(message: AssistantMessage | undefined): string {
	return (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/**
 * A subagent's message as an input: the structural entry readers use, and the line the model reads. `replyWith` is the
 * tool call that answers a question (the main agent's `subagent send`, a sibling's `team send`).
 */
function agentMessageInput(message: AgentMessage, replyWith: string) {
	const label = {
		answered: "answered, no reply needed",
		failed: "failed",
		question: `asks; answer with ${replyWith}`,
		note: "notes, no reply needed",
	}[message.intent];
	return {
		content: `[subagent ${message.from.name} ${label}] ${message.text}`,
		entry: { kind: AGENT_MESSAGE_ENTRY, data: message as unknown as JsonValue },
	};
}

/** The latest completed ("stop") answer with text of a conversation: a bounded, read-only, newest-first scan. */
async function latestAnswer(api: ToolExecutionApi, conversationId: ConversationId, context: Context) {
	return api.commit(async (tx) => {
		let cursor: Cursor | undefined;
		for (let scanned = 0; scanned < 2000; ) {
			const page = await tx.scanEntries({ conversationId }, 200, cursor);
			for (const entry of page.items) {
				scanned++;
				const message = AssistantEntry.is(entry) ? (entry.model?.[0] as AssistantMessage | undefined) : undefined;
				if (message?.stopReason === "stop" && textOf(message).trim()) return textOf(message);
			}
			if (!page.next) break;
			cursor = page.next;
		}
		return undefined;
	}, context);
}

// Delivers one message, waits for the answer, then reports it to the main agent
// as a follow-up input. Request IDs make both submissions exactly-once across restarts.
type ReporterInput = {
	name: string;
	conversationId: ConversationId;
	message: string;
	followUp: boolean;
	/** The owner started the main agent's turn: the subagent's turn inherits it (`SUBAGENT_TASK_ENTRY`). */
	origin?: "owner";
};
/** `report`: what to tell the main agent (a plain string: a report checkpointed before reports were entries). */
type ReporterState =
	| { phase: "deliver" }
	| { phase: "report"; report?: string | { intent: "answered" | "failed"; text: string } };
const Reporter = defineTask<ReporterInput, ReporterState, null>({
	name: "p2.subagent-reporter",
	version: 1,
	initial: () => ({ phase: "deliver" }),
	phases: {
		deliver: async (reporter, runtime, context) => {
			const { name, conversationId, message, followUp, origin } = reporter.input;
			const subagent = await runtime.conversation(conversationId, context);
			if (!subagent) throw new Error(`Subagent ${name} has no conversation`);
			const submission = await subagent.submit(
				{
					type: "input",
					content: message,
					...(origin ? { entry: { kind: SUBAGENT_TASK_ENTRY, data: { origin } } } : {}),
					whenBusy: followUp ? "followUp" : "steer",
					requestId: `subagent:${reporter.id}`,
				},
				context,
			);
			const settled = await settledOrWithdrawn(submission, subagent, () => pause(runtime, 1000, context), context);
			await runtime.commit(async (tx) => {
				const next = (report?: { intent: "answered" | "failed"; text: string }) =>
					({ status: "running", checkpoint: { phase: "report", report } }) as const;
				if (settled === undefined) return next({ intent: "failed", text: undelivered });
				if (settled.status === "unanswered")
					return next(settled.reason === "aborted" ? undefined : { intent: "failed", text: settled.reason });
				// A continue settles like an input (it has no placed entry): its run's answer is reported the same way.
				if (settled.type !== "input" && settled.type !== "continue") return next();
				const agent = (await tx.doc(Subagents, ROOT_CONVERSATION_ID)).agents[name];
				if (!agent || agent.reported.includes(settled.answer)) return next();
				agent.reported.push(settled.answer);
				const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as AssistantMessage | undefined;
				return next({ intent: "answered", text: textOf(answer) });
			}, context);
		},
		report: async (reporter, runtime, context) => {
			const report = reporter.state.checkpoint.report;
			if (report !== undefined) {
				const { name, conversationId } = reporter.input;
				// To the current main conversation: a `/tree` switch while the subagent worked moves where its answer goes.
				const main = await runtime.conversation(await mainConversation(runtime, context), context);
				await main?.submit(
					{
						type: "input",
						...(typeof report === "string"
							? { content: report }
							: agentMessageInput(
									{ from: { name, conversationId }, intent: report.intent, text: report.text },
									`subagent send to ${name}`,
								)),
						whenBusy: "followUp",
						requestId: `subagent-report:${reporter.id}`,
					},
					context,
				);
			}
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
		},
	},
	abort: (_reporter, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

type SubagentDetails = {
	action: string;
	name?: string;
	conversationId?: number;
	model?: string;
	thinkingLevel?: string;
	tools?: string[];
	/** Its own cwd (raw path) and, on a remote environment, that environment's name. */
	cwd?: string;
	env?: string;
};

/** A subagent's own location as the tool's details carry it. */
const locationDetails = (location: Location | undefined): Pick<SubagentDetails, "cwd" | "env"> =>
	location === undefined ? {} : { cwd: location.cwd, ...(location.env === null ? {} : { env: location.env }) };

/**
 * Places what version 1 left unplaced (an own cwd without its environment: `spawnedOn` tells the environment it was
 * spawned on), then lists where the session's subagents work: the conversations following the session (Pi Mobile
 * 78056b34e: subagents spawned without their own location, one-shot agents) and the own locations.
 */
export async function placeSubagents(
	harness: Pick<Harness, "snapshot" | "commit">,
	spawnedOn: (conversationId: ConversationId, cwd: string) => string | null,
	context: Context,
): Promise<{ followers: ConversationId[]; own: Location[] }> {
	let registry = await harness.snapshot(Subagents, ROOT_CONVERSATION_ID, context);
	if (Object.values(registry?.agents ?? {}).some((agent) => agent.unplacedCwd !== undefined)) {
		await harness.commit(async (tx) => {
			for (const agent of Object.values((await tx.doc(Subagents, ROOT_CONVERSATION_ID)).agents)) {
				if (agent.unplacedCwd === undefined) continue;
				agent.location = { env: spawnedOn(agent.conversationId, agent.unplacedCwd), cwd: agent.unplacedCwd };
				delete agent.unplacedCwd;
			}
		}, context);
		registry = await harness.snapshot(Subagents, ROOT_CONVERSATION_ID, context);
	}
	const agents = Object.values(registry?.agents ?? {});
	return {
		followers: [
			...agents.filter((agent) => agent.location === undefined),
			...Object.values(registry?.oneShots ?? {}),
		].map((child) => child.conversationId),
		own: agents.flatMap((agent) => (agent.location === undefined ? [] : [agent.location])),
	};
}

const isSubagentLocations = compile(SubagentLocationsSchema).check;

/**
 * Where version 1 own cwds were spawned: on the environment the server recorded for them (`recorded`, the worker init
 * value `subagentLocations`), else on the session's spawn environment (a session could not change machines while it
 * had them).
 */
export function spawnEnvironments(
	recorded: unknown,
	sessionEnv: string | null,
): (conversationId: ConversationId, cwd: string) => string | null {
	const known = isSubagentLocations(recorded) ? recorded : {};
	return (conversationId, cwd) => {
		const location: Location | undefined = known[String(conversationId)];
		return location?.cwd === cwd ? location.env : sessionEnv;
	};
}

/** A conversation's own location (a subagent spawned with a cwd), or undefined: it follows the session. */
export async function ownLocation(
	read: DocumentReader,
	conversationId: ConversationId,
	context: Context,
): Promise<Location | undefined> {
	if (conversationId === ROOT_CONVERSATION_ID) return undefined;
	const registry = await read.snapshot(Subagents, ROOT_CONVERSATION_ID, context);
	return Object.values(registry?.agents ?? {}).find((agent) => agent.conversationId === conversationId)?.location;
}

/** Where the conversation calling a tool works (the session's, or its own), for a spawned subagent's own location. */
export type Locate = (conversationId: ConversationId, read: DocumentReader, context: Context) => Promise<Location>;

/** What the subagent tool needs to place subagents: locating conversations and resolving directories. */
export type SubagentLocator = {
	readonly locate: Locate;
	/** `target` as an existing directory's location, relative to `from` (see `resolveDirectory`), or why not. */
	readonly directory: (
		target: LocationInput,
		from: Location,
		context: Context,
	) => Promise<Location | { error: string }>;
};

/**
 * Where a subagent of a caller at `caller` should work: `env` (default the caller's; null this device) and `cwd`
 * (default the caller's cwd on its own environment, the home elsewhere). Text when it is not an existing directory.
 */
export async function placeTarget(
	locator: SubagentLocator,
	caller: Location,
	args: { env?: string | null; cwd?: string },
	context: Context,
): Promise<Location | string> {
	const env = args.env === undefined ? caller.env : args.env;
	const resolved = await locator.directory({ env, path: args.cwd ?? "" }, caller, context);
	if (!("error" in resolved)) return resolved;
	const where = `${env === caller.env ? "" : `${env ?? "local"}:`}${args.cwd ?? "~"}`;
	return resolved.error === "not an existing directory"
		? `cwd ${where} is not an existing directory.`
		: `cwd ${where}: ${resolved.error}`;
}

/** What archiving needs: a tool call's API, or the worker's Harness. */
type ArchiveTarget = {
	conversation(id: ConversationId, context: Context): Promise<{ abort(context: Context): Promise<void> } | undefined>;
	commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
};

/**
 * Archives (aborting its work first, as archiving a session stops its worker) or restores a subagent of conversation
 * `parent`. Used by the tool's archive/restore and by the browser's Archive/Restore.
 */
export async function setArchived(
	target: ArchiveTarget,
	parent: ConversationId,
	conversationId: ConversationId,
	archived: boolean,
	context: Context,
): Promise<void> {
	if (archived) await (await target.conversation(conversationId, context))?.abort(context);
	await target.commit(async (tx) => {
		const agent = Object.values((await tx.doc(Subagents, parent)).agents).find(
			(each) => each.conversationId === conversationId,
		);
		if (agent && archived) agent.archived = true;
		else if (agent) delete agent.archived;
	}, context);
}

// TODO: use the tool API's models once pi-durable exposes them
// (earendil-works/pi#10395). Until then the host passes its Models instance.
export function createSubagentExtension(models: Models, locator: SubagentLocator) {
	const tool = defineTool({
		name: "subagent",
		description: [
			"Manage persistent subagents that work in the background while you keep talking to the user.",
			"Each subagent is its own conversation with its own memory, working in your cwd unless spawned with its own.",
			"Actions:",
			"- spawn (name, message; optional model, thinkingLevel, tools, env, cwd): start a subagent and send its first message.",
			"  Without env and cwd it works where you work and follows the session when it moves. With them it gets its own",
			"  location, which stays when the session moves: cwd is an existing directory its tools run in and the user's workspace",
			"  view shows, e.g. a git worktree you created first (relative to your cwd on your environment, to the home on another);",
			"  env is an environment name from location_envs, or null for this device (default: yours; another environment needs",
			"  the owner's request).",
			"  model is 'provider/modelId' (default: yours); thinkingLevel is off|minimal|low|medium|high|xhigh|max",
			"  (clamped to the model); tools is a subset of read, write, edit, bash, send_file, artifact (default: all of these;",
			"  [] for none) and the location tools location_envs, location_dirs, location_move (never by default; with",
			"  location_move it can move itself).",
			"- send (name, message; followUp: true queues after the current answer instead of steering).",
			"- configure (name; optional model, thinkingLevel, tools, env, cwd, followSession): replace its model/thinking/tool",
			"  selection for later work; env/cwd give it its own location, followSession: true makes it follow the session",
			"  again. A location changes only while it is idle.",
			"- stop (name): abort its current work; it stays usable.",
			"- archive (name): stop it and hide it from the user's sidebar and from status; restore (name) or send brings it back.",
			"- answer (name): return its latest completed answer, e.g. when a report did not reach you or you need it again.",
			"- status (optional name): list subagents and whether they are working; archived ones only by name.",
			"- models: list models that have credentials configured.",
			"Answers are reported back to you as messages when they arrive; do not wait or poll for them.",
			"Subagents can also message you while they work: a [subagent <name> asks; …] message needs your answer (send to that",
			"subagent); a note needs none.",
		].join("\n"),
		parameters: obj(
			{
				action: union([
					literal("spawn"),
					literal("send"),
					literal("configure"),
					literal("stop"),
					literal("archive"),
					literal("restore"),
					literal("answer"),
					literal("status"),
					literal("models"),
				]),
				name: opt(str()),
				message: opt(str()),
				followUp: opt(bool()),
				model: opt(str()),
				thinkingLevel: opt(str()),
				tools: opt(arr(str())),
				cwd: opt(str()),
				env: opt(union([str(), nul()])),
				followSession: opt(bool()),
			},
			{ open: true },
		),
		// A crash-interrupted stop must not be repeated against newer work.
		replay: "unsafe",
		execute: async (args, api, context) => {
			const { action, name, message, followUp } = args;
			const reply = (text: string, extra: Partial<SubagentDetails> = {}, isError = false) => ({
				output: [{ type: "text" as const, text }],
				details: { action, ...(name === undefined ? {} : { name }), ...extra } satisfies SubagentDetails,
				isError,
			});
			const registry = (await api.snapshot(Subagents, ROOT_CONVERSATION_ID, context)) ?? {
				agents: {},
				reporters: {},
			};
			const installed = () => api.registry.tools().map((entry) => entry.tool);

			if (action === "models") {
				const available = await models.getAvailable(undefined, { signal: AbortSignal.timeout(10_000) });
				const lines = available.slice(0, 200).map((model) => `${model.provider}/${model.id} (${model.name})`);
				return reply(lines.length ? lines.join("\n") : "No models with configured credentials.");
			}
			if (action === "status") {
				const all = Object.entries(registry.agents);
				const listed =
					name === undefined ? all.filter(([, agent]) => !agent.archived) : all.filter(([each]) => each === name);
				const lines: string[] = [];
				for (const [each, agent] of listed) {
					const busy = (await api.snapshot(LiveDoc, agent.conversationId, context))?.run !== undefined;
					lines.push(
						`${each}: ${busy ? "working" : "idle"}${agent.archived ? " · archived" : ""} · ${agent.model} · thinking ${agent.thinkingLevel} · tools ${agent.tools.join(", ") || "none"}${agent.location === undefined ? "" : ` · in ${locationText(agent.location)}`}`,
					);
				}
				const archived = name === undefined ? all.length - listed.length : 0;
				if (archived) lines.push(`${archived} archived (status with a name shows one).`);
				return reply(lines.length ? lines.join("\n") : "No subagents.");
			}
			if (name === undefined || !name.trim()) return reply(`${action} needs a name.`, {}, true);
			const agent = Object.hasOwn(registry.agents, name) ? registry.agents[name] : undefined;
			if (action !== "spawn" && !agent) return reply(`No subagent named ${name}.`, {}, true);
			if (action === "stop" && agent) {
				await (await api.conversation(agent.conversationId, context))?.abort(context);
				return reply(`Stopped ${name}.`, { conversationId: agent.conversationId });
			}
			if ((action === "archive" || action === "restore") && agent) {
				await setArchived(api, ROOT_CONVERSATION_ID, agent.conversationId, action === "archive", context);
				return reply(action === "archive" ? `Stopped and archived ${name}.` : `Restored ${name}.`, {
					conversationId: agent.conversationId,
				});
			}
			if (action === "answer" && agent) {
				const answer = await latestAnswer(api, agent.conversationId, context);
				const busy = (await api.snapshot(LiveDoc, agent.conversationId, context))?.run !== undefined;
				const state = busy ? `${name} is still working.` : "";
				const text =
					answer === undefined
						? `${name} has not answered yet.${state ? ` ${state}` : ""}`
						: `${state ? `${state} Its latest answer:\n\n` : ""}${answer}`;
				return reply(text, { conversationId: agent.conversationId });
			}
			if (action !== "configure" && (message === undefined || !message.trim()))
				return reply(`${action} needs a message.`, {}, true);
			const placing = args.cwd !== undefined || args.env !== undefined;
			if (
				action === "configure" &&
				args.model === undefined &&
				args.thinkingLevel === undefined &&
				args.tools === undefined &&
				!placing &&
				!args.followSession
			)
				return reply("configure needs model, thinkingLevel, tools, env, cwd or followSession.", {}, true);

			// Validate spawn/configure choices before a commit, so a typo changes nothing.
			let change: { model?: ModelRef; thinkingLevel?: ModelThinkingLevel } = {};
			let tools: ToolRegistration[] = [];
			/** Its own location; `null`: it follows the session (again). */
			let location: Location | null | undefined;
			if (placing && action !== "spawn" && action !== "configure")
				return reply("Only spawn and configure take a location.", {}, true);
			if (args.followSession && (action !== "configure" || placing))
				return reply("followSession is for configure, without env or cwd.", {}, true);
			// Who started this turn: the owner may choose another environment, and the subagent's turn inherits it.
			const origin = action === "spawn" || action === "send" || placing ? await originOf(api, context) : undefined;
			if (action === "spawn" || action === "configure") {
				if (action === "spawn" && agent)
					return reply(`${name} already exists${agent.archived ? " (archived)" : ""}; use send.`, {}, true);
				const choice = await resolveChoice(models, api, args, action === "spawn" ? undefined : agent, context);
				if (typeof choice === "string") return reply(choice, {}, true);
				change = { model: choice.model, thinkingLevel: choice.thinkingLevel };
				tools = choice.tools;
				// A location changes between runs, never under one: its tools would switch machines mid-task.
				if (
					agent &&
					(placing || args.followSession) &&
					(await api.snapshot(LiveDoc, agent.conversationId, context))?.run !== undefined
				)
					return reply(`${name} is working: stop it or wait before changing its location.`, {}, true);
				if (args.followSession) location = null;
				else if (placing) {
					// From the caller's location (the session's: subagents spawn none).
					const caller = await locator.locate(api.conversationId, api, context);
					if (args.env !== undefined && args.env !== caller.env && origin !== "owner")
						return reply("Another environment needs a turn the owner started.", {}, true);
					const placed = await placeTarget(locator, caller, args, context);
					if (typeof placed === "string") return reply(placed, {}, true);
					location = placed;
				}
			}
			// A subagent following the session works at its cwd.
			const session = location === null ? await locator.locate(ROOT_CONVERSATION_ID, api, context) : undefined;

			const result = await api.commit(async (tx) => {
				const state = await tx.doc(Subagents, ROOT_CONVERSATION_ID);
				const background = { ownership: { kind: "conversation" }, background: true } as const;
				if (action === "configure") {
					const target = state.agents[name];
					if (!target) return `No subagent named ${name}.`;
					await configure(tx, target.conversationId, {
						...change,
						...withExtras(tools, installed()),
						...(location ? { cwd: location.cwd } : session ? { cwd: session.cwd } : {}),
					});
					if (location) target.location = location;
					else if (location === null) delete target.location;
					target.team = true;
					target.history = true;
					target.model = `${change.model?.provider}/${change.model?.modelId}`;
					target.thinkingLevel = change.thinkingLevel ?? "off";
					target.tools = tools.map((tool) => tool.name);
					return `Configured ${name}.`;
				}
				if (action === "spawn") {
					if (Object.hasOwn(state.agents, name)) return `${name} already exists; use send.`;
					const anchor = await tx.createTask(Anchor, null, background);
					const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
					await configure(tx, child.id, {
						...change,
						extensions: { remove: [extension] }, // Subagents cannot start subagents.
						...withExtras(tools, installed()),
						...(location ? { cwd: location.cwd } : {}),
						instructions: `You are the subagent "${name}", working for a main agent. Do the requested work and answer concisely; your final answer is reported back to it. With the team tool you can ask the main agent a question or tell it something while you keep working, and message the other subagents.`,
					});
					state.agents[name] = {
						conversationId: child.id,
						model: `${change.model?.provider}/${change.model?.modelId}`,
						thinkingLevel: change.thinkingLevel ?? "off",
						tools: tools.map((tool) => tool.name),
						...(location ? { location } : {}),
						reported: [],
						team: true,
						history: true,
					};
				}
				const target = state.agents[name];
				if (!target) return `No subagent named ${name}.`;
				// Working with an archived subagent again brings it back.
				delete target.archived;
				// Subagents spawned before the team or history tools existed get them now.
				if (!target.team || !target.history) {
					const all = installed();
					const kept = target.tools.flatMap((tool) => all.filter((entry) => entry.name === tool).slice(0, 1));
					await configure(tx, target.conversationId, withExtras(kept, all));
					target.team = true;
					target.history = true;
				}
				const input = {
					name,
					conversationId: target.conversationId,
					message: message ?? "",
					followUp: action === "send" && followUp === true,
					...(origin === "owner" ? { origin } : {}),
				};
				state.reporters[api.taskId] = await tx.createTask(Reporter, input, background);
				return action === "send" ? `Sent to ${name}.` : `Started ${name}.`;
			}, context);
			const current = (await api.snapshot(Subagents, ROOT_CONVERSATION_ID, context))?.agents[name];
			return reply(
				result,
				current
					? {
							conversationId: current.conversationId,
							model: current.model,
							thinkingLevel: current.thinkingLevel,
							tools: current.tools,
							...locationDetails(current.location),
						}
					: {},
			);
		},
	});
	const extension = defineExtension({ name: SUBAGENT_EXTENSION, tasks: [Anchor, Reporter], tools: [tool] });
	return extension;
}

/**
 * A subagent's tools plus the ones every subagent has: `team`, which is deferred (only conversations whose `modelTools`
 * adds it are offered it), and the history tools among `installed`.
 */
function withExtras(tools: readonly ToolRegistration[], installed: readonly ToolRegistration[]) {
	const history = HISTORY_TOOLS.flatMap((name) => installed.filter((tool) => tool.name === name).slice(0, 1));
	return { tools: [...tools, teamTool, ...history], modelTools: { add: [teamTool] } };
}

/**
 * Subagents' messaging: to the main agent and to the other subagents of the same main agent (siblings), as structural
 * `p2.agent-message` inputs that start a turn like any input. Within one session, so no cross-session rule applies. No
 * automatic replies: loops are left to the prompt.
 */
const teamTool: ToolRegistration = defineTool({
	name: TEAM_TOOL,
	description: [
		"Message the main agent or the other subagents while you work, without ending your turn.",
		'- send (to: "parent" or a subagent name, message; optional intent "question" (default) or "note", steer):',
		"  delivers it as a message from you; it starts the receiver's turn if it is idle, else waits for its next step",
		"  (steer: true interrupts its current step). A question asks for a reply, which arrives as a message to you; a note needs none.",
		"- answer (name): the latest completed answer of another subagent.",
		"- list: the other subagents and whether they are working.",
		"Only message when it helps the work. Never send acknowledgements or thanks, and do not reply to notes.",
	].join("\n"),
	parameters: obj(
		{
			action: union([literal("send"), literal("answer"), literal("list")]),
			to: opt(str({ minLength: 1, maxLength: 200 })),
			name: opt(str({ minLength: 1, maxLength: 200 })),
			message: opt(str({ minLength: 1, maxLength: 32768 })),
			intent: opt(union([literal("question"), literal("note")])),
			steer: opt(bool()),
		},
		{ open: true },
	),
	// A send is admitted once per call (its request ID); list and answer only read.
	replay: "safe",
	deferred: true,
	execute: async (args, api, context) => {
		const reply = (text: string, isError = false) => ({
			output: [{ type: "text" as const, text }],
			details: { action: args.action, ...(args.to === undefined ? {} : { to: args.to }) },
			isError,
		});
		const registry = await api.snapshot(Subagents, ROOT_CONVERSATION_ID, context);
		const agents = Object.entries(registry?.agents ?? {});
		const self = agents.find(([, agent]) => agent.conversationId === api.conversationId)?.[0];
		if (self === undefined) return reply("Only subagents can use the team tool.", true);
		const siblings = agents.filter(([name]) => name !== self);
		if (args.action === "list") {
			const lines: string[] = [];
			for (const [name, agent] of siblings) {
				const busy = (await api.snapshot(LiveDoc, agent.conversationId, context))?.run !== undefined;
				lines.push(`${name}: ${busy ? "working" : "idle"}${agent.archived ? " · archived" : ""}`);
			}
			return reply(lines.length ? lines.join("\n") : "No other subagents.");
		}
		if (args.action === "answer") {
			const sibling = siblings.find(([name]) => name === args.name)?.[1];
			if (!sibling) return reply(`No other subagent named ${args.name ?? "(none)"}.`, true);
			const answer = await latestAnswer(api, sibling.conversationId, context);
			return reply(answer ?? `${args.name} has not answered yet.`);
		}
		if (!args.to) return reply('send needs to ("parent" or a subagent name).', true);
		if (!args.message?.trim()) return reply("send needs a message.", true);
		const sibling = args.to === "parent" ? undefined : siblings.find(([name]) => name === args.to)?.[1];
		if (args.to !== "parent" && !sibling) return reply(`No other subagent named ${args.to}.`, true);
		const target = await api.conversation(sibling?.conversationId ?? (await mainConversation(api, context)), context);
		if (!target) return reply(`${args.to} has no conversation.`, true);
		await target.submit(
			{
				type: "input",
				...agentMessageInput(
					{
						from: { name: self, conversationId: api.conversationId },
						intent: args.intent ?? "question",
						text: args.message,
					},
					sibling ? `team send to ${self}` : `subagent send to ${self}`,
				),
				whenBusy: args.steer ? "steer" : "followUp",
				requestId: `team:${api.taskId}:${api.callId}`,
			},
			context,
		);
		return reply(`Sent to ${args.to}.`);
	},
});

/** The `team` tool's extension: installed for every conversation, offered only to subagents (see `withTeam`). */
export const teamExtension = defineExtension({ name: "p2-subagent-team", tools: [teamTool] });

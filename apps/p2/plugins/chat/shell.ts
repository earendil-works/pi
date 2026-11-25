// User shell commands (`!cmd`/`!!cmd`) of the worker's conversations: each command is a job whose state shows its
// output while it runs; the run places the command's `p2.shell` entry before it ends, so the live block gives way to
// the entry without a gap. One command at a time per conversation; the session neither moves nor clones while one runs.

import type { ConversationId, Harness as DurableHarness } from "@earendil-works/pi-durable";
import { bool, int, map, nul, num, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import {
	authorSender,
	defineJob,
	defineState,
	defineTypedState,
	deriveTyped,
	type FacetHost,
	type JobCtx,
	type JsonValue,
	literal,
	local,
	method,
	type P2Principal,
	SHELL_ENTRY,
	SHELL_MAX_BYTES,
	SHELL_MAX_LINES,
	type ShellData,
	senderText,
	shellContextText,
	shellTail,
	until,
	withoutAbortSignal,
} from "@p2/app/v1";
import { conversationEnvironment, type ExecutionEnvironments, harnessOf, workerOf } from "@p2/app/v1/worker";
import { type LiveShell, LiveShellSchema, SHELL_BUSY } from "./contract.ts";

const CommandSchema = obj({
	conversation: int({ minimum: 1 }),
	command: str({ minLength: 1, maxLength: 100_000 }),
	/** `!` (true): the output joins the agent's context; `!!` (false): display only. */
	includeInContext: bool(),
	/** Closed, unlike the stored entry's author: job arguments are checked like method arguments. */
	author: obj({ kind: union([literal("owner"), literal("guest")]), id: str(), name: str() }),
	/** The caller's ID for the command, its `shellId`: a client shows the command under it before the state arrives. */
	requestId: str({ minLength: 1, maxLength: 200 }),
});
type Command = Static<typeof CommandSchema>;

/**
 * The worker's user shell commands (host-internal): each conversation's running command, and how to start and cancel
 * one. Chat's views show their conversation's command and pass the caller as its author.
 */
export const ShellCommands = local("p2.shell-commands", {
	version: 1,
	params: {},
	members: {
		/** The running (or finished, its entry not placed yet) command of each conversation, by conversation. */
		shells: map(LiveShellSchema),
		/**
		 * Starts a command; refuses while its conversation runs one (`SHELL_BUSY`). Its `shellId` is the caller's
		 * `requestId`; a retried `requestId` of the same author starts nothing (among the last 100 starts).
		 */
		start: method(CommandSchema, obj({ shellId: str() })),
		/** Cancels the running command `shellId`; resolves once it shows as cancelled, false when it is not running. */
		abort: method(obj({ shellId: str() }), obj({ aborted: bool() })),
	},
});

/** How often the live output is published at most (the bash tool's sampling, 100 KiB/s). */
const SAMPLE_MS = 200;

const OutputSchema = obj({
	output: str(),
	truncated: bool(),
	running: bool(),
	cancelled: bool(),
	exitCode: opt(num()),
	/** Where the environment kept the complete output, when it spilled. */
	fullOutputPath: opt(str()),
	error: opt(str()),
});
type Output = Static<typeof OutputSchema>;

/** A command's live output: the run's state document. */
const OutputDoc = defineTypedState("p2.shell-commands.output", {
	schema: OutputSchema,
	version: 1,
	initial: () => ({ output: "", truncated: false, running: true, cancelled: false }),
});

/** 2: the command's `requestId` (its `shellId`). */
const ShellJob = defineJob("p2.shell-commands.run", {
	version: 2,
	args: CommandSchema,
	result: nul(),
	state: OutputDoc,
});

type RunCtx = JobCtx<P2Principal, Output>;

/** Request keys (`author:requestId`) of recent starts and the command each started, oldest first. */
const Admitted = defineState("p2.shell-commands.admitted", {
	schema: obj({ starts: map(str()) }),
	version: 1,
	initial: () => ({ starts: {} }),
});

const MAX_ADMITTED = 100;

/** Serves `ShellCommands` (the chat worker facet). */
export function serveShellCommands(host: FacetHost): void {
	host.serve(ShellCommands, (_params, self) => {
		const harness = harnessOf(self);
		const worker = workerOf(self);
		const admitted = self.state(Admitted);
		const job = self.job(ShellJob, {
			run: async (command, ctx) => {
				try {
					await runCommand(command, harness().environments, ctx);
					await placeEntry(command, ctx, harness().durable);
					return null;
				} finally {
					worker().liveness.add("activeCalls", -1);
				}
			},
		});
		const shells = deriveTyped(self, [job.running], ([runs]) => {
			const byConversation: Record<string, LiveShell> = {};
			for (const run of runs)
				if (run.phase !== "blocked") byConversation[run.args.conversation] = liveShell(run.args, run.state);
			return byConversation;
		});
		const running = (shellId: string) =>
			Object.values(shells.value).some((shell) => shell.id === shellId && shell.running);
		return {
			shells,
			start: async (command, ctx) => {
				// A running command is work the session's fence waits for (a move, a clone), as a call is: counted from
				// before its start (the caller's own call still counts) until its run ends.
				worker().liveness.add("activeCalls", 1);
				let started = false;
				try {
					const result = await self.tx(async (tx) => {
						const starts = (await tx.draft(admitted)).starts;
						const key = `${command.author.id}:${command.requestId}`;
						if (starts[key] !== undefined) return { started: false };
						if (shells.value[command.conversation] !== undefined) throw new Error(SHELL_BUSY);
						starts[key] = tx.start(job, command).id;
						const keys = Object.keys(starts);
						for (const old of keys.slice(0, Math.max(0, keys.length - MAX_ADMITTED))) delete starts[old];
						return { started: true };
					}, ctx);
					started = result.started;
					return { shellId: command.requestId };
				} finally {
					if (!started) worker().liveness.add("activeCalls", -1);
				}
			},
			abort: async ({ shellId }, ctx) => {
				if (!running(shellId)) return { aborted: false };
				// `abort` resolves once the run ended, after placing its entry (at the next boundary while the agent works):
				// the caller waits only until the command shows as cancelled.
				const run = job.running.value.find((each) => each.phase !== "blocked" && each.args.requestId === shellId);
				if (run) await Promise.race([job.abort(run.id, ctx), until(shells, () => !running(shellId), ctx)]);
				return { aborted: true };
			},
		};
	});
}

/** A run as Chat shows it. */
function liveShell(command: Command, state: Output): LiveShell {
	return {
		id: command.requestId,
		command: command.command,
		author: command.author,
		includeInContext: command.includeInContext,
		output: state.output,
		truncated: state.truncated,
		running: state.running,
		cancelled: state.cancelled,
		...(state.exitCode === undefined ? {} : { exitCode: state.exitCode }),
		...(state.error === undefined ? {} : { error: state.error }),
	};
}

/**
 * Runs the command where its conversation works (a subagent's own location may be on another machine than the
 * session's), sampling its output into the run's state, which ends with how it ended.
 */
async function runCommand(command: Command, environments: ExecutionEnvironments, ctx: RunCtx): Promise<void> {
	let output = "";
	let truncated = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	// State changes are commits: chained, so the last one is the last written, and awaited before the run moves on.
	let writes: Promise<void> = Promise.resolve();
	const write = (change: (draft: Output) => void) => {
		writes = writes.then(() => ctx.state.change(change, ctx));
	};
	const sample = () => {
		timer = undefined;
		const [text, cut] = [output, truncated];
		write((draft) => {
			draft.output = text;
			draft.truncated = cut;
		});
	};
	let ended: Pick<Output, "exitCode" | "fullOutputPath" | "error"> = {};
	try {
		const { location, env } = await conversationEnvironment(
			environments,
			command.conversation as ConversationId,
			ctx,
		);
		const result = await env.exec(
			command.command,
			{
				cwd: location.cwd,
				inheritEnv: true,
				spill: { afterBytes: SHELL_MAX_BYTES, afterLines: SHELL_MAX_LINES },
				window: {
					maxBytes: SHELL_MAX_BYTES,
					maxLines: SHELL_MAX_LINES,
					minIntervalMs: SAMPLE_MS,
					bytesPerSecond: 100 * 1024,
				},
				onOutput: (text, _context, info) => {
					// The environment omitted output outside the kept tail: what follows replaces it.
					if (info.skipped) {
						output = "";
						truncated = true;
					}
					const tail = shellTail(output + text);
					output = tail.text;
					truncated ||= tail.truncated;
					timer ??= setTimeout(sample, SAMPLE_MS);
				},
			},
			ctx,
		);
		if (result.ok)
			ended = {
				exitCode: result.value.exitCode,
				...(result.value.spillPath ? { fullOutputPath: result.value.spillPath } : {}),
			};
		else if (result.error.code !== "aborted")
			ended = {
				error: result.error.code === "timeout" ? "Command timed out" : result.error.message,
				...(result.error.spillPath ? { fullOutputPath: result.error.spillPath } : {}),
			};
	} catch (error) {
		ended = { error: error instanceof Error ? error.message : String(error) };
	} finally {
		clearTimeout(timer);
	}
	// A command's last newline ends its output; it is not an empty last line.
	const final = output.replace(/\r?\n$/, "");
	const cancelled = ctx.abortSignal?.aborted === true;
	write((draft) => {
		Object.assign(draft, { output: final, truncated, running: false, cancelled, ...ended });
	});
	await writes;
}

/**
 * Places the finished command as its `p2.shell` entry and waits until it is placed. A write never starts a run; while
 * the agent works it is placed at the run's next boundary. A cancelled command is placed too: without the run's abort
 * signal.
 */
async function placeEntry(command: Command, ctx: RunCtx, durable: DurableHarness): Promise<void> {
	const { output, truncated, cancelled, exitCode, fullOutputPath, error } = ctx.state.value;
	const data: ShellData = {
		author: command.author,
		command: command.command,
		output,
		cancelled,
		truncated,
		includeInContext: command.includeInContext,
		...(exitCode === undefined ? {} : { exitCode }),
		...(fullOutputPath === undefined ? {} : { fullOutputPath }),
		...(error === undefined ? {} : { error }),
	};
	const context = withoutAbortSignal(ctx);
	const conversation = await durable.conversation(command.conversation as ConversationId, context);
	if (conversation === undefined) throw new Error(`Unknown conversation ${command.conversation}`);
	const model = [
		{
			role: "user" as const,
			content: [
				{ type: "text" as const, text: senderText(authorSender(command.author)) },
				{ type: "text" as const, text: shellContextText(data) },
			],
			timestamp: Date.now(),
		},
	];
	const submission = await conversation.submit(
		{
			type: "write",
			entry: {
				kind: SHELL_ENTRY,
				data: data as unknown as JsonValue,
				...(command.includeInContext ? { model } : {}),
			},
			requestId: `${command.author.id}:shell:${ctx.jobId}`,
		},
		context,
	);
	await submission.wait(context);
}

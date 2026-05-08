/**
 * Worker-loop mode: subscribe to a host-provided Unix-socket message bus and
 * run pi against each `agent_task_request` envelope.
 *
 * This mode is the in-pi replacement for boss-pi's throwaway
 * `scripts/worker-loop.ts` wrapper. It owns the socket dispatch loop,
 * heartbeats, idle-TTL exit, and `shutdown` envelope handling that previously
 * lived in Node glue.
 *
 * Bus envelope contract (from boss-pi `src/engine/SocietyMessages.ts`):
 *
 *   { kind: 'agent_task_request', taskId, projectId, milestoneId,
 *     prompt, model?, timeoutMs?, worktreePath }
 *   { kind: 'agent_task_result', inReplyTo, status, rawOutput, durationMs,
 *     errorMessage?, tokenUsage?, commits?, workingDiff? }
 *   { kind: 'heartbeat', agentId, projectId, inflightTaskId?, emittedAt }
 *   { kind: 'shutdown', toAgentId, reason }
 *
 * Pi-mono only owns the worker side of this contract: it does not generate
 * spawn approvals or task requests, only consumes them.
 */
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "../../core/agent-session.js";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.js";
import type { AgentSessionRuntimeDiagnostic } from "../../core/agent-session-services.js";
import { killTrackedDetachedChildren } from "../../utils/shell.js";
import { captureGitState, resolveHeadSha } from "./git-capture.js";
import { type AgentMessage, type AgentMessageRecipient, SocketBus, type SocketBusOptions } from "./socket-bus.js";

// =============================================================================
// Envelope types — mirror boss-pi's SocietyMessages.ts.
// =============================================================================

interface AgentTaskRequestEnvelope {
	kind: "agent_task_request";
	taskId: string;
	projectId: string;
	milestoneId: string;
	prompt: string;
	model?: string;
	timeoutMs?: number;
	worktreePath: string;
}

type AgentTaskStatus = "success" | "error" | "timeout";

interface AgentTaskTokenUsage {
	input: number;
	output: number;
	cached?: number;
}

interface AgentTaskResultEnvelope {
	kind: "agent_task_result";
	inReplyTo: string;
	status: AgentTaskStatus;
	rawOutput: string;
	durationMs: number;
	errorMessage?: string;
	tokenUsage?: AgentTaskTokenUsage;
	commits?: string[];
	workingDiff?: string;
}

interface HeartbeatEnvelope {
	kind: "heartbeat";
	agentId: string;
	projectId: string;
	inflightTaskId?: string;
	emittedAt: number;
}

interface ShutdownEnvelope {
	kind: "shutdown";
	toAgentId: string;
	reason: string;
}

// =============================================================================
// Public options
// =============================================================================

export interface WorkerLoopOptions {
	socketPath: string;
	agentId: string;
	agentType: string;
	projectId: string;
	idleTtlMs: number;
	heartbeatIntervalMs: number;
	repoPath: string;
	/** Override poll interval. Default 2000ms — matches the host wrapper. */
	pollIntervalMs?: number;
	/** Override the bus client (test seam). */
	bus?: SocketBus;
	/** Override `console` write target for fatal logs (test seam). */
	logger?: { error: (...args: unknown[]) => void };
}

export interface WorkerLoopRunResult {
	exitCode: number;
	exitReason: "shutdown" | "idle_ttl" | "input_error";
	tasksHandled: number;
}

/**
 * Validate worker-loop CLI options. Returns diagnostics; the caller decides
 * whether any error means abort.
 */
export function validateWorkerLoopOptions(
	options: Partial<WorkerLoopOptions>,
): { ok: true; options: WorkerLoopOptions } | { ok: false; diagnostics: AgentSessionRuntimeDiagnostic[] } {
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	const required: Array<keyof WorkerLoopOptions> = ["socketPath", "agentId", "agentType", "projectId", "repoPath"];
	for (const key of required) {
		const v = options[key];
		if (typeof v !== "string" || v.length === 0) {
			diagnostics.push({ type: "error", message: `worker-loop: --${kebab(String(key))} is required` });
		}
	}
	if (options.idleTtlMs !== undefined && (typeof options.idleTtlMs !== "number" || options.idleTtlMs <= 0)) {
		diagnostics.push({ type: "error", message: "worker-loop: --idle-ttl-ms must be a positive number" });
	}
	if (
		options.heartbeatIntervalMs !== undefined &&
		(typeof options.heartbeatIntervalMs !== "number" || options.heartbeatIntervalMs <= 0)
	) {
		diagnostics.push({
			type: "error",
			message: "worker-loop: --heartbeat-interval-ms must be a positive number",
		});
	}
	if (diagnostics.length > 0) return { ok: false, diagnostics };
	return {
		ok: true,
		options: {
			socketPath: options.socketPath as string,
			agentId: options.agentId as string,
			agentType: options.agentType as string,
			projectId: options.projectId as string,
			repoPath: options.repoPath as string,
			idleTtlMs: options.idleTtlMs ?? 60 * 60_000,
			heartbeatIntervalMs: options.heartbeatIntervalMs ?? 10_000,
			pollIntervalMs: options.pollIntervalMs ?? 2_000,
			bus: options.bus,
			logger: options.logger,
		},
	};
}

// =============================================================================
// Main entry
// =============================================================================

/**
 * Run the worker loop until a `shutdown` envelope arrives or idle-TTL
 * elapses. Returns the desired process exit code.
 *
 * The runtime is consumed in a loop: per task, the worker calls
 * `session.prompt()` against the existing rpc/print-mode plumbing, then
 * resets via `runtimeHost.newSession()` so state does not bleed between
 * tasks (the host wrapper used a fresh `PiAdapter.runOnce` per task — this
 * matches that contract).
 */
export async function runWorkerLoopMode(
	runtimeHost: AgentSessionRuntime,
	options: WorkerLoopOptions,
): Promise<WorkerLoopRunResult> {
	const logger = options.logger ?? console;
	const bus =
		options.bus ??
		new SocketBus({
			socketPath: options.socketPath,
			agentId: options.agentId,
			agentType: options.agentType,
		} satisfies SocketBusOptions);

	const state = {
		shouldExit: false,
		exitReason: "idle_ttl" as WorkerLoopRunResult["exitReason"],
		inflightTaskId: undefined as string | undefined,
		lastTaskRequestAt: Date.now(),
		tasksHandled: 0,
	};

	// Heartbeat every `heartbeatIntervalMs`. Best-effort — the host watchdog
	// also notices the gap independently.
	const heartbeatTimer = setInterval(() => {
		void publishHeartbeat(bus, options, state.inflightTaskId).catch((err) => {
			logger.error?.("worker-loop heartbeat failed:", err);
		});
	}, options.heartbeatIntervalMs);
	heartbeatTimer.unref?.();

	// Signal-driven shutdown: SIGTERM/SIGHUP exit cleanly.
	const signalCleanup: Array<() => void> = [];
	const installSignal = (signal: NodeJS.Signals) => {
		const handler = () => {
			killTrackedDetachedChildren();
			state.shouldExit = true;
			state.exitReason = "shutdown";
		};
		process.on(signal, handler);
		signalCleanup.push(() => process.off(signal, handler));
	};
	installSignal("SIGTERM");
	if (process.platform !== "win32") installSignal("SIGHUP");

	try {
		while (!state.shouldExit) {
			let messages: AgentMessage[] = [];
			try {
				messages = await bus.drain();
			} catch (err) {
				// A drain failure is transient — log and back off. Idle TTL still
				// applies via the elapsed-time check below.
				logger.error?.("worker-loop drain failed:", err);
				await sleep(options.pollIntervalMs ?? 2_000);
				continue;
			}

			for (const msg of messages) {
				if (state.shouldExit) break;
				const envelope = envelopeOf(msg);
				if (!envelope) continue;

				if (envelope.kind === "shutdown") {
					if (isShutdownForUs(envelope, options.agentId)) {
						state.shouldExit = true;
						state.exitReason = "shutdown";
						break;
					}
					continue;
				}

				if (envelope.kind === "agent_task_request") {
					await handleTaskRequest(envelope as AgentTaskRequestEnvelope, runtimeHost, bus, options, state);
				}
			}

			if (!state.shouldExit && Date.now() - state.lastTaskRequestAt >= options.idleTtlMs) {
				state.shouldExit = true;
				state.exitReason = "idle_ttl";
				break;
			}

			if (!state.shouldExit) {
				await sleep(options.pollIntervalMs ?? 2_000);
			}
		}

		return { exitCode: 0, exitReason: state.exitReason, tasksHandled: state.tasksHandled };
	} finally {
		clearInterval(heartbeatTimer);
		for (const cleanup of signalCleanup) cleanup();
		await runtimeHost.dispose().catch(() => {
			// Disposal can race against in-flight work; the worker exits
			// regardless — supervisor cleans up the container.
		});
	}
}

// =============================================================================
// Task dispatch
// =============================================================================

interface LoopState {
	shouldExit: boolean;
	exitReason: WorkerLoopRunResult["exitReason"];
	inflightTaskId: string | undefined;
	lastTaskRequestAt: number;
	tasksHandled: number;
}

async function handleTaskRequest(
	req: AgentTaskRequestEnvelope,
	runtimeHost: AgentSessionRuntime,
	bus: SocketBus,
	options: WorkerLoopOptions,
	state: LoopState,
): Promise<void> {
	state.lastTaskRequestAt = Date.now();
	state.inflightTaskId = req.taskId;
	const startedAt = Date.now();

	try {
		const result = await runOneTask(req, runtimeHost, options);
		await bus.publish(result, "leader");
		state.tasksHandled++;
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		const result: AgentTaskResultEnvelope = {
			kind: "agent_task_result",
			inReplyTo: req.taskId,
			status: "error",
			rawOutput: "",
			durationMs: Date.now() - startedAt,
			errorMessage,
		};
		await bus.publish(result, "leader").catch(() => {
			// Bus may be unreachable during shutdown — drop the result.
		});
	} finally {
		state.inflightTaskId = undefined;
	}
}

/**
 * Run a single task end-to-end:
 * - Resolve HEAD before running (for git-state capture).
 * - Reset to a fresh session so prior task state does not leak.
 * - Subscribe to events to collect raw text + usage.
 * - Call `session.prompt()` with the task prompt; await idle.
 * - Capture commits + working diff.
 * - Return an AgentTaskResult envelope.
 */
async function runOneTask(
	req: AgentTaskRequestEnvelope,
	runtimeHost: AgentSessionRuntime,
	_options: WorkerLoopOptions,
): Promise<AgentTaskResultEnvelope> {
	const startedAt = Date.now();
	const cwd = req.worktreePath;
	const headShaBefore = resolveHeadSha(cwd);

	// Each task starts from a clean slate — same shape as PiAdapter one-shot.
	await runtimeHost.newSession({});

	const session = runtimeHost.session;
	const collected: { text: string[]; usages: Usage[]; lastStopReason?: string; lastErrorMessage?: string } = {
		text: [],
		usages: [],
	};

	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "message_end" && event.message.role === "assistant") {
			const msg = event.message as AssistantMessage;
			collected.usages.push(msg.usage);
			collected.lastStopReason = msg.stopReason;
			if (msg.errorMessage) collected.lastErrorMessage = msg.errorMessage;
			for (const part of msg.content) {
				if (part.type === "text") collected.text.push(part.text);
			}
		}
	});

	let status: AgentTaskStatus = "success";
	let errorMessage: string | undefined;

	try {
		// Honour `timeoutMs` if present: race the prompt against a wall-clock
		// timeout; on timeout, abort the session so the loop can move on.
		const timeoutMs = typeof req.timeoutMs === "number" && req.timeoutMs > 0 ? req.timeoutMs : undefined;
		const promptPromise = session.prompt(req.prompt);
		if (timeoutMs !== undefined) {
			const timedOut = await raceTimeout(promptPromise, timeoutMs);
			if (timedOut) {
				try {
					await session.abort();
				} catch {
					// Abort can fail mid-stream — keep going so we still publish a result.
				}
				status = "timeout";
				errorMessage = `task ${req.taskId} timed out after ${timeoutMs}ms`;
			}
		} else {
			await promptPromise;
		}

		if (status === "success") {
			if (collected.lastStopReason === "error" || collected.lastStopReason === "aborted") {
				status = "error";
				errorMessage = collected.lastErrorMessage ?? `task ended with stopReason=${collected.lastStopReason}`;
			}
		}
	} catch (err) {
		status = "error";
		errorMessage = err instanceof Error ? err.message : String(err);
	} finally {
		unsubscribe();
	}

	const tokenUsage = aggregateUsage(collected.usages);
	const { commits, workingDiff } = captureGitState(cwd, headShaBefore);

	return {
		kind: "agent_task_result",
		inReplyTo: req.taskId,
		status,
		rawOutput: collected.text.join("\n").trim(),
		durationMs: Date.now() - startedAt,
		errorMessage,
		tokenUsage,
		commits: commits.length > 0 ? commits : undefined,
		workingDiff,
	};
}

// =============================================================================
// Helpers
// =============================================================================

function envelopeOf(msg: AgentMessage): { kind: string } | null {
	const payload = msg.payload as { kind?: unknown } | null | undefined;
	if (!payload || typeof payload.kind !== "string") return null;
	return payload as { kind: string };
}

function isShutdownForUs(envelope: { kind: string }, agentId: string): boolean {
	const target = (envelope as Partial<ShutdownEnvelope>).toAgentId;
	// Defense in depth: only honour shutdown directives addressed to us.
	// A broadcast-style shutdown without `toAgentId` is treated as not-for-us.
	return typeof target === "string" && target === agentId;
}

async function publishHeartbeat(
	bus: SocketBus,
	options: WorkerLoopOptions,
	inflightTaskId: string | undefined,
): Promise<void> {
	const hb: HeartbeatEnvelope = {
		kind: "heartbeat",
		agentId: options.agentId,
		projectId: options.projectId,
		inflightTaskId,
		emittedAt: Date.now(),
	};
	const to: AgentMessageRecipient = "broadcast";
	await bus.publish(hb, to);
}

function aggregateUsage(usages: Usage[]): AgentTaskTokenUsage | undefined {
	if (usages.length === 0) return undefined;
	let input = 0;
	let output = 0;
	let cached = 0;
	let sawCache = false;
	for (const u of usages) {
		input += u.input ?? 0;
		output += u.output ?? 0;
		const c = u.cacheRead ?? 0;
		if (c > 0) sawCache = true;
		cached += c;
	}
	const result: AgentTaskTokenUsage = { input, output };
	if (sawCache) result.cached = cached;
	return result;
}

async function raceTimeout(p: Promise<unknown>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<true>((resolve) => {
		timer = setTimeout(() => resolve(true), ms);
	});
	try {
		const settled = await Promise.race([p.then(() => false as const), timeout]);
		return settled === true;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function kebab(input: string): string {
	return input.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

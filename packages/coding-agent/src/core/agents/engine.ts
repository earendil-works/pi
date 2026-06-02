import type { ThinkingLevel } from "@valkyriweb/pi-agent-core";
import type { Api, Model } from "@valkyriweb/pi-ai";
import type { AgentHandle, ForkAgentOptions, ForkAgentResult } from "../extensions/types.ts";
import type { ReadonlySessionManager } from "../session-manager.ts";
import type { AgentToolInput } from "../tools/agent.ts";
import { type AgentToolExecutionInput, type AgentToolParentServices, executeAgentTool } from "./executor.ts";
import {
	cancelAgentRecentRun,
	findAgentRecentRun,
	interruptAgentRecentRun,
	resumeAgentRecentRun,
	waitForAgentRecentRun,
} from "./status.ts";
import type { AgentBackgroundCompletion, AgentExecutionProgress, AgentToolDetails, AgentToolStatus } from "./types.ts";

export const AGENTS_ENGINE_SERVICE_ID = "agents.engine";

export interface AgentParentSnapshot {
	activeTools: string[];
	sessionManager: ReadonlySessionManager;
	model: Model<Api> | undefined;
	thinkingLevel: ThinkingLevel;
	systemPrompt: string;
	signal?: AbortSignal;
}

export interface AgentEngineOptions {
	parentServices: AgentToolParentServices;
	getParentSnapshot(): AgentParentSnapshot;
	onBackgroundTerminal(notification: AgentBackgroundCompletion): void;
}

export interface AgentEngineRunOptions {
	signal?: AbortSignal;
	onProgress?: (progress: AgentExecutionProgress) => void;
}

export interface AgentEngine {
	run(input: AgentToolExecutionInput, options?: AgentEngineRunOptions): Promise<AgentToolDetails>;
	control(input: AgentToolInput): Promise<AgentToolDetails | undefined>;
	fork(opts: ForkAgentOptions): Promise<ForkAgentResult>;
	/** Live parent model/thinking snapshot, for UI labels (renderCall). */
	snapshot(): AgentParentSnapshot;
}

function controlDetailsFromRun(
	run: Awaited<ReturnType<typeof cancelAgentRecentRun>>["run"],
	message?: string,
): AgentToolDetails | undefined {
	if (!run) return undefined;
	return {
		mode: run.mode,
		status: run.status,
		runs: run.runs,
		runId: run.id,
		background: run.execution === "background",
		resumable: run.resumable,
		message,
	};
}

export function createAgentEngine(options: AgentEngineOptions): AgentEngine {
	const buildExecuteOptions = (runOptions?: AgentEngineRunOptions) => {
		const snapshot = options.getParentSnapshot();
		return {
			parentServices: options.parentServices,
			parentActiveTools: snapshot.activeTools,
			parentSessionManager: snapshot.sessionManager,
			parentModel: snapshot.model,
			parentThinkingLevel: snapshot.thinkingLevel,
			parentSystemPrompt: snapshot.systemPrompt,
			onBackgroundTerminal: options.onBackgroundTerminal,
			signal: runOptions?.signal,
			onProgress: runOptions?.onProgress,
		};
	};

	return {
		snapshot() {
			return options.getParentSnapshot();
		},
		async run(input, runOptions) {
			return executeAgentTool(input, buildExecuteOptions(runOptions));
		},
		async control(input) {
			const action = input.action;
			if (!action) throw new Error("Missing agent control action");
			if (action === "status" || action === "detail") return undefined;
			if (!input.runId) throw new Error(`agent control action ${action} requires runId`);
			if (action === "inject") {
				if (!input.message) throw new Error("agent control action inject requires message");
				await interruptAgentRecentRun(input.runId);
				const resumed = await resumeAgentRecentRun(input.runId, input.message);
				return controlDetailsFromRun(resumed.run, resumed.message);
			}
			const result =
				action === "interrupt"
					? await interruptAgentRecentRun(input.runId)
					: action === "cancel"
						? await cancelAgentRecentRun(input.runId)
						: await resumeAgentRecentRun(input.runId, input.message);
			return controlDetailsFromRun(result.run, result.message);
		},
		async fork(opts) {
			if (typeof opts?.prompt !== "string" || opts.prompt.length === 0) {
				throw new Error("forkAgent requires a non-empty prompt");
			}

			const snapshot = options.getParentSnapshot();
			const signals: AbortSignal[] = [];
			if (opts.signal) signals.push(opts.signal);
			if (snapshot.signal) signals.push(snapshot.signal);
			const forkSignal =
				signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);

			const details = await executeAgentTool(
				{
					mode: "single",
					background: true,
					tasks: [
						{
							// Route through a named agent definition when the caller asks
							// (e.g. "explore"); the executor resolves its tools/model/prompt
							// from the same registry the built-in agent tool uses. Defaults
							// to "general" to preserve prior forkAgent behaviour.
							agent: opts.agentType ?? "general",
							task: opts.prompt,
							description: opts.description,
							// Default "fork" preserves prior behaviour (inherit parent prefix).
							// Extensions wanting cache-stable prefixes pass "slim" or "none".
							context: opts.context ?? "fork",
							tools: opts.allowedTools,
							model: opts.model,
							maxOutputTokens: opts.maxOutputTokens,
							// Hard turn cap for the child loop (e.g. bounded extractor forks).
							maxTurns: opts.maxTurns,
							// When provided, fully replaces the auto-built child prompt — caller
							// owns every byte for byte-stable cross-session/cross-cwd cache reuse.
							systemPrompt: opts.systemPrompt,
							// Forwarded verbatim to the child's session_start event so a
							// launching extension can correlate the fork with per-call state.
							forkMetadata: opts.metadata,
							// Override the child cwd (e.g. a git worktree) for isolation.
							cwd: opts.cwd,
						},
					],
				},
				{
					parentServices: options.parentServices,
					parentActiveTools: snapshot.activeTools,
					parentSessionManager: snapshot.sessionManager,
					parentModel: snapshot.model,
					parentThinkingLevel: snapshot.thinkingLevel,
					// Capture the parent's frozen turn-start system prompt so the child's
					// first API call inherits byte-identical system + tools bytes and hits
					// the parent's cached prefix (see core/tools/agent.ts for the same
					// wiring used by the LLM-callable agent tool).
					parentSystemPrompt: snapshot.systemPrompt,
					// silent defaults to true — extension forks own their own transcript
					// feedback via ctx.transcript.append. Set silent:false to restore the
					// standard agent_completion notification.
					onBackgroundTerminal: opts.silent !== false ? undefined : options.onBackgroundTerminal,
					// Note: executor's background path replaces `signal` with its own
					// AbortController. We chain the caller's signal below via
					// cancelAgentRecentRun(runId) so abort still propagates.
				},
			);

			const runId = details.runId;
			if (!runId) {
				throw new Error("forkAgent: background run did not return a runId");
			}

			// Chain the caller's signal onto the background run. cancelAgentRecentRun
			// calls the registered controller's cancel(), which aborts every active
			// child session and drives the run to a terminal status within ~1s.
			if (forkSignal) {
				const onAbort = () => {
					void cancelAgentRecentRun(runId).catch(() => {});
				};
				if (forkSignal.aborted) {
					onAbort();
				} else {
					forkSignal.addEventListener("abort", onAbort, { once: true });
				}
			}

			const readStatus = (): AgentToolStatus => {
				const run = findAgentRecentRun(runId);
				return run?.status ?? details.status;
			};

			const toDetails = (run: ReturnType<typeof findAgentRecentRun>): AgentToolDetails => {
				if (run) {
					return {
						mode: run.mode,
						status: run.status,
						runs: run.runs,
						runId: run.id,
						background: run.execution === "background",
						resumable: run.resumable,
					};
				}
				return details;
			};

			const handle: AgentHandle = {
				get status() {
					return readStatus();
				},
				async wait() {
					const snapshot = findAgentRecentRun(runId);
					if (snapshot && snapshot.status !== "running") return toDetails(snapshot);
					const run = await waitForAgentRecentRun(runId);
					return toDetails(run);
				},
				async abort() {
					await cancelAgentRecentRun(runId);
				},
			};

			return { handle, sessionId: runId };
		},
	};
}

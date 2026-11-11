// Parent-scoped agent scheduling with child-owned sessions, resumable logs, and one writer per child.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	contentText,
	type ImageContent,
	type Model,
	type TextContent,
} from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../../config.ts";
import { raceWithAbortSignal } from "../../utils/abort.ts";
import type { AgentSession } from "../agent-session.ts";
import { serializeConversation } from "../compaction/utils.ts";
import { convertToLlm } from "../messages.ts";
import { resolveModelReference } from "../model-resolver.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import { generateDisplayName } from "../naming.ts";
import { DefaultResourceLoader } from "../resource-loader.ts";
import { createAgentSession } from "../sdk.ts";
import {
	loadEntriesFromFile,
	type ReadonlySessionManager,
	type SessionEntry,
	SessionManager,
	sessionEntryToContextMessages,
} from "../session-manager.ts";
import { SETTINGS_DEFAULTS } from "../settings-defaults.ts";
import { type Settings, SettingsManager } from "../settings-manager.ts";
import { allToolNames } from "../tools/index.ts";
import { truncateHead } from "../tools/truncate.ts";
import { addUsageToTotals, createUsageTotals } from "../usage-totals.ts";
import type { AgentDefinition } from "./definitions.ts";
import {
	readSubagentRecord,
	type SubagentEvent,
	type SubagentHistoryPage,
	type SubagentInfo,
	type SubagentRecord,
	type SubagentResult,
	subagentInfo,
	writeSubagentRecord,
} from "./state.ts";

export interface SubagentManagerOptions {
	parent: ReadonlySessionManager;
	cwd?: string;
	modelRuntime: ModelRuntime;
	getSettings(): Settings;
	getModel(): Model<string> | undefined;
	getThinkingLevel(): ThinkingLevel;
	getAllowedTools(): readonly string[];
	getSystemPrompt(): string;
	agentDir?: string;
}
export interface StartSubagentOptions {
	context?: string | (TextContent | ImageContent)[];
	delivery?: "sync" | "async";
	signal?: AbortSignal;
}
interface Work {
	record: SubagentRecord;
	history: SessionManager;
	task: string;
	controller: AbortController;
	session?: AgentSession;
	closing: boolean;
	release(): void;
	leaseLost?: Error;
	done: PromiseWithResolvers<SubagentResult>;
	operation: "prompt" | "recovery";
	ready: PromiseWithResolvers<void>;
	stopStatus?: "stopped" | "paused";
}
const supportedTools: ReadonlySet<string> = allToolNames;
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Own independent child histories and run at most the configured number of agents concurrently. */
export class SubagentManager {
	readonly directory: string | undefined;
	private readonly options: SubagentManagerOptions;
	private readonly agentDir: string;
	private readonly cwd: string;
	private readonly records = new Map<string, SubagentRecord>();
	private readonly memory = new Map<string, SessionManager>();
	private readonly work = new Map<string, Work>();
	private readonly running = new Set<string>();
	private readonly queue: Work[] = [];
	private readonly listeners = new Set<(event: SubagentEvent) => void>();
	private closed = false;
	private paused = false;
	private pauseRequest: AbortController | undefined;

	constructor(options: SubagentManagerOptions) {
		if (options.parent.getBranch().some((entry) => entry.type === "custom" && entry.customType === "pi.subagent")) {
			throw new Error("Recursive native sub-agent delegation is disabled");
		}
		this.options = options;
		this.cwd = resolve(options.cwd ?? options.parent.getCwd());
		this.agentDir = resolve(options.agentDir ?? getAgentDir());
		const file = options.parent.getSessionFile();
		if (file) {
			// Custom session IDs need not be globally unique or safe as filesystem components.
			const owner = createHash("sha256").update(resolve(file)).digest("hex");
			this.directory = join(this.agentDir, "subagents", owner);
		}
	}

	/** List this parent's children without loading their transcripts into the parent session. */
	list(): SubagentInfo[] {
		if (this.directory) {
			for (const id of this.records.keys()) if (!this.work.has(id)) this.records.delete(id);
			if (existsSync(this.directory)) {
				for (const id of readdirSync(this.directory)) {
					if (idPattern.test(id) && !this.work.has(id) && existsSync(join(this.childDirectory(id), "record.json")))
						this.records.set(id, this.readRecord(id));
				}
			}
		}
		return [...this.records.values()]
			.map((record) => this.info(record))
			.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
	}

	/** Inspect bounded metadata for one child; this does not join its chat to the parent. */
	inspect(id: string): SubagentInfo {
		return this.info(this.getRecord(id));
	}

	/** Return the latest submitted task only when explicitly requested by a caller or detail view. */
	task(id: string): string {
		return this.getRecord(id).task;
	}

	/** Return the frozen role definition so a caller can re-check project approval before resuming. */
	definition(id: string): AgentDefinition {
		return this.getRecord(id).role;
	}

	/** Submit a task, preserving role/model/tool configuration independently of future role-file changes. */
	start(role: AgentDefinition, task: string, options: StartSubagentOptions = {}): SubagentInfo {
		this.assertOpen();
		options.signal?.throwIfAborted();
		if (!task.trim()) throw new Error("A sub-agent task must not be empty");
		this.limit();
		const model = this.resolveModel(role);
		const allowed = this.options.getAllowedTools();
		const tools = role.tools
			? role.tools.filter((tool) => {
					if (!supportedTools.has(tool))
						throw new Error(
							`Sub-agent role ${role.name} requests unsupported tool ${tool}; child sessions use local built-in tools only`,
						);
					return allowed.includes(tool);
				})
			: allowed.filter((tool) => supportedTools.has(tool));
		const id = randomUUID();
		const now = Date.now();
		const record: SubagentRecord = {
			id,
			parentSessionId: this.options.parent.getSessionId(),
			originEntryId: this.options.parent.getLeafId(),
			runStartId: null,
			cwd: this.cwd,
			role,
			tools,
			model: { provider: model.provider, id: model.id },
			thinkingLevel: role.thinkingLevel ?? this.options.getThinkingLevel(),
			task,
			status: "queued",
			createdAt: now,
			updatedAt: now,
			run: 1,
			async: options.delivery === "async",
			preview: "",
			usage: createUsageTotals(),
		};
		const history = this.createHistory(record, options.context);
		record.runStartId = history.getLeafId();
		this.records.set(id, record);
		this.enqueue(record, history, task);
		return this.inspect(id);
	}

	/** Continue an existing child in its own session, never a branch of the parent's JSONL. */
	resume(id: string, task: string, options: Pick<StartSubagentOptions, "delivery" | "signal"> = {}): SubagentInfo {
		this.assertOpen();
		options.signal?.throwIfAborted();
		if (!task.trim()) throw new Error("A continuation message must not be empty");
		if (this.work.has(id)) throw new Error("Use message for an active child, or stop it before resuming");
		this.limit();
		const previous = this.getRecord(id);
		const history = this.directory ? SessionManager.open(this.historyPath(id)!) : this.memory.get(id)!;
		const hasInput = history.getEntries().some((entry) => entry.type === "message" && entry.message.role === "user");
		const nextTask = hasInput ? task : `${previous.task}\n\nContinuation instruction:\n${task}`;
		const record: SubagentRecord = {
			...previous,
			task: nextTask,
			label: undefined,
			labelError: undefined,
			originEntryId: this.options.parent.getLeafId(),
			runStartId: history.getLeafId(),
			status: "queued",
			updatedAt: Date.now(),
			run: previous.run + 1,
			async: options.delivery === "async",
			error: undefined,
		};
		this.enqueue(record, history, nextTask);
		this.records.set(id, record);
		return this.inspect(id);
	}

	/** List unfinished children not currently controlled by this instance, including leased crash remnants. */
	recoverable(): SubagentInfo[] {
		return this.list().filter(
			(agent) =>
				!this.work.has(agent.id) &&
				(agent.status === "interrupted" ||
					agent.status === "paused" ||
					agent.status === "running" ||
					agent.status === "queued"),
		);
	}

	/** Recover the same run and child history; project-role approval belongs to the calling UI. */
	recover(id: string): SubagentInfo {
		this.assertOpen();
		if (!this.recoverable().some((agent) => agent.id === id))
			throw new Error("This child has no interrupted work to recover");
		const previous = this.getRecord(id);
		const history = this.directory ? SessionManager.open(this.historyPath(id)!) : this.memory.get(id)!;
		const record: SubagentRecord = { ...previous, status: "queued", updatedAt: Date.now(), error: undefined };
		this.enqueue(record, history, record.task, "recovery");
		return this.inspect(id);
	}

	/** Park child execution at tool/request boundaries while keeping queued work and histories intact. */
	async pause(): Promise<void> {
		this.paused = true;
		const request = new AbortController();
		this.pauseRequest?.abort();
		this.pauseRequest = request;
		const owned = [...this.work.values()];
		for (const work of owned) {
			if (!this.running.has(work.record.id)) {
				work.record.status = "paused";
				this.save(work.record);
				this.emit(work.record.id, "status");
			}
		}
		try {
			await Promise.all(
				owned
					.filter((work) => this.running.has(work.record.id))
					.map(async (work) => {
						await raceWithAbortSignal(work.ready.promise, request.signal);
						if (request.signal.aborted || work.closing || !work.session) return;
						await work.session.recovery.pause();
						if (request.signal.aborted || work.closing || !this.work.has(work.record.id)) return;
						work.record.status = "paused";
						work.record.updatedAt = Date.now();
						this.save(work.record);
						this.emit(work.record.id, "status");
					}),
			);
		} catch (error) {
			if (!request.signal.aborted) throw error;
		}
	}

	/** Reopen owned child gates and start queued work without resubmitting any task. */
	continuePaused(): void {
		this.paused = false;
		this.pauseRequest?.abort();
		for (const work of this.work.values()) {
			if (work.record.status === "paused") {
				work.record.status = this.running.has(work.record.id) ? "running" : "queued";
				work.record.updatedAt = Date.now();
				this.save(work.record);
				this.emit(work.record.id, "status");
			}
			if (work.session && !work.session.recovery.needsRecovery) work.session.recovery.resume();
		}
		this.pump();
	}

	/** Send steering input to a running child or a durable follow-up to a queued child. */
	async message(id: string, text: string): Promise<SubagentInfo> {
		this.assertOpen();
		if (!text.trim()) throw new Error("A child message must not be empty");
		const work = this.work.get(id);
		if (!work) throw new Error("This child is not active in this Pi instance; use resume");
		if (work.closing) throw new Error("The child is finishing; use resume after it settles");
		if (work.session) await work.session.steer(text);
		else {
			work.task += `\n\nAdditional instruction:\n${text}`;
			work.record.task = work.task;
			this.save(work.record);
		}
		return this.inspect(id);
	}

	/** Wait for this child's current run; cancellation stops that child rather than discarding its log. */
	async wait(id: string, signal?: AbortSignal): Promise<SubagentResult> {
		const work = this.work.get(id);
		if (!work) {
			const info = this.inspect(id);
			if (info.status === "queued" || info.status === "running")
				throw new Error("This child is owned by another Pi instance");
			return this.result(id);
		}
		const abort = () => {
			void this.cancel(id).catch(work.done.reject);
		};
		signal?.addEventListener("abort", abort, { once: true });
		try {
			if (signal?.aborted) await this.cancel(id);
			const result = await work.done.promise;
			signal?.throwIfAborted();
			return result;
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	}

	/** Stop a queued or running child and retain all completed and partial conversation entries. */
	async cancel(id: string): Promise<SubagentInfo> {
		const work = this.work.get(id);
		if (!work) {
			const record = this.getRecord(id);
			if (
				record.status !== "queued" &&
				record.status !== "running" &&
				record.status !== "paused" &&
				record.status !== "interrupted"
			)
				return this.info(record);
			const release = this.acquire(id);
			try {
				record.status = "stopped";
				record.updatedAt = Date.now();
				this.save(record);
			} finally {
				release();
			}
			return this.info(record);
		}
		return this.stop(work, "stopped");
	}

	private async stop(work: Work, status: "stopped" | "paused"): Promise<SubagentInfo> {
		work.stopStatus = status;
		work.controller.abort();
		if (work.session) await work.session.abort();
		if (!this.running.has(work.record.id)) this.finish(work, status);
		return (await work.done.promise).agent;
	}

	/** Delete only a finished child owned by this parent; active or externally owned logs are protected. */
	remove(id: string): void {
		if (this.work.has(id)) throw new Error("Stop the sub-agent before deleting its history");
		this.getRecord(id);
		const release = this.acquire(id);
		try {
			if (this.directory) rmSync(this.childDirectory(id), { recursive: true });
			this.records.delete(id);
			this.memory.delete(id);
		} finally {
			release();
		}
		this.emit(id, "deleted");
	}

	/** Read a bounded page of original child messages, including full tool text, by character offset. */
	history(id: string, offset = 0, limit = 16000): SubagentHistoryPage {
		this.getRecord(id);
		const entries = this.entries(id);
		let text = "";
		for (const entry of entries) {
			const messages = sessionEntryToContextMessages(entry).filter((message) => message.role !== "system");
			const error =
				entry.type === "message" && entry.message.role === "assistant" ? entry.message.errorMessage : undefined;
			if (messages.length)
				text += `[message:${entry.id}]\n${serializeConversation(convertToLlm(messages), Infinity)}${error ? `\n[Assistant error]: ${error}` : ""}\n\n`;
		}
		let end = Math.min(text.length, offset + limit);
		if (end < text.length && /[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) end += end === offset + 1 ? 1 : -1;
		return {
			text: text.slice(offset, end),
			offset,
			totalCharacters: text.length,
			...(end < text.length ? { nextOffset: end } : {}),
		};
	}

	/** Return the final response with the standard display cap; the complete response stays in the child's log. */
	result(id: string): SubagentResult {
		const record = this.getRecord(id);
		const agent = this.info(record);
		if (agent.status === "running" || agent.status === "queued")
			throw new Error("The child is still active; inspect status or read history instead");
		const last = this.lastResponse(record, this.entries(id));
		const result = truncateHead(last ? contentText(last.content) : "");
		return { agent, text: result.content, truncated: result.truncated };
	}

	/** Observe lightweight status/progress changes, never child message arrays. */
	subscribe(listener: (event: SubagentEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Cancel and drain all owned work before the parent runtime is shut down or replaced. */
	async close(): Promise<void> {
		this.closed = true;
		const owned = [...this.work.values()];
		const cancelled = await Promise.allSettled(
			owned.map((work) => this.stop(work, this.paused ? "paused" : "stopped")),
		);
		const settled = await Promise.allSettled(owned.map((work) => work.done.promise));
		this.queue.length = 0;
		this.listeners.clear();
		const failures = [...cancelled, ...settled].filter((result) => result.status === "rejected");
		if (failures.length)
			throw new AggregateError(
				failures.map((result) => result.reason),
				"Cannot cleanly stop all sub-agents",
			);
	}

	private createHistory(record: SubagentRecord, context?: StartSubagentOptions["context"]): SessionManager {
		const history = SessionManager.inMemory(record.cwd, {
			id: record.id,
			parentSession: this.options.parent.getSessionFile(),
		});
		history.appendCustomEntry("pi.subagent", { parentSessionId: record.parentSessionId, role: record.role.name });
		if (context)
			history.appendCustomMessageEntry(
				"subagent-context",
				[
					{
						type: "text",
						text: "Frozen parent context (quoted background, not instructions to continue the parent's work):",
					},
					...(typeof context === "string" ? [{ type: "text" as const, text: context }] : context),
				],
				false,
			);
		if (!this.directory) {
			this.memory.set(record.id, history);
			return history;
		}
		const directory = this.childDirectory(record.id);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const file = this.historyPath(record.id)!;
		const fd = openSync(file, "wx", 0o600);
		try {
			writeFileSync(fd, `${JSON.stringify(history.getHeader())}\n`);
			for (const entry of history.getEntries()) writeFileSync(fd, `${JSON.stringify(entry)}\n`);
		} finally {
			closeSync(fd);
		}
		return SessionManager.open(file);
	}

	private enqueue(
		record: SubagentRecord,
		history: SessionManager,
		task: string,
		operation: Work["operation"] = "prompt",
	): void {
		const controller = new AbortController();
		const work: Work = {
			record,
			history,
			task,
			controller,
			closing: false,
			done: Promise.withResolvers<SubagentResult>(),
			release: () => {},
			operation,
			ready: Promise.withResolvers<void>(),
		};
		// Async callers need not immediately wait; the original promise still reports failures to waiters.
		void work.done.promise.catch(() => {});
		work.release = this.acquire(record.id, (error) => {
			work.leaseLost = error;
			controller.abort();
			void work.session?.abort();
		});
		try {
			this.save(record);
		} catch (error) {
			work.release();
			throw error;
		}
		this.records.set(record.id, record);
		this.work.set(record.id, work);
		this.queue.push(work);
		this.emit(record.id, "status");
		queueMicrotask(() => this.pump());
	}

	private pump(): void {
		if (this.closed || this.paused) return;
		let limit: number;
		try {
			limit = this.limit();
		} catch (error) {
			for (const work of this.queue.splice(0))
				this.finish(work, "failed", error instanceof Error ? error.message : String(error));
			return;
		}
		while (this.running.size < limit && this.queue.length) {
			const work = this.queue.shift()!;
			if (!this.work.has(work.record.id)) continue;
			this.running.add(work.record.id);
			void this.run(work).catch((error: unknown) =>
				this.finish(work, "failed", error instanceof Error ? error.message : String(error)),
			);
		}
	}

	private async run(work: Work): Promise<void> {
		const { record, controller } = work;
		let unsubscribe: (() => void) | undefined;
		let label: Promise<void> | undefined;
		let stopRecoveryWatch: (() => void) | undefined;
		let pauseFailure: unknown;
		let outcome: { status: "completed" | "failed" | "stopped" | "paused"; error?: string } = { status: "failed" };
		try {
			controller.signal.throwIfAborted();
			record.status = this.paused ? "paused" : "running";
			record.updatedAt = Date.now();
			this.save(record);
			this.emit(record.id, "status");
			const model = this.options.modelRuntime.getModel(record.model.provider, record.model.id);
			if (!model) throw new Error(`Sub-agent model is unavailable: ${record.model.provider}/${record.model.id}`);
			if (!record.label) label = this.generateLabel(work, model);
			void label?.catch(() => {});
			const parentSettings = this.options.getSettings();
			// A fresh loader preserves repository instructions, not parent extension closures or package-install side effects.
			const settingsManager = SettingsManager.inMemory({
				...parentSettings,
				packages: [],
				extensions: [],
				prompts: [],
			});
			const loader = new DefaultResourceLoader({
				cwd: record.cwd,
				agentDir: this.agentDir,
				settingsManager,
				noExtensions: true,
				noPromptTemplates: true,
				noThemes: true,
				appendSystemPrompt: [
					record.role.systemPrompt,
					"You are a delegated sub-agent with a separate conversation. Work only on the assigned task. The working tree is shared: preserve unrelated edits and avoid overlapping file ownership. You cannot delegate to further native sub-agents. Parent checkpoint references in a supplied snapshot belong to the parent; request missing information rather than inventing it. Report observed results, exact changes, verification, and blockers. Do not claim completion from launching a background command.",
				],
			});
			await loader.reload();
			controller.signal.throwIfAborted();
			const allowed = this.options.getAllowedTools();
			const tools = record.tools.filter((tool) => allowed.includes(tool));
			const created = await createAgentSession({
				cwd: record.cwd,
				agentDir: this.agentDir,
				modelRuntime: this.options.modelRuntime,
				model,
				thinkingLevel: record.thinkingLevel,
				sessionManager: work.history,
				settingsManager,
				resourceLoader: loader,
				tools,
			});
			work.session = created.session;
			stopRecoveryWatch = created.session.recovery.subscribe(() => {
				if (this.paused && !created.session.recovery.isPaused) {
					void created.session.recovery.pause().catch((error: unknown) => {
						pauseFailure = error;
						controller.abort();
						void created.session.abort();
					});
				}
			});
			if (this.paused)
				void created.session.recovery.pause().catch((error: unknown) => {
					pauseFailure = error;
					controller.abort();
					void created.session.abort();
				});
			work.ready.resolve();
			record.thinkingLevel = created.session.agent.state.thinkingLevel;
			unsubscribe = created.session.subscribe((event) => {
				if (event.type === "message_update" && event.message.role === "assistant") this.emit(record.id, "progress");
				if (event.type === "message_end") {
					// Public session events precede persistence in the same handler.
					queueMicrotask(() => {
						if (this.work.get(record.id) === work) this.emit(record.id, "message");
					});
				}
			});
			controller.signal.throwIfAborted();
			if (work.operation === "recovery") {
				if (created.session.recovery.needsRecovery) await created.session.recovery.recover();
				else {
					const entries = work.history.getEntries();
					const boundary = entries.findIndex((entry) => entry.id === record.runStartId);
					const hasInput = entries.some(
						(entry, index) => index > boundary && entry.type === "message" && entry.message.role === "user",
					);
					if (!hasInput) await created.session.prompt(work.task);
					else {
						// The task can settle before its manager publishes status (for example, while naming finishes).
						const saved = this.lastResponse(record, entries);
						if (!saved || saved.stopReason === "toolUse")
							throw new Error(
								"This child has no unfinished execution checkpoint. Inspect its history and explicitly resume it if further work is needed.",
							);
					}
				}
			} else {
				if (created.session.recovery.needsRecovery) await created.session.recovery.restore();
				await created.session.prompt(work.task);
			}
			const last = created.session.messages.findLast((message) => message.role === "assistant");
			if (controller.signal.aborted || last?.stopReason === "aborted")
				outcome = { status: work.stopStatus ?? "stopped" };
			else if (!last || last.stopReason === "error" || last.stopReason === "length")
				outcome = { status: "failed", error: last?.errorMessage ?? "Sub-agent did not complete its response" };
			else outcome = { status: "completed" };
		} catch (error) {
			outcome = {
				status: controller.signal.aborted ? (work.stopStatus ?? "stopped") : "failed",
				error:
					work.leaseLost?.message ??
					(controller.signal.aborted ? undefined : error instanceof Error ? error.message : String(error)),
			};
		} finally {
			work.ready.resolve();
			work.closing = true;
			unsubscribe?.();
			stopRecoveryWatch?.();
			if (pauseFailure) outcome = { status: "failed", error: `Cannot pause child: ${String(pauseFailure)}` };
			try {
				await label;
			} catch (error) {
				outcome = { status: "failed", error: `Cannot save task label: ${String(error)}` };
			}
			try {
				if (work.session) await work.session.abort();
			} catch (error) {
				outcome = { status: "failed", error: `Cannot drain child session: ${String(error)}` };
			} finally {
				try {
					work.session?.dispose();
				} catch (error) {
					outcome = { status: "failed", error: `Cannot dispose child session: ${String(error)}` };
				}
				// Do not release the log lease or permit resume until all child writers have stopped.
				this.finish(work, outcome.status, outcome.error);
			}
		}
	}

	private async generateLabel(work: Work, model: Model<string>): Promise<void> {
		const { record, controller } = work;
		const result = await generateDisplayName(this.options.modelRuntime, model, {
			kind: "subagent",
			subject: JSON.stringify({ role: record.role.name, task: work.task.slice(0, 6000) }),
			instructions: `${this.options.getSystemPrompt()}\n\nRole instructions:\n${record.role.systemPrompt}`,
			sessionId: `label:${record.id}:${record.run}`,
			signal: controller.signal,
		});
		if (work.leaseLost) return;
		if (result.response) {
			const response = result.response;
			work.history.appendUsage("subagent_label", response.provider, response.model, response.usage);
			addUsageToTotals(record.usage, response.usage);
		}
		if (!controller.signal.aborted) {
			if (result.status === "generated") record.label = result.name;
			else record.labelError = result.error;
		}
		this.save(record);
		this.emit(record.id, "status");
	}

	private finish(work: Work, status: "completed" | "failed" | "stopped" | "paused", error?: string): void {
		if (!this.work.has(work.record.id)) return;
		const record = work.record;
		record.status = status;
		record.error = error;
		record.updatedAt = Date.now();
		const totals = createUsageTotals();
		const entries = work.history.getEntries();
		for (const entry of entries) {
			if (entry.type === "message" && entry.message.role === "assistant")
				addUsageToTotals(totals, entry.message.usage);
			else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage)
				addUsageToTotals(totals, entry.message.usage);
			else if (
				(entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") &&
				entry.usage
			)
				addUsageToTotals(totals, entry.usage);
		}
		record.usage = totals;
		const last = this.lastResponse(record, entries);
		record.preview = last ? contentText(last.content).slice(-256) : "";
		let failure: unknown;
		try {
			if (!work.leaseLost) this.save(record);
		} catch (cause) {
			failure = cause;
			record.status = "failed";
			record.error = `Cannot persist child state: ${String(cause)}`;
		}
		try {
			work.release();
		} catch (cause) {
			if (!work.leaseLost) {
				failure = cause;
				record.error = `Cannot release child history lock: ${String(cause)}`;
			}
		}
		this.work.delete(record.id);
		this.running.delete(record.id);
		if (failure) work.done.reject(failure);
		else {
			const result = truncateHead(last ? contentText(last.content) : "");
			work.done.resolve({ agent: this.info(record), text: result.content, truncated: result.truncated });
		}
		this.emit(record.id, "status");
		queueMicrotask(() => this.pump());
	}

	private lastResponse(record: SubagentRecord, entries: SessionEntry[]): AssistantMessage | undefined {
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (entry.id === record.runStartId) break;
			if (entry.type === "message" && entry.message.role === "assistant") return entry.message;
		}
		return undefined;
	}

	private resolveModel(role: AgentDefinition): Model<string> {
		if (!role.model) {
			const model = this.options.getModel();
			if (!model) throw new Error("Select a model before starting a sub-agent");
			return model;
		}
		const resolved = resolveModelReference(
			{ text: role.model, thinkingSuffix: "none", fuzzy: true },
			this.options.modelRuntime.getModels(),
			(provider) => this.options.modelRuntime.hasConfiguredAuth(provider),
		);
		if (resolved.status !== "resolved") throw new Error(`Sub-agent model ${role.model} is ${resolved.status}`);
		return resolved.model;
	}
	private limit(): number {
		const value = this.options.getSettings().subagents?.maxConcurrent ?? SETTINGS_DEFAULTS.subagents.maxConcurrent;
		// Settings originate in unvalidated JSON; positivity/integrality are not expressible in their TS type.
		if (!Number.isSafeInteger(value) || value < 1)
			throw new Error("subagents.maxConcurrent must be a positive safe integer");
		return value;
	}
	private assertOpen(): void {
		if (this.closed) throw new Error("The parent sub-agent manager is closed");
	}
	private childDirectory(id: string): string {
		if (!idPattern.test(id)) throw new Error("Invalid sub-agent ID");
		return join(this.directory!, id);
	}
	private historyPath(id: string): string | undefined {
		return this.directory ? join(this.childDirectory(id), "session.jsonl") : undefined;
	}
	private readRecord(id: string): SubagentRecord {
		return readSubagentRecord(this.childDirectory(id), id, this.options.parent.getSessionId());
	}
	private getRecord(id: string): SubagentRecord {
		if (!idPattern.test(id)) throw new Error("Invalid sub-agent ID");
		const record = this.work.get(id)?.record ?? (this.directory ? this.readRecord(id) : this.records.get(id));
		if (!record) throw new Error(`Unknown sub-agent: ${id}`);
		this.records.set(id, record);
		return record;
	}
	private info(record: SubagentRecord): SubagentInfo {
		const info = subagentInfo(record, this.historyPath(record.id));
		if (
			!this.work.has(record.id) &&
			(info.status === "queued" || info.status === "running") &&
			this.directory &&
			!lockfile.checkSync(this.childDirectory(record.id))
		)
			info.status = "interrupted";
		return info;
	}
	private save(record: SubagentRecord): void {
		if (this.directory) writeSubagentRecord(this.childDirectory(record.id), record);
	}
	private entries(id: string): SessionEntry[] {
		const owner = this.work.get(id)?.history ?? this.memory.get(id);
		return owner
			? owner.getEntries()
			: loadEntriesFromFile(this.historyPath(id)!).filter(
					(entry): entry is SessionEntry => entry.type !== "session",
				);
	}
	private acquire(id: string, compromised?: (error: Error) => void): () => void {
		if (!this.directory) return () => {};
		return lockfile.lockSync(this.childDirectory(id), { retries: 0, onCompromised: compromised });
	}
	private emit(id: string, type: SubagentEvent["type"]): void {
		for (const listener of this.listeners) listener({ id, type });
	}
}

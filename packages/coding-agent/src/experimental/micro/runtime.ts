import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	applyEnvelope,
	type ConversationView,
	type Entry,
	type Envelope,
	Harness,
	JsonlStorage,
	kinds,
	type ModelRef,
	systemSections,
	type ViewEvent,
	type Watch,
} from "@earendil-works/pi-agent-core/experimental/pico3";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
	type AssistantMessage,
	type AuthEvent,
	type AuthPrompt,
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type ModelThinkingLevel,
	type Usage,
} from "@earendil-works/pi-ai";
import { findInitialModel } from "../../core/model-resolver.ts";
import { ModelRuntime } from "../../core/model-runtime.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { refreshModelCatalogs } from "../../modes/interactive/model-catalog-refresh.ts";
import type {
	AuthPromptRequest,
	MicroController,
	MicroNotice,
	MicroUsageView,
	MicroView,
	MicroViewSource,
} from "./api.ts";
import { createPicoModels, readModelsView } from "./models.ts";
import { selectSession } from "./sessions.ts";
import { createMicroTools } from "./tools.ts";

const DEFAULT_MODEL = { provider: "openai-codex", modelId: "gpt-5.6-sol" } as const;

const SYSTEM_PROMPT = [
	"You are an expert coding assistant working in a terminal.",
	"Use read to inspect files, bash to run commands, edit for precise changes, and write for new files or complete rewrites.",
	"Keep answers concise and technical.",
].join("\n");

export interface OpenMicroOptions {
	cwd?: string;
	continueSession?: boolean;
}

export interface OpenMicroResult {
	view: MicroViewSource;
	controller: MicroController;
	close(): Promise<void>;
}

export async function openMicro(options: OpenMicroOptions = {}): Promise<OpenMicroResult> {
	const location = await selectSession(options.cwd ?? process.cwd(), options.continueSession ?? false);
	let storage: JsonlStorage | undefined;
	let executionEnv: NodeExecutionEnv | undefined;
	try {
		const modelRuntime = await ModelRuntime.create();
		const settings = SettingsManager.create(location.cwd);
		const env = new NodeExecutionEnv({ cwd: location.cwd });
		executionEnv = env;
		const microTools = createMicroTools(env);
		const picoModels = createPicoModels(modelRuntime, microTools.modelMetadata);
		const selectedTools = microTools.declarations.map((tool) => tool.name);
		const preferredModel = modelRuntime.getModel(DEFAULT_MODEL.provider, DEFAULT_MODEL.modelId);
		const initial = location.created
			? preferredModel
				? { model: preferredModel, thinkingLevel: "medium" as const, fallbackMessage: undefined }
				: await findInitialModel({ scopedModels: [], isContinuing: false, modelRuntime })
			: undefined;
		const compaction = initial?.model ? settings.getCompactionSettings(initial.model) : undefined;
		const threshold =
			initial?.model && compaction?.enabled
				? Math.max(0, initial.model.contextWindow - compaction.reserveTokens)
				: 0;

		storage = await JsonlStorage.open(location.path);
		const pendingReports: unknown[] = [];
		let report: (error: unknown) => void = (error) => pendingReports.push(error);
		const harness = await Harness.open(
			storage,
			{
				models: picoModels,
				tools: microTools.declarations,
				root: {
					rewindable: {
						selectedTools,
						threshold,
						keepRecent: compaction?.keepRecentTokens ?? 20_000,
						...(initial?.model
							? {
									model: { provider: initial.model.provider, modelId: initial.model.id },
									thinkingLevel: initial.thinkingLevel,
								}
							: {}),
					},
				},
				onReport: (error) => report(error),
			},
			BACKGROUND_CONTEXT,
		);
		const root = await harness.root(BACKGROUND_CONTEXT);
		const config = await root.config.get(BACKGROUND_CONTEXT);
		if (JSON.stringify(config.selectedTools) !== JSON.stringify(selectedTools)) {
			await root.config.set({ selectedTools }, BACKGROUND_CONTEXT);
		}

		const namespace = harness.namespace("micro.system", {});
		harness.hooks(namespace, kinds.generation, {
			systemInstructions: ({ sections }) => {
				sections.set(systemSections.identity, SYSTEM_PROMPT);
				sections.set(systemSections.environment, { cwd: location.cwd });
			},
		});

		let watch: Watch = await root.watch(BACKGROUND_CONTEXT);
		let cumulativeUsage = await readUsageAccumulator(harness, root.id);
		let state: MicroView = {
			session: { id: location.id, path: location.path, cwd: location.cwd },
			conversation: structuredClone(watch.view),
			models: readModelsView(modelRuntime, false),
			usage: usageView(cumulativeUsage, watch.view, modelRuntime),
			notices: [],
		};
		const listeners = new Set<() => void>();
		let nextNoticeId = 1;
		let closed = false;
		const modelRefreshControllers = new Set<AbortController>();
		let loginController: AbortController | undefined;
		let pendingAuth:
			| {
					id: string;
					resolve(answer: string): void;
					reject(error: Error): void;
					signal?: AbortSignal;
					onAbort(): void;
			  }
			| undefined;

		const publish = (): void => {
			for (const listener of listeners) listener();
		};
		const update = (patch: Partial<MicroView>): void => {
			state = { ...state, ...patch };
			publish();
		};
		const notice = (level: MicroNotice["level"], message: string): void => {
			const notices = [...state.notices, { id: nextNoticeId++, level, message }].slice(-50);
			update({ notices });
		};
		const fail = (error: unknown): void => {
			const message = error instanceof Error ? error.message : String(error);
			if (error instanceof Error && error.name === "Faulted") update({ fatal: message });
			notice("error", message);
		};
		const foldEvent = (event: ViewEvent, previousCompaction: ConversationView["compaction"]): void => {
			if (event.type === "entry.added") accumulateUsage(cumulativeUsage, event.entry);
			else if (event.type === "warning") notice("warning", event.message);
			else if (event.type === "generation.failed") {
				notice(event.reason === "overflow" ? "info" : "error", event.detail);
			} else if (event.type === "compaction.failed") notice("error", `Compaction failed: ${event.detail}`);
			else if (event.type === "compaction.finished" && previousCompaction?.reason === "threshold") {
				notice("info", "Automatic compaction completed.");
			}
		};

		const envelopes: Envelope[] = [];
		let drainScheduled = false;
		let restartingWatch = false;
		const restartWatch = async (): Promise<void> => {
			if (closed || restartingWatch) return;
			restartingWatch = true;
			watch.stop();
			envelopes.length = 0;
			try {
				watch = await root.watch(BACKGROUND_CONTEXT);
				cumulativeUsage = await readUsageAccumulator(harness, root.id);
				state = {
					...state,
					conversation: structuredClone(watch.view),
					usage: usageView(cumulativeUsage, watch.view, modelRuntime),
				};
				attachWatch();
				publish();
			} catch (error) {
				fail(error);
			} finally {
				restartingWatch = false;
			}
		};
		const drain = (): void => {
			drainScheduled = false;
			while (!closed && envelopes.length > 0) {
				const envelope = envelopes.shift();
				if (!envelope) break;
				try {
					const previousCompaction = state.conversation.compaction;
					const conversation = applyEnvelope(state.conversation, envelope);
					state = { ...state, conversation };
					for (const event of envelope.events) foldEvent(event, previousCompaction);
					state = { ...state, usage: usageView(cumulativeUsage, conversation, modelRuntime) };
				} catch (error) {
					fail(error);
					void restartWatch();
					return;
				}
			}
			publish();
		};
		function attachWatch(): void {
			watch.start((envelope) => {
				envelopes.push(envelope);
				if (drainScheduled) return;
				drainScheduled = true;
				queueMicrotask(drain);
			});
		}
		attachWatch();
		report = (error) => {
			fail(error);
			if (watch.closed) void restartWatch();
		};
		for (const error of pendingReports) report(error);

		const command = async (operation: () => Promise<void>): Promise<void> => {
			if (state.fatal || closed) return;
			try {
				await operation();
			} catch (error) {
				fail(error);
			}
		};
		const refreshModels = async (): Promise<void> => {
			await command(async () => {
				update({ models: readModelsView(modelRuntime, true) });
				const controller = new AbortController();
				modelRefreshControllers.add(controller);
				const timeout = setTimeout(() => controller.abort(), 15_000);
				try {
					const result = await refreshModelCatalogs(modelRuntime, controller.signal);
					if (result.errors.size > 0) {
						notice("warning", `Could not refresh: ${[...result.errors.keys()].join(", ")}`);
					}
				} finally {
					clearTimeout(timeout);
					modelRefreshControllers.delete(controller);
					update({ models: readModelsView(modelRuntime, false) });
				}
			});
		};
		const clearPendingAuth = (error: Error): void => {
			const pending = pendingAuth;
			pendingAuth = undefined;
			if (!pending) return;
			pending.signal?.removeEventListener("abort", pending.onAbort);
			pending.reject(error);
		};
		const askAuth = (request: AuthPromptRequest, signal?: AbortSignal): Promise<string> => {
			if (signal?.aborted) return Promise.reject(new Error("Login cancelled"));
			clearPendingAuth(new Error("Login prompt replaced"));
			return new Promise<string>((resolve, reject) => {
				const id = randomUUID();
				const onAbort = (): void => {
					if (pendingAuth?.id !== id) return;
					pendingAuth = undefined;
					update({ auth: state.auth ? { ...state.auth, prompt: undefined } : undefined });
					reject(new Error("Login cancelled"));
				};
				pendingAuth = { id, resolve, reject, signal, onAbort };
				signal?.addEventListener("abort", onAbort, { once: true });
				if (state.auth) update({ auth: { ...state.auth, prompt: { id, request } } });
			});
		};
		const addAuthNotice = (authEvent: AuthEvent): void => {
			if (!state.auth) return;
			update({ auth: { ...state.auth, notices: [...state.auth.notices, structuredClone(authEvent)] } });
		};

		const controller: MicroController = {
			prompt: (text) =>
				command(async () => void (await root.send({ content: text, whenBusy: "reject" }, BACKGROUND_CONTEXT))),
			steer: (text) =>
				command(async () => void (await root.send({ content: text, whenBusy: "steer" }, BACKGROUND_CONTEXT))),
			followUp: (text) =>
				command(async () => void (await root.send({ content: text, whenBusy: "followUp" }, BACKGROUND_CONTEXT))),
			compact: (instructions) => command(async () => void (await root.collapse(instructions, BACKGROUND_CONTEXT))),
			abort: () =>
				command(async () => {
					const compactionTask = state.conversation.compaction?.taskId;
					await root.abort(BACKGROUND_CONTEXT);
					if (compactionTask !== undefined) await harness.abortTask(compactionTask, BACKGROUND_CONTEXT);
				}),
			cycleThinking: () =>
				command(async () => {
					const ref = modelRef(state.conversation.config.model);
					if (!ref) throw new Error("No model selected");
					const model = modelRuntime.getModel(ref.provider, ref.modelId);
					if (!model) throw new Error("Current model is unavailable");
					if (!model.reasoning) throw new Error("Current model does not support thinking");
					const levels = getSupportedThinkingLevels(model);
					const current = String(state.conversation.config.thinkingLevel ?? "off");
					const index = levels.indexOf(current as ModelThinkingLevel);
					const level = levels[(index + 1) % levels.length] ?? "off";
					await root.config.set({ thinkingLevel: level }, BACKGROUND_CONTEXT);
				}),
			setModel: (ref) =>
				command(async () => {
					const model = modelRuntime.getModel(ref.provider, ref.modelId);
					if (!model) throw new Error(`Unknown model: ${ref.provider}/${ref.modelId}`);
					const compact = settings.getCompactionSettings(model);
					const currentThinking = String(state.conversation.config.thinkingLevel ?? "off") as ModelThinkingLevel;
					await root.config.set(
						{
							model: ref,
							thinkingLevel: clampThinkingLevel(model, currentThinking),
							threshold: compact.enabled ? Math.max(0, model.contextWindow - compact.reserveTokens) : 0,
							keepRecent: compact.keepRecentTokens,
						},
						BACKGROUND_CONTEXT,
					);
				}),
			refreshModels,
			login: (providerId, authType) =>
				command(async () => {
					if (loginController) throw new Error("A login is already running");
					const account = state.models.accounts.find(
						(candidate) => candidate.id === providerId && candidate.authType === authType,
					);
					if (!account) throw new Error(`Unknown login method: ${providerId}/${authType}`);
					if (!account.interactive)
						throw new Error(`${account.methodName ?? "Authentication"} is configured outside pi`);
					loginController = new AbortController();
					update({
						auth: { providerId, providerName: account.name, authType, notices: [] },
					});
					try {
						await modelRuntime.login(providerId, authType, {
							signal: loginController.signal,
							prompt: ({ signal, ...request }: AuthPrompt) => askAuth(request, signal),
							notify: addAuthNotice,
						});
						notice("info", `Logged in to ${account.name}.`);
					} finally {
						clearPendingAuth(new Error("Login finished"));
						loginController = undefined;
						update({ auth: undefined, models: readModelsView(modelRuntime, false) });
					}
				}),
			replyAuth: (requestId, answer) =>
				command(async () => {
					const pending = pendingAuth;
					if (!pending || pending.id !== requestId) return;
					pendingAuth = undefined;
					pending.signal?.removeEventListener("abort", pending.onAbort);
					update({ auth: state.auth ? { ...state.auth, prompt: undefined } : undefined });
					if (answer === null) pending.reject(new Error("Login cancelled"));
					else pending.resolve(answer);
				}),
			cancelLogin: () =>
				command(async () => {
					loginController?.abort(new Error("Login cancelled"));
					clearPendingAuth(new Error("Login cancelled"));
					update({ auth: undefined });
				}),
		};

		const configuredModel = modelRef(state.conversation.config.model);
		if (configuredModel && !modelRuntime.getModel(configuredModel.provider, configuredModel.modelId)) {
			notice("warning", `Saved model is unavailable: ${configuredModel.provider}/${configuredModel.modelId}`);
		}
		harness.resume();

		return {
			view: {
				current: () => state,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			},
			controller,
			async close() {
				if (closed) return;
				closed = true;
				for (const controller of modelRefreshControllers) controller.abort(new Error("Micro closed"));
				loginController?.abort(new Error("Micro closed"));
				clearPendingAuth(new Error("Micro closed"));
				watch.stop();
				await harness.close(BACKGROUND_CONTEXT).catch(() => {});
				await env.cleanup(BACKGROUND_CONTEXT).catch(() => {});
				await location.release().catch(() => {});
			},
		};
	} catch (error) {
		await storage?.close(BACKGROUND_CONTEXT).catch(() => {});
		await executionEnv?.cleanup(BACKGROUND_CONTEXT).catch(() => {});
		await location.release().catch(() => {});
		throw error;
	}
}

interface UsageAccumulator {
	seen: Set<number>;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalCost: number;
	lastAssistantId: number;
	lastCacheHitRate?: number;
}

async function readUsageAccumulator(harness: Harness, conversationId: number): Promise<UsageAccumulator> {
	const accumulator: UsageAccumulator = {
		seen: new Set(),
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalCost: 0,
		lastAssistantId: 0,
	};
	let before: number | undefined;
	for (;;) {
		const page = await harness.entries(
			{ conversationId, limit: 256, ...(before === undefined ? {} : { before }) },
			BACKGROUND_CONTEXT,
		);
		for (const entry of page) accumulateUsage(accumulator, entry);
		if (page.length < 256) break;
		before = page.at(-1)?.id;
	}
	return accumulator;
}

function accumulateUsage(accumulator: UsageAccumulator, entry: Entry): void {
	if (accumulator.seen.has(entry.id)) return;
	accumulator.seen.add(entry.id);
	const assistant = assistantMessage(entry);
	const usage = assistant?.usage ?? usageRecord(entry);
	if (usage) {
		accumulator.input += usage.input;
		accumulator.output += usage.output;
		accumulator.cacheRead += usage.cacheRead;
		accumulator.cacheWrite += usage.cacheWrite;
		accumulator.totalCost += usage.cost.total;
	}
	if (
		assistant &&
		assistant.stopReason !== "aborted" &&
		assistant.stopReason !== "error" &&
		entry.id > accumulator.lastAssistantId
	) {
		accumulator.lastAssistantId = entry.id;
		const promptTokens = assistant.usage.input + assistant.usage.cacheRead + assistant.usage.cacheWrite;
		accumulator.lastCacheHitRate = promptTokens > 0 ? (assistant.usage.cacheRead / promptTokens) * 100 : undefined;
	}
}

function usageView(
	cumulative: UsageAccumulator,
	conversation: ConversationView,
	modelRuntime: ModelRuntime,
): MicroUsageView {
	const ref = modelRef(conversation.config.model);
	const contextWindow = ref ? (modelRuntime.getModel(ref.provider, ref.modelId)?.contextWindow ?? 0) : 0;
	const newestSummary = conversation.entries
		.filter((entry) => entry.kind === "pi.summary")
		.map((entry) => entry.id)
		.at(-1);
	const contextAssistant = [...conversation.entries].reverse().find((entry) => {
		const assistant = assistantMessage(entry);
		return (
			assistant !== undefined &&
			assistant.stopReason !== "aborted" &&
			assistant.stopReason !== "error" &&
			(newestSummary === undefined || entry.id > newestSummary)
		);
	});
	const contextUsage = contextAssistant ? assistantMessage(contextAssistant)?.usage : undefined;
	const contextTokens = contextUsage ? contextTokenCount(contextUsage) : null;
	const contextPercent = contextTokens === null || contextWindow <= 0 ? null : (contextTokens / contextWindow) * 100;
	return {
		input: cumulative.input,
		output: cumulative.output,
		cacheRead: cumulative.cacheRead,
		cacheWrite: cumulative.cacheWrite,
		totalCost: cumulative.totalCost,
		...(cumulative.lastCacheHitRate === undefined ? {} : { lastCacheHitRate: cumulative.lastCacheHitRate }),
		contextTokens,
		contextWindow,
		contextPercent,
	};
}

function assistantMessage(entry: Entry): AssistantMessage | undefined {
	const message = entry.model?.find((candidate) => candidate.role === "assistant");
	if (message) return message as unknown as AssistantMessage;
	if (entry.kind !== "pi.assistant" || !entry.data?.display) return undefined;
	return entry.data.display as unknown as AssistantMessage;
}

function usageRecord(entry: Entry): Usage | undefined {
	if (!entry.data?.usage) return undefined;
	return entry.data.usage as unknown as Usage;
}

function contextTokenCount(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function modelRef(value: unknown): ModelRef | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = value as { provider?: unknown; modelId?: unknown };
	return typeof candidate.provider === "string" && typeof candidate.modelId === "string"
		? { provider: candidate.provider, modelId: candidate.modelId }
		: undefined;
}

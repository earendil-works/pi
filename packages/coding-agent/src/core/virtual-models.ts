/**
 * Virtual models are catalog entries that route each request to a physical model.
 *
 * The selection (`model_change`, `agent.state.model`, `ctx.model`) may name a virtual model.
 * Everything below the routing step only sees physical models: providers stream them and
 * assistant messages record them. A virtual model never reaches a provider.
 *
 * Virtual models belong to a provider id but are not provider models. `ModelRuntime` keeps them
 * separately and adds them to the provider's catalog with `withVirtualModels()`, so any provider,
 * including one with physical models, can list several virtual models.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AnyModel,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	isModelType,
	lazyStream,
	type Message,
	type Model,
	type ModelThinkingLevel,
	type Provider,
	type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import type { SessionEntry } from "./session-manager.ts";

/** API id of virtual catalog entries. Requests for it fail unless routed first. */
export const VIRTUAL_MODEL_API = "pi-virtual";

/** Custom entry type that stores router state on the session branch. */
export const VIRTUAL_MODEL_STATE_ENTRY = "pi.virtual-model-state";

/** Data of a `pi.virtual-model-state` custom entry. */
export interface VirtualModelStateData<TState = unknown> {
	provider: string;
	modelId: string;
	state: TState;
}

const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Why a request is being routed.
 * - `user`: first request after a message the user wrote (prompt, steering, or follow-up)
 * - `continuation`: any other request in the agent loop, e.g. after tool results or extension messages
 * - `retry`: automatic retry after a failed request, including after compaction for a context overflow
 * - `direct`: a request outside the agent loop, e.g. a compaction summary or an extension call
 */
export type ModelRouteReason = "user" | "continuation" | "retry" | "direct";

export interface ModelRouteRequest<TState = unknown> {
	/** The selected virtual model. */
	model: Model<Api>;
	/** The selected thinking level. Its meaning is up to the router. */
	thinkingLevel: ModelThinkingLevel;
	reason: ModelRouteReason;
	/** Physical model and thinking level of the latest successful response in `messages`. */
	previous?: { model: Model<Api>; thinkingLevel?: ModelThinkingLevel };
	/**
	 * For `retry`: the failed request, which `messages` no longer contains. `message` carries its
	 * `stopReason` and `errorMessage`. Absent when the router itself failed.
	 */
	failed?: { model: Model<Api>; thinkingLevel?: ModelThinkingLevel; message: AssistantMessage };
	/**
	 * Router state last returned on this session branch. Undefined before the first state and for
	 * requests made outside a session, such as `ctx.modelRegistry.streamSimple()`.
	 */
	state?: TState;
	/** Conversation for this request, including system messages. */
	messages: readonly Message[];
	signal?: AbortSignal;
}

/** Physical model and thinking level for one request. */
export interface ModelRoute<TState = unknown> {
	model: Model<Api>;
	thinkingLevel: ModelThinkingLevel;
	/**
	 * New router state, stored on the session branch when it differs from `request.state`. Must be
	 * JSON-serializable. Undefined keeps the current state. Ignored for `direct` requests.
	 */
	state?: TState;
}

export interface VirtualModelDefinition<TState = unknown> {
	/** Provider the virtual model is listed under. May be a provider with physical models. */
	provider: string;
	/** Model id. Must not be the id of a physical model of `provider`. */
	id: string;
	name: string;
	/** Thinking levels offered for selection. Defaults to `["off"]`. */
	thinkingLevels?: readonly ModelThinkingLevel[];
	/**
	 * Limits shown before the first response. Afterwards, Pi uses the limits of the physical model
	 * that answered. Unset limits are unknown (0).
	 */
	contextWindow?: number;
	maxTokens?: number;
	/** Input types accepted for selection. Defaults to text and images; routed models without image support get placeholders. */
	input?: ("text" | "image")[];
	/** Pick the physical model, which must have credentials, and thinking level for one request. */
	route(request: ModelRouteRequest<TState>): ModelRoute<TState> | Promise<ModelRoute<TState>>;
}

/** Whether a model or message names a virtual model. Failed routing leaves the virtual model on its message. */
export function isVirtualModel(model: { api: string }): boolean {
	return model.api === VIRTUAL_MODEL_API;
}

/** Latest successful response. Its model is physical: failed or aborted requests, including failed routing, are skipped. */
export function findLatestResponse(messages: readonly AgentMessage[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted") {
			return message;
		}
	}
	return undefined;
}

/**
 * The model selection a session branch records. A virtual `model_change` holds until the next
 * `model_change`, because responses name the physical models it routed to. Otherwise the latest
 * physical response wins, as in sessions without virtual models. A virtual model that is no longer
 * registered does not hold, so the selection falls back to the physical model that answered last.
 */
export function getBranchSelection(
	branch: readonly SessionEntry[],
	getModel: (provider: string, modelId: string) => Model<Api> | undefined,
): { provider: string; modelId: string } | undefined {
	const isVirtual = (provider: string, modelId: string) => {
		const model = getModel(provider, modelId);
		return model !== undefined && isVirtualModel(model);
	};
	let selection: { provider: string; modelId: string } | undefined;
	for (const entry of branch) {
		if (entry.type === "model_change") {
			selection = { provider: entry.provider, modelId: entry.modelId };
		} else if (entry.type === "message" && entry.message.role === "assistant" && !isVirtualModel(entry.message)) {
			if (!selection || !isVirtual(selection.provider, selection.modelId)) {
				selection = { provider: entry.message.provider, modelId: entry.message.model };
			}
		}
	}
	return selection;
}

/** Latest router state a session branch stores for a virtual model. */
export function getVirtualModelState(branch: readonly SessionEntry[], provider: string, modelId: string): unknown {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "custom" || entry.customType !== VIRTUAL_MODEL_STATE_ENTRY) continue;
		const data = entry.data as VirtualModelStateData | undefined;
		if (data?.provider === provider && data.modelId === modelId) return data.state;
	}
	return undefined;
}

/** Build the catalog entry of a virtual model. */
export function createVirtualModel(definition: Omit<VirtualModelDefinition, "route">): Model<Api> {
	const levels = definition.thinkingLevels ?? ["off"];
	const thinkingLevelMap: ThinkingLevelMap = {};
	for (const level of THINKING_LEVELS) thinkingLevelMap[level] = levels.includes(level) ? level : null;
	return {
		id: definition.id,
		name: definition.name,
		api: VIRTUAL_MODEL_API,
		provider: definition.provider,
		baseUrl: "",
		reasoning: levels.some((level) => level !== "off"),
		thinkingLevelMap,
		input: definition.input ?? ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: definition.contextWindow ?? 0,
		maxTokens: definition.maxTokens ?? 0,
	};
}

/** Stream for a virtual model that was not routed, e.g. `stream()` with API-specific options. */
export function unroutedStream(model: Model<Api>): AssistantMessageEventStream {
	return lazyStream(model, async () => {
		throw new Error(`Virtual model ${model.provider}/${model.id} must be routed before streaming`);
	});
}

/**
 * Add virtual models to a provider's catalog. Without a provider, the result is a keyless provider
 * that only lists the virtual models. A virtual model hides a physical chat model with the same id,
 * which a catalog refresh can add after registration. Availability follows the provider's auth.
 */
export function withVirtualModels(
	providerId: string,
	provider: Provider | undefined,
	virtualModels: readonly Model<Api>[],
): Provider {
	if (!provider) {
		return {
			id: providerId,
			name: providerId,
			auth: { apiKey: { name: "Virtual model", resolve: async () => ({ auth: {}, source: "virtual" }) } },
			getModels: () => virtualModels,
			stream: unroutedStream,
			streamSimple: unroutedStream,
		};
	}
	const ids = new Set(virtualModels.map((model) => model.id));
	const physical = <TModel extends AnyModel>(models: readonly TModel[]) =>
		models.filter((model) => !isVirtualModel(model) && !(isModelType(model, "chat") && ids.has(model.id)));
	const virtual = <TModel extends AnyModel>(models: readonly TModel[]) =>
		models.filter((model) => isVirtualModel(model));
	const { filterModels, filterAllModels } = provider;
	return {
		...provider,
		getModels: () => [...physical(provider.getModels()), ...virtualModels],
		getAllModels: () => [...physical(provider.getAllModels?.() ?? provider.getModels()), ...virtualModels],
		filterModels: (models, credential) => {
			const real = physical(models);
			return [...(filterModels?.(real, credential) ?? real), ...virtual(models)];
		},
		filterAllModels:
			filterAllModels &&
			((models, credential) => [...filterAllModels(physical(models), credential), ...virtual(models)]),
		stream: (model, context, options) =>
			isVirtualModel(model) ? unroutedStream(model) : provider.stream(model, context, options),
		streamSimple: (model, context, options) =>
			isVirtualModel(model) ? unroutedStream(model) : provider.streamSimple(model, context, options),
	};
}

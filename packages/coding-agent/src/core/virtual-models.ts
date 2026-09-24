/**
 * Virtual models are catalog entries that route each request to a physical model.
 *
 * The selection (`model_change`, `agent.state.model`, `ctx.model`) may name a virtual model.
 * Everything below the routing step only sees physical models: providers stream them and
 * assistant messages record them. A virtual model never reaches a provider.
 */
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	lazyStream,
	type Message,
	type Model,
	type ModelThinkingLevel,
	type Provider,
	type ThinkingLevelMap,
} from "@earendil-works/pi-ai";

/** API id of virtual catalog entries. Requests for it fail unless routed first. */
export const VIRTUAL_MODEL_API = "pi-virtual";

const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Why a request is being routed.
 * - `user`: first request after a message the user wrote (prompt, steering, or follow-up)
 * - `continuation`: any other request in the agent loop, e.g. after tool results or extension messages
 * - `retry`: automatic retry after a failed request
 * - `direct`: a request outside the agent loop, e.g. a compaction summary or an extension call
 */
export type ModelRouteReason = "user" | "continuation" | "retry" | "direct";

export interface ModelRouteRequest {
	/** The selected virtual model. */
	model: Model<Api>;
	/** The selected thinking level. Its meaning is up to the router. */
	thinkingLevel: ModelThinkingLevel;
	reason: ModelRouteReason;
	/** Physical model and thinking level of the latest successful response in `messages`. */
	previous?: { model: Model<Api>; thinkingLevel?: ModelThinkingLevel };
	/** Conversation for this request, including system messages. */
	messages: readonly Message[];
	signal?: AbortSignal;
}

/** Physical model and thinking level for one request. */
export interface ModelRoute {
	model: Model<Api>;
	thinkingLevel: ModelThinkingLevel;
}

export interface VirtualModelDefinition {
	/** Provider id of the virtual model. The virtual model is the provider's only model. */
	provider: string;
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
	/**
	 * Pick the physical model and thinking level for one request. The model must be a physical
	 * catalog model whose provider has credentials.
	 */
	route(request: ModelRouteRequest): ModelRoute | Promise<ModelRoute>;
}

/** A keyless provider whose single model routes each request through `route`. */
export interface VirtualProvider extends Provider {
	route(request: ModelRouteRequest): ModelRoute | Promise<ModelRoute>;
}

export function isVirtualProvider(provider: Provider | undefined): provider is VirtualProvider {
	return typeof (provider as Partial<VirtualProvider> | undefined)?.route === "function";
}

/** Build the provider for a virtual model. Register it like any native provider. */
export function createVirtualProvider(definition: VirtualModelDefinition): VirtualProvider {
	const levels = definition.thinkingLevels ?? ["off"];
	const thinkingLevelMap: ThinkingLevelMap = {};
	for (const level of THINKING_LEVELS) thinkingLevelMap[level] = levels.includes(level) ? level : null;
	const model: Model<Api> = {
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
	// Only unrouted requests reach these, e.g. `stream()` with API-specific options.
	const unrouted = (): AssistantMessageEventStream =>
		lazyStream(model, async () => {
			throw new Error(`Virtual model ${model.provider}/${model.id} must be routed before streaming`);
		});
	return {
		id: definition.provider,
		name: definition.provider,
		auth: { apiKey: { name: "Virtual model", resolve: async () => ({ auth: {}, source: "virtual" }) } },
		getModels: () => [model],
		stream: unrouted,
		streamSimple: unrouted,
		route: (request) => definition.route(request),
	};
}

/** Record the thinking level on every message a stream emits, including its final result. */
export function withThinkingLevel(
	stream: AssistantMessageEventStream,
	thinkingLevel: ModelThinkingLevel,
): AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> } {
	return {
		async *[Symbol.asyncIterator]() {
			for await (const event of stream) {
				const message =
					event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
				message.thinkingLevel = thinkingLevel;
				yield event;
			}
		},
		async result() {
			const message = await stream.result();
			message.thinkingLevel = thinkingLevel;
			return message;
		},
	};
}

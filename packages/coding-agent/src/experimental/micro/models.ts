import type {
	Models as PicoModels,
	RequestOptions,
	SystemMessage,
} from "@earendil-works/pi-agent-core/experimental/pico3";
import type {
	Context as AiContext,
	AssistantMessageEvent,
	ConstrainedSamplingConfig,
	Message,
	Tool,
} from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import type { MicroModelsView, MicroProviderAccount } from "./api.ts";

export interface ModelToolMetadata {
	constrainedSampling?: false | ConstrainedSamplingConfig;
}

/** Adapt ModelRuntime's pi-ai request shape to Pico's durable request shape. */
export function createPicoModels(
	runtime: ModelRuntime,
	toolMetadata: ReadonlyMap<string, ModelToolMetadata>,
): PicoModels {
	return {
		resolve: (ref) => runtime.getModel(ref.provider, ref.modelId),
		async *stream(model, request, ctx): AsyncIterable<AssistantMessageEvent> {
			const stream = runtime.streamSimple(model, toAiContext(request, toolMetadata), {
				signal: ctx.abortSignal,
				...(request.thinkingLevel === "off" ? {} : { reasoning: request.thinkingLevel }),
			});
			for await (const event of stream) {
				if (event.type === "error" && event.reason === "aborted" && ctx.abortSignal?.aborted) {
					throw ctx.abortSignal.reason ?? new Error("aborted");
				}
				yield event;
			}
		},
		async fetchDeferred(model, handle, ctx) {
			const message = await runtime.fetchDeferred(model, handle, { signal: ctx.abortSignal });
			return message.stopReason === "deferred" && message.deferred !== undefined
				? { deferred: message.deferred }
				: message;
		},
		cancelDeferred: (model, handle, ctx) => runtime.cancelDeferred(model, handle, { signal: ctx.abortSignal }),
	};
}

function toAiContext(request: RequestOptions, toolMetadata: ReadonlyMap<string, ModelToolMetadata>): AiContext {
	const systemPrompt: string[] = [];
	const messages: Message[] = [];
	const tools = new Map<string, Tool>();
	for (const message of request.messages) {
		if (message.role !== "system") {
			messages.push(message as unknown as Message);
			continue;
		}
		const system = message as SystemMessage;
		if (system.content) systemPrompt.push(system.content);
		for (const removed of system.toolsRemoved ?? []) tools.delete(removed.name);
		for (const added of system.toolsAdded ?? []) {
			const metadata = toolMetadata.get(added.name);
			tools.set(added.name, {
				name: added.name,
				description: added.description,
				parameters: added.parameters as TSchema,
				...(metadata?.constrainedSampling === undefined
					? {}
					: { constrainedSampling: metadata.constrainedSampling }),
			});
		}
	}
	return {
		messages,
		...(systemPrompt.length === 0 ? {} : { systemPrompt: systemPrompt.join("\n\n") }),
		...(tools.size === 0 ? {} : { tools: [...tools.values()] }),
	};
}

export function readModelsView(runtime: ModelRuntime, refreshing: boolean): MicroModelsView {
	const models = runtime.getAvailableSnapshot().map((model) => ({
		provider: model.provider,
		modelId: model.id,
		name: model.name,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	}));
	const accounts: MicroProviderAccount[] = [];
	for (const provider of runtime.getProviders()) {
		const status = runtime.getProviderAuthStatus(provider.id);
		const shared = {
			id: provider.id,
			name: provider.name,
			configured: status.configured,
			...((status.label ?? status.source) === undefined ? {} : { source: status.label ?? status.source }),
		};
		if (provider.auth.oauth) {
			accounts.push({
				...shared,
				authType: "oauth",
				interactive: true,
				methodName: provider.auth.oauth.name,
			});
		}
		if (provider.auth.apiKey) {
			accounts.push({
				...shared,
				authType: "api_key",
				interactive: provider.auth.apiKey.login !== undefined,
				methodName: provider.auth.apiKey.name,
			});
		}
	}
	accounts.sort((left, right) => left.name.localeCompare(right.name));
	return { models, accounts, refreshing };
}

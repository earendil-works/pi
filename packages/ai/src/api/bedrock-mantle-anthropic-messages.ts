import type { Model, SimpleStreamOptions, StreamFunction } from "../types.ts";
import {
	type AnthropicOptions,
	stream as anthropicMessagesStream,
	streamSimple as anthropicMessagesStreamSimple,
} from "./anthropic-messages.ts";
import {
	type BedrockMantleAuthOptions,
	getRegionFromBedrockMantleBaseUrl,
	prepareBedrockMantleAuth,
} from "./bedrock-mantle-auth.ts";

export interface BedrockMantleAnthropicMessagesOptions extends AnthropicOptions, BedrockMantleAuthOptions {}

function getMantleAnthropicMessagesBaseUrl(region: string, modelBaseUrl: string | undefined): string {
	const path = modelBaseUrl ? new URL(modelBaseUrl).pathname.replace(/\/$/, "") : "/anthropic";
	return `https://bedrock-mantle.${region}.api.aws${path}`;
}

function withMantleAnthropicMessagesOptions(
	model: Model<"anthropic-messages">,
	options: BedrockMantleAnthropicMessagesOptions | undefined,
): { model: Model<"anthropic-messages">; options: AnthropicOptions } {
	const auth = prepareBedrockMantleAuth(options, {
		modelBaseUrl: model.baseUrl,
		headers: model.headers,
		baseUrlForRegion: (region) => getMantleAnthropicMessagesBaseUrl(region, model.baseUrl),
		regionFromBaseUrl: getRegionFromBedrockMantleBaseUrl,
	});
	const requestModel = { ...model, baseUrl: auth.baseUrl };

	if (auth.type === "bearer") {
		return {
			model: requestModel,
			options: {
				...options,
				apiKey: undefined,
				headers: { ...auth.headers, authorization: `Bearer ${auth.token}` },
			},
		};
	}

	return {
		model: requestModel,
		options: {
			...options,
			apiKey: auth.apiKey,
			headers: auth.headers,
			fetch: auth.fetch,
		},
	};
}

export const stream: StreamFunction<"anthropic-messages", BedrockMantleAnthropicMessagesOptions> = (
	model,
	context,
	options,
) => {
	const prepared = withMantleAnthropicMessagesOptions(model as Model<"anthropic-messages">, options);
	return anthropicMessagesStream(prepared.model, context, prepared.options);
};

export const streamSimple: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (model, context, options) => {
	const prepared = withMantleAnthropicMessagesOptions(
		model as Model<"anthropic-messages">,
		options as BedrockMantleAnthropicMessagesOptions | undefined,
	);
	return anthropicMessagesStreamSimple(prepared.model, context, prepared.options as SimpleStreamOptions);
};

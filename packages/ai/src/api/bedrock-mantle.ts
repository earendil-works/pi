// Bedrock Mantle: Amazon Bedrock's OpenAI-compatible endpoint, which serves
// models Converse does not (GPT, Grok, Gemma). This module reuses the OpenAI
// Responses implementation with the region filled into the catalog URL. It
// authenticates with a Bedrock API key when one is set, and otherwise signs
// each request with SigV4 using the AWS credential chain (profiles, IAM keys,
// SSO, ECS task roles, web identity), like Converse.
// https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-mantle.html

import type { Model, ProviderEnv, SimpleStreamOptions, StreamFunction, TranscriptContext } from "../types.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { loadMantleSigV4Module } from "./bedrock-mantle-sigv4.lazy.ts";
import { lazyStream } from "./lazy.ts";
import {
	type OpenAIResponsesOptions,
	stream as responsesStream,
	streamSimple as responsesStreamSimple,
} from "./openai-responses.ts";

/** The region Mantle requests go to, resolved like Bedrock Converse requests. */
export function resolveMantleRegion(env: ProviderEnv | undefined): string {
	return getProviderEnvValue("AWS_REGION", env) || getProviderEnvValue("AWS_DEFAULT_REGION", env) || "us-east-1";
}

/** The Bedrock API key for Mantle: a stored credential or `AWS_BEARER_TOKEN_BEDROCK`. */
export function resolveMantleBearerToken(apiKey: string | undefined, env: ProviderEnv | undefined): string | undefined {
	return apiKey || getProviderEnvValue("AWS_BEARER_TOKEN_BEDROCK", env) || undefined;
}

// The OpenAI SDK requires an API key. SigV4 requests replace its Authorization header.
const SIGV4_PLACEHOLDER_API_KEY = "bedrock-mantle-sigv4";

async function prepare<TOptions extends OpenAIResponsesOptions | SimpleStreamOptions>(
	model: Model<"openai-responses">,
	options: TOptions | undefined,
): Promise<{ model: Model<"openai-responses">; options: TOptions }> {
	const region = resolveMantleRegion(options?.env);
	const resolvedModel = { ...model, baseUrl: model.baseUrl.replace("{region}", region) };
	const bearerToken = resolveMantleBearerToken(options?.apiKey, options?.env);
	if (bearerToken) return { model: resolvedModel, options: { ...options, apiKey: bearerToken } as TOptions };
	return {
		model: resolvedModel,
		options: {
			...options,
			apiKey: SIGV4_PLACEHOLDER_API_KEY,
			fetch: (await loadMantleSigV4Module()).createMantleSigV4Fetch({
				region,
				env: options?.env,
				profile: (options as { profile?: string } | undefined)?.profile,
				fetch: options?.fetch,
			}),
		} as TOptions,
	};
}

export const stream: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options?: OpenAIResponsesOptions,
): AssistantMessageEventStream =>
	lazyStream(model, async () => {
		const prepared = await prepare(model, options);
		return responsesStream(prepared.model, context, prepared.options);
	});

export const streamSimple: StreamFunction<"openai-responses", SimpleStreamOptions> = (
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream =>
	lazyStream(model, async () => {
		const prepared = await prepare(model, options);
		return responsesStreamSimple(prepared.model, context, prepared.options);
	});

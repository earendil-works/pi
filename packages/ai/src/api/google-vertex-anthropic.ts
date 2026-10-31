// Claude on Vertex AI. Vertex serves Anthropic's Messages API at per-model
// `rawPredict` endpoints with Google OAuth instead of an Anthropic key, so this
// module reuses the Anthropic Messages implementation and rewrites its requests:
// the model moves from the body into the URL, and the body names the Vertex
// API version.
// https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude/use-claude

import { GoogleAuth } from "google-auth-library";
import type { Model, ProviderEnv, SimpleStreamOptions, StreamFunction, TranscriptContext } from "../types.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import {
	type AnthropicOptions,
	stream as anthropicStream,
	streamSimple as anthropicStreamSimple,
} from "./anthropic-messages.ts";
import { lazyStream } from "./lazy.ts";

export const VERTEX_ANTHROPIC_VERSION = "vertex-2023-10-16";
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

export interface VertexAnthropicTarget {
	project: string;
	location: string;
}

/** The Vertex host for a location. The `global` location has no regional prefix. */
export function vertexHost(location: string): string {
	return location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
}

/**
 * Wrap `fetch` so Anthropic SDK requests reach Vertex: `/v1/messages` becomes
 * `…/publishers/anthropic/models/{model}:streamRawPredict` (or `rawPredict`),
 * token counting becomes `count-tokens:rawPredict`, and the Google access token
 * replaces Anthropic's key header. Other requests pass through unchanged.
 */
export function createVertexAnthropicFetch(
	target: VertexAnthropicTarget,
	accessToken: string,
	baseFetch: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
	const modelsPath = `/v1/projects/${target.project}/locations/${target.location}/publishers/anthropic/models`;
	return async (input, init) => {
		const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
		const endpoint = /\/v1\/messages(\/count_tokens)?$/.exec(url.pathname);
		if (!endpoint || typeof init?.body !== "string") return baseFetch(input, init);

		const { model, ...body } = JSON.parse(init.body) as { model?: string; stream?: boolean };
		const path = endpoint[1]
			? `${modelsPath}/count-tokens:rawPredict`
			: `${modelsPath}/${model}:${body.stream ? "streamRawPredict" : "rawPredict"}`;
		const headers = new Headers(init.headers);
		headers.delete("x-api-key");
		headers.set("authorization", `Bearer ${accessToken}`);
		return baseFetch(`https://${vertexHost(target.location)}${path}`, {
			...init,
			headers,
			// Token counting keeps the model in the body.
			body: JSON.stringify({
				anthropic_version: VERTEX_ANTHROPIC_VERSION,
				...(endpoint[1] ? { model } : {}),
				...body,
			}),
		});
	};
}

function resolveTarget(env: ProviderEnv | undefined): VertexAnthropicTarget {
	const project = getProviderEnvValue("GOOGLE_CLOUD_PROJECT", env) || getProviderEnvValue("GCLOUD_PROJECT", env);
	if (!project) {
		throw new Error("Claude on Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT or GCLOUD_PROJECT.");
	}
	const location = getProviderEnvValue("GOOGLE_CLOUD_LOCATION", env);
	if (!location) throw new Error("Claude on Vertex AI requires a location. Set GOOGLE_CLOUD_LOCATION.");
	return { project, location };
}

// One GoogleAuth per credentials file, so access tokens are cached and refreshed.
const authClients = new Map<string, GoogleAuth>();

async function getAccessToken(env: ProviderEnv | undefined): Promise<string> {
	const keyFilename = getProviderEnvValue("GOOGLE_APPLICATION_CREDENTIALS", env);
	let auth = authClients.get(keyFilename ?? "");
	if (!auth) {
		// Browser bundles replace google-auth-library with an empty module.
		if (typeof GoogleAuth !== "function") throw new Error("Claude on Vertex AI requires Node.js or Bun.");
		auth = new GoogleAuth({ scopes: CLOUD_PLATFORM_SCOPE, ...(keyFilename ? { keyFilename } : {}) });
		authClients.set(keyFilename ?? "", auth);
	}
	const token = await auth.getAccessToken();
	if (!token) {
		// Vertex API keys only work for Google's own models.
		throw new Error(
			"Claude on Vertex AI requires Application Default Credentials or a service account; API keys are not supported.",
		);
	}
	return token;
}

async function prepare<TOptions extends AnthropicOptions | SimpleStreamOptions>(
	model: Model<"anthropic-messages">,
	options: TOptions | undefined,
): Promise<{ model: Model<"anthropic-messages">; options: TOptions }> {
	const target = resolveTarget(options?.env);
	const accessToken = await getAccessToken(options?.env);
	return {
		model: { ...model, baseUrl: `https://${vertexHost(target.location)}` },
		options: {
			...options,
			apiKey: accessToken,
			fetch: createVertexAnthropicFetch(target, accessToken, options?.fetch),
		} as TOptions,
	};
}

export const stream: StreamFunction<"anthropic-messages", AnthropicOptions> = (
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	options?: AnthropicOptions,
): AssistantMessageEventStream =>
	lazyStream(model, async () => {
		const prepared = await prepare(model, options);
		return anthropicStream(prepared.model, context, prepared.options);
	});

export const streamSimple: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream =>
	lazyStream(model, async () => {
		const prepared = await prepare(model, options);
		return anthropicStreamSimple(prepared.model, context, prepared.options);
	});

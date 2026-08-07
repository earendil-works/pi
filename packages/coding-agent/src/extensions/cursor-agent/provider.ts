import type { AuthResult, Model, Provider, RefreshModelsContext, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { CursorAgentCliDeps } from "../../core/cursor-agent-cli.ts";
import {
	CursorAgentCliError,
	formatNotAuthenticatedMessage,
	runCursorAgentListModels,
	runCursorAgentStatus,
} from "../../core/cursor-agent-cli.ts";
import { streamCursorAgent } from "./stream.ts";

export const CURSOR_PROVIDER_ID = "cursor";
export const CURSOR_AGENT_API = "cursor-agent-cli";
export const CURSOR_AGENT_BASE_URL = "cli://cursor-agent";

/** Placeholder limits — Cursor CLI does not expose per-model windows to Pi. */
export const CURSOR_DEFAULT_CONTEXT_WINDOW = 128_000;
export const CURSOR_DEFAULT_MAX_TOKENS = 8_192;

const AUTH_SOURCE = "cursor-agent CLI session";

function toPiModel(id: string, name: string): Model<typeof CURSOR_AGENT_API> {
	const reasoning = /thinking/i.test(name) || /thinking/i.test(id);
	return {
		id,
		name,
		api: CURSOR_AGENT_API,
		provider: CURSOR_PROVIDER_ID,
		baseUrl: CURSOR_AGENT_BASE_URL,
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: CURSOR_DEFAULT_CONTEXT_WINDOW,
		maxTokens: CURSOR_DEFAULT_MAX_TOKENS,
	};
}

async function isAuthenticatedSession(
	deps: CursorAgentCliDeps,
	signal: AbortSignal,
): Promise<{ ok: true } | { ok: false; reason?: string }> {
	try {
		const status = await runCursorAgentStatus({ ...deps, signal });
		if (!status.isAuthenticated) {
			return { ok: false, reason: formatNotAuthenticatedMessage() };
		}
		return { ok: true };
	} catch (error) {
		if (error instanceof CursorAgentCliError && error.code === "binary_not_found") {
			return { ok: false, reason: error.message };
		}
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
}

export interface CursorAgentProviderController {
	provider: Provider<typeof CURSOR_AGENT_API>;
}

export function createCursorAgentProvider(deps: CursorAgentCliDeps = {}): CursorAgentProviderController {
	let models: readonly Model<typeof CURSOR_AGENT_API>[] = [];

	const provider: Provider<typeof CURSOR_AGENT_API> = {
		id: CURSOR_PROVIDER_ID,
		name: "Cursor",
		baseUrl: CURSOR_AGENT_BASE_URL,
		auth: {
			apiKey: {
				name: "Cursor CLI session",
				// Ambient-only: credentials live in the Cursor CLI login session, not auth.json.
				check: async ({ signal }) => {
					const result = await isAuthenticatedSession(deps, signal);
					return result.ok ? { type: "api_key", source: AUTH_SOURCE } : undefined;
				},
				resolve: async ({ signal }): Promise<AuthResult | undefined> => {
					const result = await isAuthenticatedSession(deps, signal);
					if (!result.ok) return undefined;
					return {
						auth: { apiKey: "local", baseUrl: CURSOR_AGENT_BASE_URL },
						source: AUTH_SOURCE,
					};
				},
			},
		},
		getModels: () => models,
		refreshModels: async (context: RefreshModelsContext): Promise<void> => {
			if (context.stored) {
				const restored = context.stored.models.filter(
					(model): model is Model<typeof CURSOR_AGENT_API> =>
						model.provider === CURSOR_PROVIDER_ID && model.api === CURSOR_AGENT_API,
				);
				if (
					!(await context.publish({
						update: () => {
							models = restored;
						},
					}))
				) {
					return;
				}
			}

			if (context.signal.aborted) return;

			// Local CLI sidecar is not an HTTP catalog fetch — allow even when allowNetwork is false
			// so `--offline` still discovers Cursor Team models from the machine login session.
			const auth = await isAuthenticatedSession(deps, context.signal);
			if (!auth.ok) {
				if (!context.stored) {
					await context.publish({
						update: () => {
							models = [];
						},
					});
				}
				return;
			}

			try {
				const listed = await runCursorAgentListModels({ ...deps, signal: context.signal });
				if (context.signal.aborted) return;
				const refreshed = listed.map((entry) => toPiModel(entry.id, entry.name));
				await context.publish({
					persist: { models: refreshed, checkedAt: Date.now() },
					update: () => {
						models = refreshed;
					},
				});
			} catch {
				// Retain previous / restored catalog on failure.
			}
		},
		stream: (model, context, options) =>
			streamCursorAgent(model, context, options as SimpleStreamOptions | undefined, deps),
		streamSimple: (model, context, options) => streamCursorAgent(model, context, options, deps),
	};

	return { provider };
}

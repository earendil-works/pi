import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropicOAuth } from "../src/auth/oauth/anthropic.ts";
import { openaiCodexOAuth } from "../src/auth/oauth/openai-codex.ts";
import type { OAuthCredential } from "../src/auth/types.ts";

/**
 * OAuth error messages must never embed token-endpoint response bodies.
 *
 * A token response carries access and refresh tokens; a failure body can echo
 * request parameters. Error messages propagate into logs, telemetry, and user
 * dialogs, so they carry the status and a stable description — never the body.
 */

const SECRET = "sk-live-SENTINEL-DO-NOT-LEAK";
const neverAbortedSignal = new AbortController().signal;

const credential: OAuthCredential = {
	type: "oauth",
	access: "stale-access",
	refresh: "stale-refresh",
	expires: 0,
	accountId: "account-1",
};

function stubFetchResponse(body: string, status: number): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (): Promise<Response> => {
			return new Response(body, { status, headers: { "Content-Type": "application/json" } });
		}),
	);
}

async function refreshError(oauth: typeof anthropicOAuth): Promise<string> {
	const error: unknown = await oauth.refresh(credential, neverAbortedSignal).then(
		() => {
			throw new Error("Expected refresh to reject");
		},
		(refreshError: unknown) => refreshError,
	);
	return String(error);
}

describe.sequential("OAuth error hygiene", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("keeps an Anthropic failure body out of the refresh error", async () => {
		stubFetchResponse(JSON.stringify({ error: "invalid_grant", hint: SECRET }), 400);

		const message = await refreshError(anthropicOAuth);

		expect(message).not.toContain(SECRET);
		expect(message).toContain("400");
	});

	it("keeps an Anthropic invalid-JSON body out of the refresh error", async () => {
		stubFetchResponse(`<html>${SECRET}</html>`, 200);

		const message = await refreshError(anthropicOAuth);

		expect(message).not.toContain(SECRET);
		expect(message).toContain("invalid JSON");
	});

	it("keeps an OpenAI Codex failure body out of the refresh error", async () => {
		stubFetchResponse(JSON.stringify({ error: SECRET }), 401);

		const message = await refreshError(openaiCodexOAuth);

		expect(message).not.toContain(SECRET);
		expect(message).toContain("401");
	});

	it("keeps a partial OpenAI Codex token response out of the refresh error", async () => {
		stubFetchResponse(JSON.stringify({ access_token: SECRET }), 200);

		const message = await refreshError(openaiCodexOAuth);

		expect(message).not.toContain(SECRET);
		expect(message).toContain("missing fields");
	});

	it("keeps an OpenAI Codex invalid-JSON body out of the refresh error", async () => {
		stubFetchResponse(`<html>${SECRET}</html>`, 200);

		const message = await refreshError(openaiCodexOAuth);

		expect(message).not.toContain(SECRET);
	});
});

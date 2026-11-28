import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoogleAiPlanOAuth } from "../src/auth/oauth/google-ai-plan.ts";
import type { OAuthCredential } from "../src/auth/types.ts";

const signal = new AbortController().signal;
const googleAiPlanOAuth = createGoogleAiPlanOAuth({ clientId: "app-client", clientSecret: "app-secret" });

async function credential(): Promise<OAuthCredential> {
	const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
	const { kty, crv, x, y, d } = await crypto.subtle.exportKey("jwk", privateKey);
	return { type: "oauth", access: "old", refresh: "refresh-token", expires: 0, dpopKey: { kty, crv, x, y, d } };
}

/** The claims of the DPoP proof sent with a token request. */
function proofClaims(init: RequestInit | undefined): { jti: string; nonce?: string; iat: number } {
	const proof = (init?.headers as Record<string, string>).DPoP;
	return JSON.parse(Buffer.from(proof.split(".")[1], "base64url").toString("utf8"));
}

function tokenError(error: string, headers: Record<string, string>): Response {
	return new Response(JSON.stringify({ error }), { status: 400, headers });
}

const TOKENS = JSON.stringify({ access_token: "new", expires_in: 3599 });

/** Run `login` with the user pasting a URL built from the sign-in link's `state`. */
async function loginWithPastedUrl(buildUrl: (redirectUri: string, state: string) => string) {
	let authUrl = "";
	return googleAiPlanOAuth.login({
		signal,
		notify: (event) => {
			if (event.type === "auth_url") authUrl = event.url;
		},
		prompt: async () => {
			const params = new URL(authUrl).searchParams;
			return buildUrl(params.get("redirect_uri")!, params.get("state")!);
		},
	});
}

describe("Google AI Ultra plan sign-in with a pasted URL", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("rejects a URL without the sign-in's state, before exchanging the code", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(loginWithPastedUrl((redirectUri) => `${redirectUri}?code=4%2F0Aabc`)).rejects.toThrow(
			"Sign-in state mismatch",
		);
		await expect(
			loginWithPastedUrl((redirectUri) => `${redirectUri}?code=4%2F0Aabc&state=someone-else`),
		).rejects.toThrow("Sign-in state mismatch");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("exchanges the decoded code from a matching URL with the app's client", async () => {
		let sent = new URLSearchParams();
		vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
			sent = new URLSearchParams(String(init?.body));
			return tokenError("invalid_grant", {});
		});

		await expect(
			loginWithPastedUrl((redirectUri, state) => `${redirectUri}?state=${state}&code=4%2F0Aabc`),
		).rejects.toThrow("Google sign-in failed: 400 invalid_grant");
		expect(sent.get("code")).toBe("4/0Aabc");
		expect(sent.get("client_id")).toBe("app-client");
		expect(sent.get("client_secret")).toBe("app-secret");
	});
});

describe("Google AI Ultra plan token refresh", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("retries once with Google's time when the local clock is ahead", async () => {
		const serverDate = "Wed, 25 Nov 2026 12:00:00 GMT";
		const proofs: ReturnType<typeof proofClaims>[] = [];
		const responses = [
			tokenError("invalid_dpop_proof", { date: serverDate }),
			new Response(TOKENS, { headers: { "dpop-nonce": "n1" } }),
		];
		vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
			proofs.push(proofClaims(init));
			return responses.shift()!;
		});

		const next = await googleAiPlanOAuth.refresh(await credential(), signal);

		expect(proofs).toHaveLength(2);
		expect(proofs[1].iat).toBe(Date.parse(serverDate) / 1000);
		expect(proofs[1].jti).not.toBe(proofs[0].jti);
		expect(next.access).toBe("new");
		expect(next.dpopNonce).toBe("n1");
	});

	it("handles a nonce rejection and a clock rejection in one refresh", async () => {
		const serverDate = "Wed, 25 Nov 2026 12:00:00 GMT";
		const proofs: ReturnType<typeof proofClaims>[] = [];
		const responses = [
			tokenError("use_dpop_nonce", { "dpop-nonce": "n1", date: serverDate }),
			tokenError("invalid_dpop_proof", { date: serverDate }),
			new Response(TOKENS),
		];
		vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
			proofs.push(proofClaims(init));
			return responses.shift()!;
		});

		const next = await googleAiPlanOAuth.refresh(await credential(), signal);

		expect(proofs.map((p) => p.nonce)).toEqual([undefined, "n1", "n1"]);
		expect(proofs[2].iat).toBe(Date.parse(serverDate) / 1000);
		expect(next.access).toBe("new");
	});

	it("keeps the nonce that worked when the successful response sends none", async () => {
		const responses = [tokenError("use_dpop_nonce", { "dpop-nonce": "n2" }), new Response(TOKENS)];
		vi.stubGlobal("fetch", async () => responses.shift()!);

		const next = await googleAiPlanOAuth.refresh({ ...(await credential()), dpopNonce: "n1" }, signal);

		expect(next.dpopNonce).toBe("n2");
	});

	it.each(["invalid_grant", "unauthorized_client"])("asks to sign in again on %s", async (error) => {
		vi.stubGlobal("fetch", async () => tokenError(error, {}));

		await expect(googleAiPlanOAuth.refresh(await credential(), signal)).rejects.toThrow(
			"Run /login to sign in again.",
		);
	});

	it("gives up after one clock retry", async () => {
		const serverDate = "Wed, 25 Nov 2026 12:00:00 GMT";
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls++;
			return tokenError("invalid_dpop_proof", { date: serverDate });
		});

		await expect(googleAiPlanOAuth.refresh(await credential(), signal)).rejects.toThrow(
			"Google token refresh failed: 400 invalid_dpop_proof",
		);
		expect(calls).toBe(2);
	});
});

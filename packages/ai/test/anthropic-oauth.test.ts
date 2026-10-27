import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropicOAuth } from "../src/auth/oauth/anthropic.ts";
import type { AuthEvent, AuthPrompt } from "../src/auth/types.ts";

const neverAbortedSignal = new AbortController().signal;
const nativeFetch = globalThis.fetch;

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
		},
	});
}

function getUrl(input: unknown): string {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.toString();
	}
	if (input instanceof Request) {
		return input.url;
	}
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

function getJsonBody(init?: RequestInit): Record<string, string> {
	if (typeof init?.body !== "string") {
		throw new Error(`Expected string request body, got ${typeof init?.body}`);
	}
	return JSON.parse(init.body) as Record<string, string>;
}

describe.sequential("Anthropic OAuth", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("keeps the localhost redirect_uri for manual callback login", async () => {
		let authUrl = "";
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe("https://platform.claude.com/v1/oauth/token");
			expect(init?.method).toBe("POST");
			const body = getJsonBody(init);
			expect(body.grant_type).toBe("authorization_code");
			expect(body.code).toBe("manual-code");
			expect(body.redirect_uri).toBe("http://localhost:53692/callback");
			return jsonResponse({
				access_token: "access-token",
				refresh_token: "refresh-token",
				expires_in: 3600,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await anthropicOAuth.login({
			signal: neverAbortedSignal,
			notify: (event) => {
				if (event.type === "auth_url") authUrl = event.url;
			},
			prompt: async (prompt) => {
				if (prompt.type === "select") return "browser";
				if (prompt.type !== "manual_code") throw new Error(`Unexpected prompt: ${prompt.type}`);
				const url = new URL(authUrl);
				const state = url.searchParams.get("state");
				const redirectUri = url.searchParams.get("redirect_uri");
				if (!state || !redirectUri) throw new Error("Missing OAuth state or redirect_uri in auth URL");
				return `${redirectUri}?code=manual-code&state=${state}`;
			},
		});

		expect(credentials.access).toBe("access-token");
		expect(credentials.refresh).toBe("refresh-token");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("offers browser login first and uses the selected Anthropic copy code flow", async () => {
		const selectPrompts: Array<{
			message: string;
			options: readonly { id: string; label: string }[];
		}> = [];
		let authUrl = "";
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe("https://platform.claude.com/v1/oauth/token");
			const body = getJsonBody(init);
			expect(body.grant_type).toBe("authorization_code");
			expect(body.code).toBe("copied-code");
			expect(body.state).toBe(new URL(authUrl).searchParams.get("state"));
			expect(body.redirect_uri).toBe("https://platform.claude.com/oauth/code/callback");
			return jsonResponse({
				access_token: "access-token",
				refresh_token: "refresh-token",
				expires_in: 3600,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await anthropicOAuth.login({
			signal: neverAbortedSignal,
			notify: (event) => {
				if (event.type === "auth_url") authUrl = event.url;
			},
			prompt: async (prompt) => {
				if (prompt.type === "select") {
					selectPrompts.push(prompt);
					return "copy_code";
				}
				if (prompt.type !== "manual_code") throw new Error(`Unexpected prompt: ${prompt.type}`);
				return `copied-code#${new URL(authUrl).searchParams.get("state")}`;
			},
		});

		expect(credentials.access).toBe("access-token");
		expect(credentials.refresh).toBe("refresh-token");
		expect(new URL(authUrl).searchParams.get("redirect_uri")).toBe("https://platform.claude.com/oauth/code/callback");
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(selectPrompts).toEqual([
			{
				type: "select",
				message: "Select Anthropic login method:",
				options: [
					{ id: "browser", label: "Browser login (default)" },
					{ id: "copy_code", label: "Copy code login (headless)" },
				],
			},
		]);
	});

	it("cancels when Anthropic login method selection is cancelled", async () => {
		await expect(
			anthropicOAuth.login({
				signal: neverAbortedSignal,
				prompt: async () => {
					throw new Error("Login cancelled");
				},
				notify: () => {},
			}),
		).rejects.toThrow("Login cancelled");
	});

	it("omits scope from refresh token requests", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe("https://platform.claude.com/v1/oauth/token");
			expect(init?.method).toBe("POST");
			const body = getJsonBody(init);
			expect(body.grant_type).toBe("refresh_token");
			expect(body.client_id).toBeTruthy();
			expect(body.refresh_token).toBe("refresh-token");
			expect(body).not.toHaveProperty("scope");
			return jsonResponse({
				access_token: "new-access-token",
				refresh_token: "new-refresh-token",
				expires_in: 3600,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await anthropicOAuth.refresh(
			{
				type: "oauth",
				access: "old-access-token",
				refresh: "refresh-token",
				expires: 0,
			},
			neverAbortedSignal,
		);

		expect(credentials.access).toBe("new-access-token");
		expect(credentials.refresh).toBe("new-refresh-token");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("anthropicOAuth.login resolves through the manual_code prompt and aborts it after settling", async () => {
		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = typeof input === "string" ? input : String(input);
			if (url.includes("/oauth/token")) {
				return jsonResponse({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const events: AuthEvent[] = [];
		const prompts: AuthPrompt[] = [];
		let manualSignal: AbortSignal | undefined;

		const credential = await anthropicOAuth.login({
			signal: neverAbortedSignal,
			notify: (event) => events.push(event),
			prompt: async (prompt) => {
				prompts.push(prompt);
				if (prompt.type === "select") return "browser";
				if (prompt.type === "manual_code") {
					manualSignal = prompt.signal;
					return "the-code";
				}
				throw new Error(`Unexpected prompt: ${prompt.type}`);
			},
		});

		expect(credential.type).toBe("oauth");
		expect(credential.access).toBe("access");
		expect(events.some((e) => e.type === "auth_url")).toBe(true);
		expect(prompts.some((p) => p.type === "manual_code")).toBe(true);
		// the prompt's signal is aborted once login settles, so UIs can dismiss it
		expect(manualSignal?.aborted).toBe(true);
	});

	it("completes login through the browser callback and shows the sign-in page", async () => {
		const login = await loginThroughBrowserCallback();

		expect(login.credential.access).toBe("access");
		expect(login.exchangedCode).toBe("browser-code");
		expect(login.exchangedRedirectUri).toBe(login.redirectUri);
		expect(login.pageStatus).toBe(200);
		expect(login.pageText).toContain("Signed in to Anthropic.");
	});

	// #10571
	it("falls back to a free callback port when the preferred port cannot be bound", async () => {
		const blocker = createServer();
		await listen(blocker, 53692);
		try {
			const login = await loginThroughBrowserCallback();
			const redirectUri = new URL(login.redirectUri);

			expect(redirectUri.hostname).toBe("localhost");
			expect(redirectUri.pathname).toBe("/callback");
			expect(redirectUri.port).not.toBe("53692");
			expect(login.credential.access).toBe("access");
			expect(login.exchangedRedirectUri).toBe(login.redirectUri);
			expect(login.pageStatus).toBe(200);
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	});
});

function listen(server: Server, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
}

async function loginThroughBrowserCallback() {
	let exchangedCode: string | undefined;
	let exchangedRedirectUri: string | undefined;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			if (getUrl(input) !== "https://platform.claude.com/v1/oauth/token") return nativeFetch(input as string, init);
			const body = getJsonBody(init);
			exchangedCode = body.code;
			exchangedRedirectUri = body.redirect_uri;
			return jsonResponse({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
		}),
	);

	let redirectUri = "";
	let callbackPage: Promise<Response> | undefined;
	const credential = await anthropicOAuth.login({
		signal: neverAbortedSignal,
		notify: (event) => {
			if (event.type !== "auth_url") return;
			const params = new URL(event.url).searchParams;
			redirectUri = params.get("redirect_uri") ?? "";
			const callbackUrl = new URL(redirectUri);
			callbackUrl.hostname = "127.0.0.1";
			callbackUrl.search = new URLSearchParams({
				code: "browser-code",
				state: params.get("state") ?? "",
			}).toString();
			callbackPage = nativeFetch(callbackUrl);
		},
		prompt: (prompt) =>
			prompt.type === "select"
				? Promise.resolve("browser")
				: new Promise((_, reject) => {
						prompt.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
					}),
	});
	const page = await callbackPage;
	return {
		credential,
		redirectUri,
		exchangedCode,
		exchangedRedirectUri,
		pageStatus: page?.status,
		pageText: await page?.text(),
	};
}

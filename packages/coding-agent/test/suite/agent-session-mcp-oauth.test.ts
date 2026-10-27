import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryAuthStorageBackend } from "../../src/core/auth-storage.ts";
import { emitSessionShutdownEvent } from "../../src/core/extensions/runner.ts";
import { runMcpCommand } from "../../src/extensions/mcp/cli.ts";
import type { McpOAuthConfig, McpServerEntry } from "../../src/extensions/mcp/config.ts";
import { createMcpExtension } from "../../src/extensions/mcp/index.ts";
import { McpOAuthCredentialStore } from "../../src/extensions/mcp/oauth.ts";
import { createHarness, createTestUiContext, getMessageText, type Harness } from "./harness.ts";
import { startOAuthMcpServer } from "./mcp-oauth-server.ts";

describe("AgentSession MCP OAuth", () => {
	const cleanups: (() => Promise<void> | void)[] = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function setup(browser: "follow" | "paste", oauth?: McpOAuthConfig) {
		const server = await startOAuthMcpServer();
		cleanups.push(server.close);
		const backend = new InMemoryAuthStorageBackend();
		const entry: McpServerEntry = {
			name: "issues",
			config: { url: server.url, exposure: "direct", ...(oauth ? { oauth } : {}) },
			source: "test",
		};
		const notifications: string[] = [];
		const opened: URL[] = [];
		let redirectLocation: Promise<string> | undefined;
		const harness: Harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				createMcpExtension({
					loadConfig: () => ({ servers: [entry], errors: [] }),
					credentials: new McpOAuthCredentialStore(backend),
					openUrl: (url) => {
						opened.push(new URL(url));
						if (browser === "follow") {
							// The browser follows the authorization redirect to the loopback callback.
							void fetch(url);
						} else {
							// The browser cannot reach the callback; the user pastes the redirect URL.
							redirectLocation = fetch(url, { redirect: "manual" }).then(
								(response) => response.headers.get("location") ?? "",
							);
						}
					},
				}),
			],
		});
		cleanups.push(() => harness.cleanup());
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				notify: (message) => notifications.push(message),
				// The paste prompt waits until sign-in completes unless the user pastes the redirect URL.
				input: (_title, _placeholder, opts) =>
					browser === "paste"
						? Promise.resolve(redirectLocation)
						: new Promise((resolve) =>
								opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true }),
							),
			}),
		});
		return { harness, server, notifications, backend, opened };
	}

	async function callWhoami(harness: Harness): Promise<ToolResultMessage> {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__issues__whoami", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const before = harness.session.messages.length;
		await harness.session.prompt("who am i");
		const result = harness.session.messages
			.slice(before)
			.find((message): message is ToolResultMessage => message.role === "toolResult");
		if (!result) throw new Error("no tool result");
		return result;
	}

	it("signs in through the browser, refreshes expired tokens, and signs out", async () => {
		const { harness, server, notifications, backend } = await setup("follow");

		await harness.session.prompt("/mcp");
		// Startup problems are reported once, pointing to /mcp.
		expect(notifications).toContain("MCP servers need attention:\n  issues: needs sign-in\nRun /mcp to fix.");
		expect(notifications.at(-1)).toBe("issues: needs sign-in, run /mcp login issues (direct)");

		await harness.session.prompt("/mcp login issues");
		expect(notifications.at(-1)).toBe('Signed in to MCP server "issues" (1 tools).');
		expect(server.log).toEqual(["401 none", "register", "token code"]);
		expect(backend.withLock((current) => ({ result: current }))).toContain('"access_token": "access-1"');

		expect(getMessageText(await callWhoami(harness))).toBe("token access-1");

		// An expired access token is refreshed without user interaction.
		server.expireAccessTokens();
		expect(getMessageText(await callWhoami(harness))).toBe("token access-2");
		expect(server.log.slice(-3)).toEqual(["401 access-1", "token refresh", "call access-2"]);

		// A token past its expiry is refreshed before the request, without a 401 round trip.
		backend.withLock((current) => {
			const states = JSON.parse(current ?? "{}") as Record<string, { tokensExpireAt?: number }>;
			for (const state of Object.values(states)) state.tokensExpireAt = Date.now() - 1_000;
			return { result: undefined, next: JSON.stringify(states) };
		});
		expect(getMessageText(await callWhoami(harness))).toBe("token access-3");
		expect(server.log.slice(-2)).toEqual(["token refresh", "call access-3"]);

		await harness.session.prompt("/mcp logout issues");
		expect(notifications.at(-1)).toBe('Signed out of MCP server "issues".');
		const result = await callWhoami(harness);
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toBe('MCP server "issues" requires sign-in. Run /mcp to sign in.');
	});

	it("accepts a pasted redirect URL when the browser cannot reach the callback", async () => {
		const { harness, server, notifications } = await setup("paste");

		await harness.session.prompt("/mcp login");
		expect(notifications.at(-1)).toBe('Signed in to MCP server "issues" (1 tools).');
		expect(getMessageText(await callWhoami(harness))).toBe(`token access-1`);
		expect(server.log).toContain("token code");
	});

	/** Emit session_shutdown like quitting does; resolves to how long the handlers took. */
	async function shutdown(harness: Harness): Promise<number> {
		const start = Date.now();
		await emitSessionShutdownEvent(harness.session.extensionRunner, { type: "session_shutdown", reason: "quit" });
		return Date.now() - start;
	}

	// #10565
	for (const path of ["/.well-known/oauth-authorization-server", "/token"]) {
		it(`cancels a sign-in waiting on ${path} when the session shuts down`, async () => {
			const { harness, server, notifications } = await setup("follow");
			server.stall.add(path);
			const login = harness.session.prompt("/mcp login issues");
			await vi.waitFor(() => expect(server.stalled).toHaveLength(1), { timeout: 5_000 });

			// Shutdown waits for the sign-in to clean up, which aborting makes immediate.
			expect(await shutdown(harness)).toBeLessThan(2_000);
			await login;
			// The request is aborted instead of left open, and the ended session reports nothing.
			await vi.waitFor(() => expect(server.stalled[0]?.request.socket.destroyed).toBe(true));
			expect(notifications.filter((message) => message.startsWith("Sign-in"))).toEqual([]);
		});
	}

	// #10565
	it("closes the session without refreshing an expiring token", async () => {
		const { harness, server, notifications, backend } = await setup("follow");
		await harness.session.prompt("/mcp login issues");
		expect(notifications.at(-1)).toBe('Signed in to MCP server "issues" (1 tools).');
		// Still accepted, but close enough to expiry that the next request would refresh it first.
		backend.withLock((current) => {
			const states = JSON.parse(current ?? "{}") as Record<string, { tokensExpireAt?: number }>;
			for (const state of Object.values(states)) state.tokensExpireAt = Date.now() + 10_000;
			return { result: undefined, next: JSON.stringify(states) };
		});
		server.stall.add("/token");

		expect(await shutdown(harness)).toBeLessThan(2_000);
		expect(server.stalled).toEqual([]);
		expect(server.deletes).toEqual(["access-1"]);
	});

	async function freePort(): Promise<number> {
		return new Promise<number>((resolve) => {
			const probe = createServer().listen(0, "127.0.0.1", () => {
				const address = probe.address() as AddressInfo;
				probe.close(() => resolve(address.port));
			});
		});
	}

	it("uses the configured callback URL and scope", async () => {
		const callbackUrl = `http://localhost:${await freePort()}/callback`;
		const { harness, notifications, opened } = await setup("follow", { callbackUrl, scope: "issues:read" });

		await harness.session.prompt("/mcp login issues");
		expect(notifications.at(-1)).toBe('Signed in to MCP server "issues" (1 tools).');
		expect(opened[0].searchParams.get("redirect_uri")).toBe(callbackUrl);
		expect(opened[0].searchParams.get("scope")).toBe("issues:read");
		expect(getMessageText(await callWhoami(harness))).toBe("token access-1");
	});

	// #10226
	it("registers with the configured client name", async () => {
		const { harness, server, notifications } = await setup("follow", { clientName: "Claude Code" });
		await harness.session.prompt("/mcp login issues");
		expect(notifications.at(-1)).toBe('Signed in to MCP server "issues" (1 tools).');
		expect(server.registrations.map((metadata) => metadata.client_name)).toEqual(["Claude Code"]);

		const fallback = await setup("follow");
		await fallback.harness.session.prompt("/mcp login issues");
		expect(fallback.server.registrations.map((metadata) => metadata.client_name)).toEqual(["pi"]);
		// OpenID Connect servers reject the loopback redirect URI of a `web` client (#10493).
		expect(fallback.server.registrations.map((metadata) => metadata.application_type)).toEqual(["native"]);
	});

	it("adds the listening port to a callback URL without one", async () => {
		const { harness, notifications, opened } = await setup("follow", { callbackUrl: "http://127.0.0.1/oauth/done" });
		await harness.session.prompt("/mcp login issues");
		expect(notifications.at(-1)).toBe('Signed in to MCP server "issues" (1 tools).');
		expect(opened[0].searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/done$/);

		const port = await freePort();
		const fixed = await setup("follow", { callbackUrl: "http://127.0.0.1/oauth/done", callbackPort: port });
		await fixed.harness.session.prompt("/mcp login issues");
		expect(fixed.opened[0].searchParams.get("redirect_uri")).toBe(`http://127.0.0.1:${port}/oauth/done`);
	});

	it("gives up on pi mcp login after --timeout, also while the authorization server hangs", async () => {
		const server = await startOAuthMcpServer();
		cleanups.push(server.close);
		const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-login-"));
		cleanups.push(() => rmSync(agentDir, { recursive: true, force: true }));
		writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { issues: { url: server.url } } }));
		const login = async () => {
			const output: string[] = [];
			const exitCode = await runMcpCommand(["login", "issues", "--timeout", "0.5"], {
				cwd: agentDir,
				agentDir,
				credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
				// The user never approves in the browser.
				openUrl: () => {},
				log: (line) => output.push(line),
				error: (line) => output.push(line),
			});
			return { exitCode, output };
		};

		const unapproved = await login();
		expect(unapproved.exitCode).toBe(1);
		expect(unapproved.output.at(-1)).toContain("was cancelled or not completed within");

		// #10565
		server.stall.add("/.well-known/oauth-authorization-server");
		const stalled = await login();
		expect(stalled.exitCode).toBe(1);
		expect(stalled.output.at(-1)).toContain("was cancelled or not completed within");
	});

	it("uses credentials from pi mcp login on the next turn", async () => {
		const { harness, server, backend } = await setup("follow");
		const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-login-"));
		cleanups.push(() => rmSync(agentDir, { recursive: true, force: true }));
		writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { issues: { url: server.url } } }));

		// The agent runs `pi mcp login issues` through bash; the user approves in the browser.
		const output: string[] = [];
		const exitCode = await runMcpCommand(["login", "issues"], {
			cwd: agentDir,
			agentDir,
			credentials: new McpOAuthCredentialStore(backend),
			openUrl: (url) => void fetch(url),
			log: (line) => output.push(line),
			error: (line) => output.push(line),
		});
		expect(exitCode).toBe(0);
		expect(output.at(-1)).toBe('Signed in to MCP server "issues" (1 tools).');

		// The session still waits for a sign-in, and reconnects when the next turn starts.
		expect(getMessageText(await callWhoami(harness))).toBe("token access-1");
	});
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore, type Model, type Provider } from "@earendil-works/pi-ai";
import { describe, expect, test, vi } from "vitest";
import { runAuthLogin } from "../src/cli/auth-login.ts";
import type { LoginTerminal } from "../src/cli/auth-terminal.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { CredentialSynchronizationError, ModelRuntime } from "../src/core/model-runtime.ts";

const PROVIDER_ID = "login-test";

interface ScriptedTerminal extends LoginTerminal {
	lines: string[];
	errors: string[];
	questions: string[];
	opened: string[];
}

/** Answers prompts in order; `secret` and `question` share one answer queue. */
function scriptedTerminal(answers: string[], interactive = true): ScriptedTerminal {
	const lines: string[] = [];
	const errors: string[] = [];
	const questions: string[] = [];
	const opened: string[] = [];
	const answer = async (message: string, signal: AbortSignal) => {
		questions.push(message);
		if (signal.aborted) throw new Error("Login cancelled");
		const next = answers.shift();
		if (next === undefined) throw new Error(`Unexpected prompt: ${message}`);
		return next;
	};
	return {
		interactive,
		lines,
		errors,
		questions,
		opened,
		write: (line) => lines.push(line),
		error: (line) => errors.push(line),
		question: answer,
		secret: answer,
		openUrl: (url) => opened.push(url),
	};
}

function testModel(providerId: string): Model<"openai-completions"> {
	return {
		id: "test-model",
		name: "test-model",
		api: "openai-completions",
		provider: providerId,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function testProvider(auth: Provider["auth"], providerId: string): Provider {
	const unused = () => {
		throw new Error("unused");
	};
	return {
		id: providerId,
		name: "Login Test",
		auth,
		getModels: () => [testModel(providerId)],
		stream: unused,
		streamSimple: unused,
	};
}

const bothMethods: Provider["auth"] = {
	oauth: {
		name: "Login Test account",
		login: async (interaction) => {
			const method = await interaction.prompt({
				type: "select",
				message: "Sign in to Login Test:",
				options: [
					{ id: "browser", label: "Sign in with browser" },
					{ id: "device", label: "Sign in with device code" },
				],
			});
			if (method === "device") {
				interaction.notify({
					type: "device_code",
					userCode: "ABCD-1234",
					verificationUri: "https://example.test/device",
				});
				return { type: "oauth", access: "access-device", refresh: "refresh", expires: Date.now() + 3_600_000 };
			}
			interaction.notify({
				type: "auth_url",
				url: "https://example.test/authorize",
				instructions: "Finish in the browser",
			});
			const code = await interaction.prompt({ type: "manual_code", message: "Paste the code" });
			return { type: "oauth", access: `access-${code}`, refresh: "refresh", expires: Date.now() + 3_600_000 };
		},
		refresh: async (credential) => credential,
		toAuth: async (credential) => ({ apiKey: credential.access }),
	},
	apiKey: {
		name: "Login Test API key",
		login: async (interaction) => ({
			type: "api_key",
			key: await interaction.prompt({ type: "secret", message: "Enter Login Test API key" }),
		}),
		resolve: async () => undefined,
	},
};

async function setup(auth: Provider["auth"], providerId = PROVIDER_ID) {
	const credentials = AuthStorage.inMemory();
	const modelRuntime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
	});
	modelRuntime.registerNativeProvider(testProvider(auth, providerId));
	return { credentials, modelRuntime };
}

function run(
	args: string[],
	modelRuntime: ModelRuntime,
	terminal: LoginTerminal,
	signal = new AbortController().signal,
	agentDir = "/nonexistent-agent-dir",
) {
	return runAuthLogin(args, {
		modelRuntime,
		terminal,
		agentDir,
		cwd: "/nonexistent-cwd",
		getDeviceId: () => "device",
		signal,
	});
}

describe("pi auth login", () => {
	const usage = "Usage: pi auth login <provider> [--api-key] [--no-browser]";

	test("requires exactly one provider and known options", async () => {
		const { modelRuntime } = await setup(bothMethods);
		for (const args of [[], ["--api-key"], ["--provider", PROVIDER_ID], [PROVIDER_ID, "extra"]]) {
			const terminal = scriptedTerminal([]);
			expect(await run(args, modelRuntime, terminal)).toBe(1);
			expect(terminal.errors).toEqual([usage]);
		}
	});

	test("rejects --no-browser with --api-key", async () => {
		const { modelRuntime } = await setup(bothMethods);
		const terminal = scriptedTerminal([]);
		expect(await run([PROVIDER_ID, "--api-key", "--no-browser"], modelRuntime, terminal)).toBe(1);
		expect(terminal.errors).toEqual(["--no-browser only applies to account sign-in; omit it with --api-key."]);
	});

	test("rejects an unknown provider and lists the providers with a login flow", async () => {
		const { modelRuntime } = await setup(bothMethods);
		const terminal = scriptedTerminal([]);
		expect(await run(["nope"], modelRuntime, terminal)).toBe(1);
		expect(terminal.errors[0]).toBe('Unknown provider "nope".');
		expect(terminal.errors[1]).toContain(PROVIDER_ID);
	});

	test("requires an interactive terminal after checking the arguments", async () => {
		const { modelRuntime } = await setup(bothMethods);
		const terminal = scriptedTerminal([], false);
		expect(await run([PROVIDER_ID], modelRuntime, terminal)).toBe(1);
		expect(terminal.errors).toEqual([
			'"pi auth login <provider> [--api-key] [--no-browser]" requires an interactive terminal',
		]);
	});

	test("signs in with an account in the browser without asking for a method", async () => {
		const { credentials, modelRuntime } = await setup(bothMethods);
		const terminal = scriptedTerminal(["the-code"]);
		// Matches the provider name as well as the id.
		expect(await run(["login test"], modelRuntime, terminal)).toBe(0);
		expect(terminal.questions).toEqual(["Paste the code: "]);
		expect(terminal.lines).toContain("Open this URL to sign in:\n  https://example.test/authorize");
		expect(terminal.lines).toContain("Finish in the browser");
		expect(terminal.opened).toEqual(["https://example.test/authorize"]);
		expect(terminal.lines).toContain(
			'To use "Sign in with device code" instead, run "pi auth login login-test --no-browser"',
		);
		expect(await credentials.read(PROVIDER_ID)).toMatchObject({ type: "oauth", access: "access-the-code" });
		expect(terminal.lines.some((line) => line.startsWith("Logged in to Login Test."))).toBe(true);
	});

	test("lists several other sign-in methods", async () => {
		const { modelRuntime } = await setup({
			oauth: {
				...bothMethods.oauth!,
				login: async (interaction) => {
					await interaction.prompt({
						type: "select",
						message: "Sign in to Login Test:",
						options: [
							{ id: "browser", label: "Browser" },
							{ id: "device", label: "Device code" },
							{ id: "copy", label: "Copy code" },
						],
					});
					interaction.notify({ type: "auth_url", url: "https://example.test/authorize" });
					return { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 3_600_000 };
				},
			},
		});
		const terminal = scriptedTerminal([]);
		expect(await run([PROVIDER_ID], modelRuntime, terminal)).toBe(0);
		expect(terminal.lines).toContain(
			'Other sign-in methods: "Device code", "Copy code". Run "pi auth login login-test --no-browser" to choose one.',
		);
	});

	test("offers no other sign-in methods when the provider has no method choice", async () => {
		const { credentials, modelRuntime } = await setup({
			oauth: {
				...bothMethods.oauth!,
				login: async (interaction) => {
					interaction.notify({ type: "auth_url", url: "https://example.test/authorize" });
					const code = await interaction.prompt({ type: "manual_code", message: "Paste the code" });
					return { type: "oauth", access: `access-${code}`, refresh: "refresh", expires: Date.now() + 3_600_000 };
				},
			},
		});
		const terminal = scriptedTerminal(["the-code"]);
		expect(await run([PROVIDER_ID], modelRuntime, terminal)).toBe(0);
		expect(terminal.opened).toEqual(["https://example.test/authorize"]);
		expect(terminal.lines.some((line) => line.includes("--no-browser"))).toBe(false);
		expect(await credentials.read(PROVIDER_ID)).toMatchObject({ type: "oauth", access: "access-the-code" });
	});

	test("--no-browser takes the only other sign-in method and opens nothing", async () => {
		const { credentials, modelRuntime } = await setup(bothMethods);
		const terminal = scriptedTerminal([]);
		expect(await run([PROVIDER_ID, "--no-browser"], modelRuntime, terminal)).toBe(0);
		expect(terminal.questions).toEqual([]);
		expect(terminal.lines[0]).toBe("Sign in to Login Test: Sign in with device code");
		expect(terminal.lines).toContain("Open https://example.test/device and enter code: ABCD-1234");
		expect(terminal.opened).toEqual([]);
		expect(terminal.lines.some((line) => line.includes("--no-browser"))).toBe(false);
		expect(await credentials.read(PROVIDER_ID)).toMatchObject({ type: "oauth", access: "access-device" });
	});

	test("--no-browser asks among several other sign-in methods and re-asks on an invalid selection", async () => {
		const { credentials, modelRuntime } = await setup({
			oauth: {
				...bothMethods.oauth!,
				login: async (interaction) => {
					const method = await interaction.prompt({
						type: "select",
						message: "Sign in to Login Test:",
						options: [
							{ id: "browser", label: "Browser" },
							{ id: "device", label: "Device code" },
							{ id: "copy", label: "Copy code" },
						],
					});
					return {
						type: "oauth",
						access: `access-${method}`,
						refresh: "refresh",
						expires: Date.now() + 3_600_000,
					};
				},
			},
		});
		const terminal = scriptedTerminal(["7", "2"]);
		expect(await run(["--no-browser", PROVIDER_ID], modelRuntime, terminal)).toBe(0);
		expect(terminal.lines.slice(0, 3)).toEqual(["Sign in to Login Test:", "  1. Device code", "  2. Copy code"]);
		expect(terminal.lines).toContain("Enter a number from 1 to 2.");
		expect(await credentials.read(PROVIDER_ID)).toMatchObject({ type: "oauth", access: "access-copy" });
	});

	test("--no-browser keeps a provider's only sign-in method without opening the browser", async () => {
		const { credentials, modelRuntime } = await setup({
			oauth: {
				...bothMethods.oauth!,
				login: async (interaction) => {
					const method = await interaction.prompt({
						type: "select",
						message: "Sign in to Login Test:",
						options: [{ id: "browser", label: "Browser" }],
					});
					interaction.notify({ type: "auth_url", url: "https://example.test/authorize" });
					return {
						type: "oauth",
						access: `access-${method}`,
						refresh: "refresh",
						expires: Date.now() + 3_600_000,
					};
				},
			},
		});
		const terminal = scriptedTerminal([]);
		expect(await run([PROVIDER_ID, "--no-browser"], modelRuntime, terminal)).toBe(0);
		expect(terminal.questions).toEqual([]);
		expect(terminal.opened).toEqual([]);
		expect(await credentials.read(PROVIDER_ID)).toMatchObject({ type: "oauth", access: "access-browser" });
	});

	test("asks for selections during API key setup", async () => {
		const { credentials, modelRuntime } = await setup({
			apiKey: {
				...bothMethods.apiKey!,
				login: async (interaction) => ({
					type: "api_key",
					key: await interaction.prompt({
						type: "select",
						message: "Choose credentials:",
						options: [
							{ id: "first", label: "First" },
							{ id: "second", label: "Second", description: "Other credentials" },
						],
					}),
				}),
			},
		});
		const terminal = scriptedTerminal(["2"]);
		expect(await run([PROVIDER_ID, "--api-key"], modelRuntime, terminal)).toBe(0);
		expect(terminal.questions).toEqual(["Select 1-2: "]);
		expect(terminal.lines).toContain("  2. Second - Other credentials");
		expect(await credentials.read(PROVIDER_ID)).toMatchObject({ type: "api_key", key: "second" });
	});

	test("cancels a pending prompt without cancelling the login when the browser callback wins", async () => {
		const promptController = new AbortController();
		const { credentials, modelRuntime } = await setup({
			oauth: {
				...bothMethods.oauth!,
				login: async (interaction) => {
					const pending = interaction.prompt({
						type: "manual_code",
						message: "Paste the code",
						placeholder: "redirect URL",
						signal: promptController.signal,
					});
					promptController.abort();
					await expect(pending).rejects.toBe(promptController.signal.reason);
					expect(interaction.signal.aborted).toBe(false);
					return { type: "oauth", access: "callback", refresh: "refresh", expires: Date.now() + 3_600_000 };
				},
			},
		});
		const terminal = scriptedTerminal([]);
		terminal.question = vi.fn(
			(_message: string, signal: AbortSignal) =>
				new Promise<string>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		);
		expect(await run([PROVIDER_ID], modelRuntime, terminal)).toBe(0);
		expect(terminal.question).toHaveBeenCalledWith("Paste the code (redirect URL): ", expect.any(AbortSignal));
		expect(await credentials.read(PROVIDER_ID)).toMatchObject({ type: "oauth", access: "callback" });
	});

	test("reports a committed login separately from a failed login", async () => {
		const { modelRuntime } = await setup(bothMethods);
		vi.spyOn(modelRuntime, "login").mockRejectedValue(
			new CredentialSynchronizationError(
				PROVIDER_ID,
				"login",
				{ type: "api_key", key: "saved" },
				{ cause: new Error("snapshot failed") },
			),
		);
		const terminal = scriptedTerminal([]);
		expect(await run([PROVIDER_ID], modelRuntime, terminal)).toBe(1);
		expect(terminal.errors[0]).toContain("Logged in to Login Test, but local model state could not be synchronized:");
	});

	test("--api-key saves an API key", async () => {
		const { credentials, modelRuntime } = await setup(bothMethods);
		const terminal = scriptedTerminal(["sk-test"]);
		expect(await run([PROVIDER_ID, "--api-key"], modelRuntime, terminal)).toBe(0);
		expect(terminal.questions).toEqual(["Enter Login Test API key: "]);
		expect(await credentials.read(PROVIDER_ID)).toMatchObject({ type: "api_key", key: "sk-test" });
		expect(terminal.lines.some((line) => line.startsWith("Saved API key for Login Test."))).toBe(true);
	});

	test("uses the API key login of providers without account sign-in", async () => {
		const { modelRuntime } = await setup({ apiKey: bothMethods.apiKey });
		const terminal = scriptedTerminal(["sk-test"]);
		expect(await run([PROVIDER_ID], modelRuntime, terminal)).toBe(0);
		expect(terminal.questions).toEqual(["Enter Login Test API key: "]);
	});

	test("--api-key fails for providers without API key login", async () => {
		const { modelRuntime } = await setup({ oauth: bothMethods.oauth });
		const terminal = scriptedTerminal([]);
		expect(await run([PROVIDER_ID, "--api-key"], modelRuntime, terminal)).toBe(1);
		expect(terminal.errors).toEqual(["Login Test has no API key login. Omit --api-key to sign in."]);
	});

	test("reports providers configured outside pi", async () => {
		const { modelRuntime } = await setup({ apiKey: { name: "AWS profile", resolve: async () => undefined } });
		const terminal = scriptedTerminal([]);
		expect(await run([PROVIDER_ID], modelRuntime, terminal)).toBe(1);
		expect(terminal.errors).toEqual(["Login Test is configured outside pi (AWS profile)."]);
	});

	test("Ctrl+C during the catalog refresh skips it and keeps the login", async () => {
		const { credentials, modelRuntime } = await setup({ apiKey: bothMethods.apiKey });
		const controller = new AbortController();
		// A refresh that only ends when aborted, interrupted as soon as it starts.
		vi.spyOn(modelRuntime, "refresh").mockImplementation(
			({ signal } = {}) =>
				new Promise((resolve) => {
					signal?.addEventListener("abort", () => resolve({ aborted: true, errors: new Map() }));
					controller.abort();
				}),
		);
		const terminal = scriptedTerminal(["sk-test"]);
		expect(await run([PROVIDER_ID], modelRuntime, terminal, controller.signal)).toBe(0);
		expect(terminal.lines).toContain("Skipped the Login Test model catalog refresh; pi refreshes it on next start.");
		expect(await credentials.read(PROVIDER_ID)).toMatchObject({ type: "api_key", key: "sk-test" });
	});

	test("reports cancellation", async () => {
		const { credentials, modelRuntime } = await setup({ apiKey: bothMethods.apiKey });
		const controller = new AbortController();
		controller.abort();
		const terminal = scriptedTerminal(["sk-test"]);
		expect(await run([PROVIDER_ID], modelRuntime, terminal, controller.signal)).toBe(1);
		expect(terminal.errors).toEqual(["Login cancelled."]);
		expect(await credentials.read(PROVIDER_ID)).toBeUndefined();
	});

	test.each(["radius-mcp", "radius_mcp"])("keeps unrelated MCP servers when %s is occupied", async (fallback) => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-auth-login-"));
		try {
			const { modelRuntime } = await setup({ apiKey: bothMethods.apiKey }, "radius");
			const mcpPath = join(agentDir, "mcp.json");
			const servers = {
				radius: { command: "original-one" },
				[fallback]: { command: "original-two" },
				"radius-mcp-2": { command: "original-three" },
			};
			writeFileSync(mcpPath, JSON.stringify({ mcpServers: servers }));
			const terminal = scriptedTerminal(["sk-test"]);
			expect(await run(["radius"], modelRuntime, terminal, undefined, agentDir)).toBe(0);
			expect(JSON.parse(readFileSync(mcpPath, "utf8")).mcpServers).toEqual({
				...servers,
				"radius-mcp-3": { url: "https://radius.pi.dev/mcp", auth: { provider: "radius" } },
			});
			expect(terminal.lines).toContain(`Added MCP server "radius-mcp-3" in ${mcpPath} to use the Login Test login.`);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	test("configures the Radius MCP server without asking, once", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-auth-login-"));
		try {
			const { modelRuntime } = await setup({ apiKey: bothMethods.apiKey }, "radius");
			const mcpPath = join(agentDir, "mcp.json");
			const first = scriptedTerminal(["sk-test"]);
			expect(await run(["radius"], modelRuntime, first, undefined, agentDir)).toBe(0);
			expect(first.questions).toEqual(["Enter Login Test API key: "]);
			expect(first.lines).toContain(`Added MCP server "radius" in ${mcpPath} to use the Login Test login.`);
			expect(JSON.parse(readFileSync(mcpPath, "utf8")).mcpServers.radius).toMatchObject({
				auth: { provider: "radius" },
			});

			const second = scriptedTerminal(["sk-test"]);
			expect(await run(["radius"], modelRuntime, second, undefined, agentDir)).toBe(0);
			expect(second.lines.some((line) => line.includes("MCP server"))).toBe(false);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

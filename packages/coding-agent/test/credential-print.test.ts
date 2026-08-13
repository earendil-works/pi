import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { describe, expect, test, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { AuthCommandError, isAuthCommandHelp, parseAuthCommand } from "../src/cli/auth-command.ts";
import { resolveCredentialForPrint } from "../src/cli/credential-print.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { main } from "../src/main.ts";

async function createRuntime(credentials: AuthStorage): Promise<ModelRuntime> {
	return ModelRuntime.create({
		credentials,
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
	});
}

describe("credential print commands", () => {
	test("prints a resolved API key", async () => {
		const runtime = await createRuntime(AuthStorage.inMemory({ openai: { type: "api_key", key: "test-api-key" } }));
		const args = parseArgs(["--provider", "openai"]);

		await expect(resolveCredentialForPrint(args, runtime, "api_key")).resolves.toBe("test-api-key");
	});

	test("prints bearer tokens resolved from an Authorization header", async () => {
		const runtime = await createRuntime(
			AuthStorage.inMemory({
				"kimi-coding": {
					type: "oauth",
					access: "header-test-token",
					refresh: "test-refresh-token",
					expires: Date.now() + 60 * 60 * 1000,
				},
			}),
		);
		const args = parseArgs(["--provider", "kimi-coding"]);

		await expect(resolveCredentialForPrint(args, runtime, "bearer_token")).resolves.toBe("header-test-token");
	});

	test("refreshes an expired OAuth token before printing it", async () => {
		const storage = AuthStorage.inMemory({
			"openai-codex": {
				type: "oauth",
				access: "old-test-token",
				refresh: "test-refresh-token",
				expires: 0,
			},
		});
		const runtime = await createRuntime(storage);
		const refresh = vi.fn(async () => ({
			type: "oauth" as const,
			access: "fresh-test-token",
			refresh: "test-refresh-token",
			expires: Date.now() + 60 * 60 * 1000,
		}));
		const oauth = runtime.getProvider("openai-codex")?.auth.oauth;
		if (!oauth) throw new Error("OpenAI Codex OAuth provider is not registered");
		oauth.refresh = refresh;
		const args = parseArgs(["--provider", "openai-codex"]);

		await expect(resolveCredentialForPrint(args, runtime, "bearer_token")).resolves.toBe("fresh-test-token");
		expect(refresh).toHaveBeenCalledOnce();
		expect(await storage.read("openai-codex")).toMatchObject({ access: "fresh-test-token" });
	});

	test("reports unknown auth options like package commands", async () => {
		const originalExitCode = process.exitCode;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			process.exitCode = undefined;
			await main(["auth", "check", "--provider", "openai-codex", "--credentails"]);
			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain('Unknown option --credentails for "auth check".');
			expect(stderr).toContain(
				'Use "pi --help" or "pi auth check --provider <provider> [--json] [--credentials] [--no-refresh]".',
			);
			expect(process.exitCode).toBe(1);
		} finally {
			process.exitCode = originalExitCode;
			errorSpy.mockRestore();
		}
	});

	test("parses credential commands and rejects invalid arguments or credential types", async () => {
		const runtime = await createRuntime(
			AuthStorage.inMemory({
				"openai-codex": {
					type: "oauth",
					access: "test-token-not-to-be-printed",
					refresh: "test-refresh-token",
					expires: Date.now() + 60 * 60 * 1000,
				},
			}),
		);

		expect(parseAuthCommand(["auth", "print-api-key", "--provider", "openai"])).toEqual({
			kind: "api_key",
			args: ["--provider", "openai"],
			json: false,
			credentials: false,
			noRefresh: false,
		});
		expect(parseAuthCommand(["auth", "print-bearer-token"])).toMatchObject({ kind: "bearer_token" });
		expect(parseAuthCommand(["auth", "print-bearer-token", "--min-expiry", "30m"])).toEqual({
			kind: "bearer_token",
			args: [],
			json: false,
			credentials: false,
			noRefresh: false,
			minExpiryMs: 30 * 60_000,
		});
		expect(() => parseAuthCommand(["auth", "print-api-key", "--min-expiry", "30m"])).toThrow(
			"only supported by print-bearer-token",
		);
		expect(isAuthCommandHelp(["auth", "--help"])).toBe(true);
		expect(isAuthCommandHelp(["auth", "print-api-key", "--help"])).toBe(true);
		expect(isAuthCommandHelp(["auth", "print-bearer-token", "-h"])).toBe(true);
		expect(isAuthCommandHelp(["auth", "check", "--help"])).toBe(true);
		expect(() => parseAuthCommand(["auth", "unknown"])).toThrow(AuthCommandError);
		await expect(resolveCredentialForPrint(parseArgs([]), runtime, "api_key")).rejects.toThrow(
			"requires --provider <provider> or --model <model>",
		);
		await expect(
			resolveCredentialForPrint(parseArgs(["--provider", "openai-codex"]), runtime, "api_key"),
		).rejects.toThrow("configured with OAuth");
	});
});

import { type Credential, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { describe, expect, test, vi } from "vitest";
import { runAuthLogout } from "../src/cli/auth-logout.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { CredentialSynchronizationError, ModelRuntime } from "../src/core/model-runtime.ts";

async function setup(data: Record<string, Credential>) {
	const credentials = AuthStorage.inMemory(data);
	const modelRuntime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
	});
	const lines: string[] = [];
	const errors: string[] = [];
	const run = (args: string[]) =>
		runAuthLogout(args, {
			modelRuntime,
			terminal: { write: (line) => lines.push(line), error: (line) => errors.push(line) },
			signal: new AbortController().signal,
		});
	return { credentials, modelRuntime, lines, errors, run };
}

const oauthCredential = {
	type: "oauth",
	access: "access",
	refresh: "refresh",
	expires: Date.now() + 3_600_000,
} as const;

describe("pi auth logout", () => {
	test("requires exactly one provider", async () => {
		const { errors, run } = await setup({});
		for (const args of [[], ["--api-key"], ["radius", "extra"]]) {
			errors.length = 0;
			expect(await run(args)).toBe(1);
			expect(errors).toEqual(["Usage: pi auth logout <provider>"]);
		}
	});

	test("removes a stored account login", async () => {
		const { credentials, lines, run } = await setup({ radius: oauthCredential });
		expect(await run(["radius"])).toBe(0);
		expect(lines).toEqual(["Logged out of Radius."]);
		expect(await credentials.read("radius")).toBeUndefined();
	});

	test("removes a stored API key by provider name and keeps other credentials", async () => {
		const { credentials, lines, run } = await setup({
			openai: { type: "api_key", key: "sk-test" },
			radius: oauthCredential,
		});
		expect(await run(["OpenAI"])).toBe(0);
		expect(lines).toEqual([
			"Removed stored API key for OpenAI. Environment variables and models.json config are unchanged.",
		]);
		expect(await credentials.read("openai")).toBeUndefined();
		expect(await credentials.read("radius")).toMatchObject({ type: "oauth" });
	});

	test("succeeds when nothing is stored, so it can be repeated", async () => {
		const { lines, run } = await setup({});
		expect(await run(["radius"])).toBe(0);
		expect(lines).toEqual([
			"No stored credentials for Radius. Environment variables and models.json config are unchanged.",
		]);
	});

	test("removes credentials of providers that are not loaded, matched by id", async () => {
		const { credentials, lines, run } = await setup({ "extension-provider": oauthCredential });
		expect(await run(["extension-provider"])).toBe(0);
		expect(lines).toEqual(["Logged out of extension-provider."]);
		expect(await credentials.read("extension-provider")).toBeUndefined();
	});

	test("reports credential removal failures", async () => {
		const { modelRuntime, errors, run } = await setup({ radius: oauthCredential });
		vi.spyOn(modelRuntime, "logout").mockRejectedValue(new Error("storage failed"));
		expect(await run(["radius"])).toBe(1);
		expect(errors).toEqual(["Logout failed: storage failed"]);
	});

	test("reports committed credential removal separately from a failed logout", async () => {
		const { modelRuntime, errors, run } = await setup({ radius: oauthCredential });
		vi.spyOn(modelRuntime, "logout").mockRejectedValue(
			new CredentialSynchronizationError("radius", "logout", undefined, { cause: new Error("snapshot failed") }),
		);
		expect(await run(["radius"])).toBe(1);
		expect(errors[0]).toContain("Credentials removed for Radius, but local model state could not be synchronized:");
	});

	test("rejects an unknown provider and lists the stored credentials", async () => {
		const { errors, run } = await setup({ radius: oauthCredential });
		expect(await run(["nope"])).toBe(1);
		expect(errors).toEqual(['Unknown provider "nope".', "Stored credentials: radius"]);
	});
});

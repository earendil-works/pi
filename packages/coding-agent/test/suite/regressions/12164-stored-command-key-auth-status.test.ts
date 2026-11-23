import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

// Providers without an API key of their own, so only their stored credentials configure them.
const providersWithoutKeys = {
	providers: Object.fromEntries(
		["failing-command", "working-command"].map((provider) => [
			provider,
			{ baseUrl: "https://example.test/v1", api: "openai-completions", models: [{ id: "model" }] },
		]),
	),
};

describe("issue #12164 stored command key auth status", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("reports a stored key whose command fails as not configured", async () => {
		harness = await createHarness({ withConfiguredAuth: false, modelsJson: providersWithoutKeys });
		const runtime = harness.session.modelRuntime;
		await harness.authStorage.modify("failing-command", async () => ({ type: "api_key", key: "!exit 1" }));
		await harness.authStorage.modify("working-command", async () => ({ type: "api_key", key: "!echo key" }));
		await runtime.refresh({ allowNetwork: false });

		expect(runtime.getProviderAuthStatus("failing-command")).toEqual({ configured: false });
		expect(runtime.hasConfiguredAuth("failing-command")).toBe(false);
		expect(runtime.getProviderAuthStatus("working-command")).toEqual({ configured: true, source: "stored" });
		expect(runtime.hasConfiguredAuth("working-command")).toBe(true);
	});
});

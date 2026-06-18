import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { ModelRegistry } from "../../../src/core/model-registry.ts";
import { runMigrations } from "../../../src/migrations.ts";
import { createHarness } from "../harness.ts";

describe("regression #5661: uppercase models.json header values", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
	});

	function withAgentDir(agentDir: string, fn: () => void): void {
		const previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		try {
			fn();
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env[ENV_AGENT_DIR];
			} else {
				process.env[ENV_AGENT_DIR] = previousAgentDir;
			}
		}
	}

	it("keeps uppercase header strings as literals during startup migrations", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		cleanups.push(harness.cleanup);

		const envKeys = ["CUSTOM_API_KEY", "BEARER"];
		const savedEnv: Record<string, string | undefined> = {};
		for (const key of envKeys) {
			savedEnv[key] = process.env[key];
			process.env[key] = `env-${key}`;
		}
		cleanups.push(() => {
			for (const key of envKeys) {
				if (savedEnv[key] === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = savedEnv[key];
				}
			}
		});

		const modelsPath = join(harness.tempDir, "models.json");
		writeFileSync(
			modelsPath,
			`${JSON.stringify(
				{
					providers: {
						"my-provider": {
							baseUrl: "https://example.com/v1",
							apiKey: "CUSTOM_API_KEY",
							api: "openai-completions",
							headers: { Authorization: "BEARER" },
							models: [{ id: "my-model" }],
						},
					},
				},
				null,
				2,
			)}\n`,
			"utf-8",
		);

		withAgentDir(harness.tempDir, () => runMigrations(harness.tempDir));

		const migrated = JSON.parse(readFileSync(modelsPath, "utf-8")) as {
			providers: Record<string, { apiKey?: string; headers?: Record<string, string> }>;
		};
		expect(migrated.providers["my-provider"]?.apiKey).toBe("CUSTOM_API_KEY");
		expect(migrated.providers["my-provider"]?.headers?.Authorization).toBe("BEARER");

		const registry = ModelRegistry.create(AuthStorage.create(join(harness.tempDir, "auth.json")), modelsPath);
		const model = registry.find("my-provider", "my-model");
		expect(model).toBeDefined();
		expect(await registry.getApiKeyAndHeaders(model!)).toMatchObject({
			ok: true,
			apiKey: "CUSTOM_API_KEY",
			headers: { Authorization: "BEARER" },
		});
	});
});

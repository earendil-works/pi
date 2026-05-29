import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { runMigrations } from "../src/migrations.ts";

describe("config value env var syntax migration", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		vi.restoreAllMocks();
	});

	function createAgentDir(): string {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-value-migration-test-"));
		tempDirs.push(agentDir);
		return agentDir;
	}

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

	it("rewrites legacy uppercase auth.json API key values to explicit env references", () => {
		const agentDir = createAgentDir();
		fs.writeFileSync(
			path.join(agentDir, "auth.json"),
			`${JSON.stringify(
				{
					anthropic: { type: "api_key", key: "ANTHROPIC_API_KEY" },
					openai: { type: "api_key", key: "$OPENAI_API_KEY" },
					opencode: { type: "api_key", key: "public" },
					github: { type: "oauth", access: "ACCESS_TOKEN", refresh: "REFRESH_TOKEN", expires: 1 },
				},
				null,
				2,
			)}\n`,
			"utf-8",
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		withAgentDir(agentDir, () => runMigrations(agentDir));

		const migrated = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf-8")) as Record<
			string,
			Record<string, unknown>
		>;
		expect(migrated.anthropic.key).toBe("$ANTHROPIC_API_KEY");
		expect(migrated.openai.key).toBe("$OPENAI_API_KEY");
		expect(migrated.opencode.key).toBe("public");
		expect(migrated.github.access).toBe("ACCESS_TOKEN");
		const logMessage = String(logSpy.mock.calls[0]?.[0] ?? "");
		expect(logMessage).toContain("explicit $ENV_VAR syntax");
		expect(logMessage).toContain('auth.json["anthropic"].key: ANTHROPIC_API_KEY -> $ANTHROPIC_API_KEY');
	});

	it("rewrites legacy uppercase models.json API key and header values", () => {
		const agentDir = createAgentDir();
		fs.writeFileSync(
			path.join(agentDir, "models.json"),
			`${JSON.stringify(
				{
					providers: {
						"custom-provider": {
							baseUrl: "https://example.com/v1",
							apiKey: "CUSTOM_API_KEY",
							api: "openai-completions",
							headers: {
								"x-api-key": "HEADER_API_KEY",
								"x-literal": "literal",
							},
							models: [
								{
									id: "model-a",
									headers: { "x-model-key": "MODEL_API_KEY" },
								},
							],
							modelOverrides: {
								"model-b": { headers: { "x-override-key": "OVERRIDE_API_KEY" } },
							},
						},
					},
				},
				null,
				2,
			)}\n`,
			"utf-8",
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		withAgentDir(agentDir, () => runMigrations(agentDir));

		const migrated = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf-8")) as {
			providers: Record<
				string,
				{
					apiKey?: string;
					headers?: Record<string, string>;
					models?: Array<{ headers?: Record<string, string> }>;
					modelOverrides?: Record<string, { headers?: Record<string, string> }>;
				}
			>;
		};
		const provider = migrated.providers["custom-provider"]!;
		expect(provider.apiKey).toBe("$CUSTOM_API_KEY");
		expect(provider.headers?.["x-api-key"]).toBe("$HEADER_API_KEY");
		expect(provider.headers?.["x-literal"]).toBe("literal");
		expect(provider.models?.[0]?.headers?.["x-model-key"]).toBe("$MODEL_API_KEY");
		expect(provider.modelOverrides?.["model-b"]?.headers?.["x-override-key"]).toBe("$OVERRIDE_API_KEY");
		const logMessage = String(logSpy.mock.calls[0]?.[0] ?? "");
		expect(logMessage).toContain(
			'models.json.providers["custom-provider"].apiKey: CUSTOM_API_KEY -> $CUSTOM_API_KEY',
		);
		expect(logMessage).toContain(
			'models.json.providers["custom-provider"].headers["x-api-key"]: HEADER_API_KEY -> $HEADER_API_KEY',
		);
		expect(logMessage).toContain(
			'models.json.providers["custom-provider"].models["model-a"].headers["x-model-key"]: MODEL_API_KEY -> $MODEL_API_KEY',
		);
		expect(logMessage).toContain(
			'models.json.providers["custom-provider"].modelOverrides["model-b"].headers["x-override-key"]: OVERRIDE_API_KEY -> $OVERRIDE_API_KEY',
		);
	});
});

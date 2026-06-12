import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";

describe("regression #5663: setActiveTools(undefined) restores all tools", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-setactivetools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession() {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.registerTool({
							name: "ext_tool",
							label: "Extension Tool",
							description: "Tool from extension",
							promptSnippet: "Run ext behavior",
							parameters: Type.Object({}),
							execute: async () => ({
								content: [{ type: "text", text: "ok" }],
								details: {},
							}),
						});
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});
		await session.bindExtensions({});
		return session;
	}

	it("setActiveTools(undefined) restores all registered tools", async () => {
		const session = await createSession();
		const allToolNames = session.getAllTools().map((t) => t.name);

		// Restrict to a subset
		session.setActiveToolsByName(["read", "ext_tool"]);
		expect(session.getActiveToolNames().sort()).toEqual(["ext_tool", "read"]);

		// Restore all via undefined
		session.setActiveToolsByName(undefined);
		expect(session.getActiveToolNames().sort()).toEqual(
			allToolNames.sort(),
		);

		session.dispose();
	});

	it("setActiveTools(null) restores all registered tools", async () => {
		const session = await createSession();
		const allToolNames = session.getAllTools().map((t) => t.name);

		// Restrict to a subset
		session.setActiveToolsByName(["bash"]);
		expect(session.getActiveToolNames()).toEqual(["bash"]);

		// Restore all via null
		session.setActiveToolsByName(null);
		expect(session.getActiveToolNames().sort()).toEqual(
			allToolNames.sort(),
		);

		session.dispose();
	});

	it("setActiveTools with empty array disables all tools", async () => {
		const session = await createSession();

		// Empty array should still disable all, not restore
		session.setActiveToolsByName([]);
		expect(session.getActiveToolNames()).toEqual([]);

		session.dispose();
	});
});

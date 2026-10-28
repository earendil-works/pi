import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { type CreateAgentSessionOptions, createAgentSession, type InlineExtension } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

type ToolOptions = Pick<CreateAgentSessionOptions, "tools" | "excludeTools" | "noTools" | "customTools">;

describe("defaultTools setting", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-default-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(
		defaultTools: string[],
		options: ToolOptions = {},
		extensionFactories: InlineExtension[] = [],
	) {
		const settingsManager = SettingsManager.inMemory({ defaultTools });
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories,
		});
		await resourceLoader.reload();

		return (
			await createAgentSession({
				cwd: tempDir,
				agentDir,
				model: getModel("anthropic", "claude-sonnet-4-5")!,
				settingsManager,
				sessionManager: SessionManager.inMemory(tempDir),
				resourceLoader,
				...options,
			})
		).session;
	}

	it("uses the configured list as the initial built-in selection", async () => {
		const session = await createSession(["grep", "find"]);

		expect(
			session
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
		).toEqual(["bash", "edit", "find", "grep", "ls", "powershell", "read", "write"]);
		expect(session.getActiveToolNames()).toEqual(["grep", "find"]);
		expect(session.systemPrompt).toContain("- grep:");
		expect(session.systemPrompt).not.toContain("- read:");
		session.dispose();
	});

	it("can select powershell instead of bash", async () => {
		const session = await createSession(["read", "powershell", "edit", "write"]);

		expect(session.getActiveToolNames()).toEqual(["read", "powershell", "edit", "write"]);
		expect(session.systemPrompt).toContain("- powershell: Execute PowerShell commands");
		expect(session.systemPrompt).not.toContain("- bash:");
		session.dispose();
	});

	it("activates an inactive extension tool with +name", async () => {
		const session = await createSession(["+inactive_tool", "-write"], {}, [
			(pi) => {
				pi.registerTool({
					name: "inactive_tool",
					label: "Inactive Tool",
					description: "Extension tool registered inactive",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					defaultActive: false,
				});
			},
		]);

		expect(session.getActiveToolNames().sort()).toEqual(["bash", "edit", "inactive_tool", "read"]);
		session.dispose();
	});

	it("keeps extension and SDK custom tools enabled", async () => {
		const session = await createSession(
			["grep"],
			{
				customTools: [
					{
						name: "sdk_tool",
						label: "SDK Tool",
						description: "SDK custom tool",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					},
				],
			},
			[
				(pi) => {
					pi.registerTool({
						name: "static_tool",
						label: "Static Tool",
						description: "Statically registered extension tool",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
					pi.on("session_start", () => {
						pi.registerTool({
							name: "dynamic_tool",
							label: "Dynamic Tool",
							description: "Dynamically registered extension tool",
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
						});
					});
				},
			],
		);
		await session.bindExtensions({});

		expect(session.getActiveToolNames().sort()).toEqual(["dynamic_tool", "grep", "sdk_tool", "static_tool"]);
		expect(session.getAllTools().map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["read", "dynamic_tool", "sdk_tool", "static_tool"]),
		);
		session.dispose();
	});

	it("preserves explicit tool option precedence", async () => {
		const allowlistedSession = await createSession(["grep"], { tools: ["read"] });
		expect(allowlistedSession.getActiveToolNames()).toEqual(["read"]);
		allowlistedSession.dispose();

		const excludedSession = await createSession(["read", "grep"], { excludeTools: ["read"] });
		expect(excludedSession.getActiveToolNames()).toEqual(["grep"]);
		excludedSession.dispose();

		const toolLessSession = await createSession(["read"], { noTools: "all" });
		expect(toolLessSession.getAllTools()).toEqual([]);
		expect(toolLessSession.getActiveToolNames()).toEqual([]);
		toolLessSession.dispose();
	});

	it("applies +name and -name tool options to the default selection", async () => {
		const inactiveTool: InlineExtension = (pi) => {
			pi.registerTool({
				name: "inactive_tool",
				label: "Inactive Tool",
				description: "Extension tool registered inactive",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				defaultActive: false,
			});
			pi.registerTool({
				name: "active_tool",
				label: "Active Tool",
				description: "Extension tool registered active",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			});
		};

		const session = await createSession(["+grep"], { tools: ["+inactive_tool", "-write"] }, [inactiveTool]);
		expect(session.getActiveToolNames().sort()).toEqual([
			"active_tool",
			"bash",
			"edit",
			"grep",
			"inactive_tool",
			"read",
		]);
		session.dispose();

		const toolLess = await createSession(["read"], { noTools: "all", tools: ["+inactive_tool"] }, [inactiveTool]);
		expect(toolLess.getActiveToolNames()).toEqual(["inactive_tool"]);
		toolLess.dispose();
	});

	it("rejects invalid tool modifier options", async () => {
		await expect(createSession([], { tools: ["read", "+grep"] })).rejects.toThrow(
			"Invalid tools option: tool names cannot be mixed with +name or -name entries",
		);
		await expect(createSession([], { tools: ["-gr*"] })).rejects.toThrow(
			"Invalid tools option: +name and -name entries take exact tool names, not patterns: -gr*",
		);
	});

	describe("reload", () => {
		const inactiveTool: InlineExtension = (pi) => {
			pi.registerTool({
				name: "inactive_tool",
				label: "Inactive Tool",
				description: "Extension tool registered inactive",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				defaultActive: false,
			});
		};

		const writeSettings = (settings: object) =>
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));

		async function createFileSession(options: ToolOptions = {}) {
			const settingsManager = SettingsManager.create(tempDir, agentDir);
			const resourceLoader = new DefaultResourceLoader({
				cwd: tempDir,
				agentDir,
				settingsManager,
				extensionFactories: [inactiveTool],
			});
			await resourceLoader.reload();
			return (
				await createAgentSession({
					cwd: tempDir,
					agentDir,
					model: getModel("anthropic", "claude-sonnet-4-5")!,
					settingsManager,
					sessionManager: SessionManager.inMemory(tempDir),
					resourceLoader,
					...options,
				})
			).session;
		}

		// #10245
		it("activates only tools newly added to defaultTools", async () => {
			const session = await createFileSession();
			expect(session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);
			session.setActiveToolsByName(["read", "edit", "write"]);

			writeSettings({ defaultTools: ["+inactive_tool", "+grep"] });
			await session.reload();
			// bash was disabled during the session and is not newly added, so it stays off.
			expect(session.getActiveToolNames().sort()).toEqual(["edit", "grep", "inactive_tool", "read", "write"]);

			// Removing tools from the setting does not disable them.
			writeSettings({ defaultTools: ["-read"] });
			await session.reload();
			expect(session.getActiveToolNames().sort()).toEqual(["edit", "grep", "inactive_tool", "read", "write"]);
			session.dispose();
		});

		it("keeps tools removed by -name tool options removed on reload", async () => {
			writeSettings({ defaultTools: ["read"] });
			const session = await createFileSession({ tools: ["-bash", "+grep"] });
			expect(session.getActiveToolNames()).toEqual(["read", "grep"]);

			writeSettings({ defaultTools: ["read", "bash", "inactive_tool"] });
			await session.reload();
			expect(session.getActiveToolNames().sort()).toEqual(["grep", "inactive_tool", "read"]);
			session.dispose();
		});

		it("keeps explicit tool options on reload", async () => {
			const allowlisted = await createFileSession({ tools: ["read"] });
			writeSettings({ defaultTools: ["+grep"] });
			await allowlisted.reload();
			expect(allowlisted.getActiveToolNames()).toEqual(["read"]);
			allowlisted.dispose();

			writeSettings({});
			const builtinless = await createFileSession({ noTools: "builtin" });
			writeSettings({ defaultTools: ["+grep"] });
			await builtinless.reload();
			expect(builtinless.getActiveToolNames()).toEqual([]);
			builtinless.dispose();

			writeSettings({});
			const excluded = await createFileSession({ excludeTools: ["grep"] });
			writeSettings({ defaultTools: ["+grep", "+inactive_tool"] });
			await excluded.reload();
			expect(excluded.getActiveToolNames().sort()).toEqual(["bash", "edit", "inactive_tool", "read", "write"]);
			excluded.dispose();
		});
	});

	// #10785
	describe("resume", () => {
		const extensionTools: InlineExtension = (pi) => {
			pi.registerTool({
				name: "inactive_tool",
				label: "Inactive Tool",
				description: "Extension tool registered inactive",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				defaultActive: false,
			});
			pi.registerTool({
				name: "active_tool",
				label: "Active Tool",
				description: "Extension tool registered active",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			});
		};

		const toolReferences = (names: string[]) =>
			names.map((name) => ({ name, description: name, parameters: Type.Object({}) }));

		/** Append a system message that adds and removes tools, as a run records loadout changes. */
		function recordLoadoutChange(sessionManager: SessionManager, added: string[], removed: string[] = []): string {
			return sessionManager.appendMessage({
				role: "system",
				content: "",
				...(added.length > 0 ? { toolsAdded: toolReferences(added) } : {}),
				...(removed.length > 0 ? { toolsRemoved: toolReferences(removed) } : {}),
				timestamp: Date.now(),
			});
		}

		/** A session whose transcript records the loadout `toolNames`, as a run records it. */
		function createRecordedSession(toolNames: string[]): SessionManager {
			const sessionManager = SessionManager.inMemory(tempDir);
			recordLoadoutChange(sessionManager, toolNames);
			return sessionManager;
		}

		/** A session that recorded `read`, `grep`, and `inactive_tool`, and deactivated `active_tool`. */
		function createChangedSession(): SessionManager {
			const sessionManager = createRecordedSession(["read", "grep", "active_tool"]);
			recordLoadoutChange(sessionManager, ["inactive_tool"], ["active_tool"]);
			return sessionManager;
		}

		async function resume(sessionManager: SessionManager, options: ToolOptions = {}) {
			const settingsManager = SettingsManager.inMemory();
			const resourceLoader = new DefaultResourceLoader({
				cwd: tempDir,
				agentDir,
				settingsManager,
				extensionFactories: [extensionTools],
			});
			await resourceLoader.reload();
			return (
				await createAgentSession({
					cwd: tempDir,
					agentDir,
					model: getModel("anthropic", "claude-sonnet-4-5")!,
					settingsManager,
					sessionManager,
					resourceLoader,
					...options,
				})
			).session;
		}

		it("restores the loadout the transcript records", async () => {
			const session = await resume(createChangedSession());
			expect(session.getActiveToolNames().sort()).toEqual(["grep", "inactive_tool", "read"]);
			session.dispose();
		});

		// #11062
		it("activates extension tools the transcript never added or removed", async () => {
			// Built-in tools and tools registered inactive stay inactive.
			const session = await resume(createRecordedSession(["read", "grep"]));
			expect(session.getActiveToolNames().sort()).toEqual(["active_tool", "grep", "read"]);
			session.dispose();
		});

		it("keeps tools removed before a compaction inactive", async () => {
			const sessionManager = createChangedSession();
			const kept = sessionManager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
			sessionManager.appendCompaction("summary", kept, 1000);
			const session = await resume(sessionManager);
			expect(session.getActiveToolNames().sort()).toEqual(["grep", "inactive_tool", "read"]);
			session.dispose();
		});

		// #11075
		it("restores the target branch's loadout on tree navigation", async () => {
			// The target branch never mentions active_tool, so it is active there. It removed grep.
			const sessionManager = createRecordedSession(["read", "grep"]);
			recordLoadoutChange(sessionManager, [], ["grep"]);
			const target = sessionManager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
			recordLoadoutChange(sessionManager, ["grep"], ["active_tool"]);
			const session = await resume(sessionManager);
			expect(session.getActiveToolNames().sort()).toEqual(["grep", "read"]);

			await session.navigateTree(target, { summarize: false });
			expect(session.getActiveToolNames().sort()).toEqual(["active_tool", "read"]);
			session.dispose();
		});

		it("keeps registered tools outside the tools allowlist inactive on tree navigation", async () => {
			// An allowlist without mcp__ entries keeps MCP tools registered but inactive.
			const sessionManager = createRecordedSession(["read"]);
			const target = sessionManager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
			const session = await resume(sessionManager, {
				tools: ["read"],
				customTools: [
					{
						name: "mcp__server__lookup",
						label: "Lookup",
						description: "MCP tool",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					},
				],
			});
			expect(session.getActiveToolNames()).toEqual(["read"]);

			await session.navigateTree(target, { summarize: false });
			expect(session.getActiveToolNames()).toEqual(["read"]);
			session.dispose();
		});

		it("does not restore excluded tools", async () => {
			const session = await resume(createChangedSession(), {
				excludeTools: ["inactive_tool"],
			});
			expect(session.getActiveToolNames().sort()).toEqual(["grep", "read"]);
			session.dispose();
		});

		it("uses explicit tool options instead of the recorded loadout", async () => {
			const allowlisted = await resume(createChangedSession(), { tools: ["read", "write"] });
			expect(allowlisted.getActiveToolNames()).toEqual(["read", "write"]);
			allowlisted.dispose();

			const builtinless = await resume(createChangedSession(), { noTools: "builtin" });
			expect(builtinless.getActiveToolNames()).toEqual(["active_tool"]);
			builtinless.dispose();
		});

		it("applies +name and -name tool options to the recorded loadout", async () => {
			const session = await resume(createChangedSession(), {
				tools: ["-grep", "+write"],
			});
			expect(session.getActiveToolNames().sort()).toEqual(["inactive_tool", "read", "write"]);
			session.dispose();
		});

		it("uses the default tools when the transcript records no loadout", async () => {
			const sessionManager = SessionManager.inMemory(tempDir);
			sessionManager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
			const session = await resume(sessionManager);
			expect(session.getActiveToolNames().sort()).toEqual(["active_tool", "bash", "edit", "read", "write"]);
			session.dispose();
		});
	});

	it("applies through service-based session creation", async () => {
		const settingsManager = SettingsManager.inMemory({ defaultTools: ["ls"] });
		const services = await createAgentSessionServices({ cwd: tempDir, agentDir, settingsManager });
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(tempDir),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
		});

		expect(
			session
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
		).toEqual(["bash", "edit", "find", "grep", "ls", "powershell", "read", "write"]);
		expect(session.getActiveToolNames()).toEqual(["ls"]);
		session.dispose();
	});
});

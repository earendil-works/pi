/**
 * Runtime lifecycle cleanup tests for VAL-CORE assertions:
 * - VAL-CORE-002: Reload swaps extension registrations without duplicate definitions
 * - VAL-CORE-007: Extension state persists across reload and fails open on missing state
 * - VAL-CORE-008: Unloaded extensions stop affecting hooks and indicators
 * - VAL-CORE-009: Built-in slash commands keep precedence over extension commands
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@kennyfrc/mu-ai";
import { type TSchema, Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExtensionLoader } from "../src/extensions/loader.js";
import { ExtensionManager } from "../src/extensions/manager.js";
import type { ExtensionFactory } from "../src/extensions/types.js";
import { eraseAgentTool } from "../src/extensions/types.js";

function makeBuiltInTools(): Record<string, AgentTool<TSchema, unknown>> {
	const schema = Type.Object({});
	const bash: AgentTool<typeof schema, { ok: true; projection: unknown }> = {
		label: "bash",
		name: "bash",
		description: "bash",
		parameters: schema,
		execute: async () => ({
			content: [{ type: "text", text: "bash" }],
			details: {
				ok: true,
				projection: {
					version: 1,
					call: { style: "argv", text: "bash", argv: [] },
				},
			},
		}),
	};
	return { bash: eraseAgentTool(bash) };
}

function projectionForTest(name: string): { version: 1; call: { style: "argv"; text: string; argv: string[] } } {
	return {
		version: 1,
		call: { style: "argv", text: name, argv: [name] },
	};
}

describe("VAL-CORE-002: Reload swaps extension registrations without duplicate definitions", () => {
	let projectDir: string;
	let extDir: string;
	let mgr: ExtensionManager;
	let loader: ExtensionLoader;

	beforeEach(async () => {
		projectDir = await mkdtemp(join(tmpdir(), "mu-core-002-"));
		extDir = join(projectDir, ".mu", "extensions");
		await mkdir(extDir, { recursive: true });
		mgr = new ExtensionManager({ builtInTools: makeBuiltInTools() });
		loader = new ExtensionLoader(mgr, { projectDir, configDir: join(projectDir, "_config") });
	});

	afterEach(async () => {
		await rm(projectDir, { recursive: true, force: true });
	});

	it("removes stale tool registrations after reload", async () => {
		const extPath = join(extDir, "ext.ts");

		// Version 1: registers tool "extra-v1"
		const version1 = `
import { Type } from "@sinclair/typebox";

export default function (mu) {
  mu.registerTool({
    label: "extra-v1",
    name: "extra",
    description: "extra v1",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text", text: "v1" }],
        details: {
          v: 1,
          projection: { version: 1, call: { style: "argv", text: "extra v1", argv: ["extra", "v1"] } }
        }
      };
    }
  });
}
`;
		await writeFile(extPath, version1, "utf8");

		const res1 = await loader.loadAll();
		expect(res1.map((r) => r.ok)).toEqual([true]);

		let tools = mgr.getToolsForSelection(["bash"]);
		expect(tools.find((t) => t.name === "extra")?.label).toBe("extra-v1");

		// Version 2: renames tool to "extra-v2"
		const version2 = version1.replace("extra-v1", "extra-v2").replace("v1", "v2");
		await writeFile(extPath, version2, "utf8");

		const res2 = await loader.reloadAll();
		expect(res2.map((r) => r.ok)).toEqual([true]);

		tools = mgr.getToolsForSelection(["bash"]);
		const extra = tools.find((t) => t.name === "extra");
		expect(extra?.label).toBe("extra-v2");
		// No duplicate definitions - only one tool named "extra" exists
		const extraCount = tools.filter((t) => t.name === "extra").length;
		expect(extraCount).toBe(1);
	});

	it("removes stale command registrations after reload", async () => {
		const extPath = join(extDir, "ext.ts");

		const version1 = `
export default function (mu) {
  mu.registerCommand({
    name: "review",
    description: "Review v1",
    execute: () => "v1"
  });
}
`;
		await writeFile(extPath, version1, "utf8");

		await loader.loadAll();
		expect(mgr.getCommand("review")?.description).toBe("Review v1");

		// Version 2: different command description
		const version2 = `
export default function (mu) {
  mu.registerCommand({
    name: "review",
    description: "Review v2",
    execute: () => "v2"
  });
}
`;
		await writeFile(extPath, version2, "utf8");

		await loader.reloadAll();
		expect(mgr.getCommand("review")?.description).toBe("Review v2");

		// Verify no duplicate commands exist
		const commands = mgr.listCommands();
		const reviewCommands = commands.filter((c) => c.name === "review");
		expect(reviewCommands.length).toBe(1);
	});

	it("removes stale indicators after reload", async () => {
		const extPath = join(extDir, "ext.ts");

		const version1 = `
export default function (mu) {
  mu.registerExtensionIndicator({
    id: "status-indicator",
    label: "STATUS V1",
    color: "accent",
    priority: 10
  });
}
`;
		await writeFile(extPath, version1, "utf8");

		await loader.loadAll();
		let indicators = mgr.getIndicators();
		expect(indicators.find((i) => i.id === "status-indicator")?.label).toBe("STATUS V1");

		// Version 2: different indicator label
		const version2 = `
export default function (mu) {
  mu.registerExtensionIndicator({
    id: "status-indicator",
    label: "STATUS V2",
    color: "warning",
    priority: 20
  });
}
`;
		await writeFile(extPath, version2, "utf8");

		await loader.reloadAll();
		indicators = mgr.getIndicators();
		expect(indicators.find((i) => i.id === "status-indicator")?.label).toBe("STATUS V2");

		// No duplicate indicators
		expect(indicators.filter((i) => i.id === "status-indicator").length).toBe(1);
	});
});

describe("VAL-CORE-007: Extension state persists across reload and fails open on missing state", () => {
	let projectDir: string;
	let configDir: string;
	let mgr: ExtensionManager;
	let loader: ExtensionLoader;

	beforeEach(async () => {
		projectDir = await mkdtemp(join(tmpdir(), "mu-core-007-"));
		configDir = join(projectDir, "_config");
		await mkdir(configDir, { recursive: true });
		mgr = new ExtensionManager({ builtInTools: makeBuiltInTools() });
		loader = new ExtensionLoader(mgr, { projectDir, configDir });
	});

	afterEach(async () => {
		await rm(projectDir, { recursive: true, force: true });
	});

	it("persists extension state across reload", async () => {
		const extDir = join(projectDir, ".mu", "extensions");
		await mkdir(extDir, { recursive: true });
		const extPath = join(extDir, "ext.ts");

		const extCode = `
export default function (mu) {
  // Extension reads state on load
  const savedCount = mu.getExtensionState<number>("count") ?? 0;
  
  // Increment and save
  mu.setExtensionState("count", savedCount + 1);
  
  // Expose count via indicator for verification
  mu.registerExtensionIndicator({
    id: "count-indicator",
    label: "COUNT:" + (savedCount + 1),
    color: "accent"
  });
}
`;
		await writeFile(extPath, extCode, "utf8");

		// First load: count should be 1
		await loader.loadAll();
		let indicators = mgr.getIndicators();
		expect(indicators.find((i) => i.id === "count-indicator")?.label).toBe("COUNT:1");

		// Reload: count should increment
		await loader.reloadAll();
		indicators = mgr.getIndicators();
		expect(indicators.find((i) => i.id === "count-indicator")?.label).toBe("COUNT:2");

		// Another reload: count should increment again
		await loader.reloadAll();
		indicators = mgr.getIndicators();
		expect(indicators.find((i) => i.id === "count-indicator")?.label).toBe("COUNT:3");
	});

	it("fails open on missing state file", async () => {
		const extDir = join(projectDir, ".mu", "extensions");
		await mkdir(extDir, { recursive: true });
		const extPath = join(extDir, "ext.ts");

		const extCode = `
export default function (mu) {
  // Missing state should not crash - returns undefined
  const missing = mu.getExtensionState("nonexistent");
  
  // Should be able to proceed normally
  mu.registerExtensionIndicator({
    id: "loaded-indicator",
    label: "LOADED",
    color: "success"
  });
}
`;
		await writeFile(extPath, extCode, "utf8");

		// Should not throw even with no state file
		await expect(loader.loadAll()).resolves.toBeDefined();

		const indicators = mgr.getIndicators();
		expect(indicators.find((i) => i.id === "loaded-indicator")).toBeDefined();
	});

	it("fails open on corrupt state file", async () => {
		const extDir = join(projectDir, ".mu", "extensions");
		await mkdir(extDir, { recursive: true });
		const extPath = join(extDir, "ext.ts");

		// Create corrupt state file
		const stateDir = join(configDir, "extensions", "ext");
		await mkdir(stateDir, { recursive: true });
		await writeFile(join(stateDir, "state.json"), "{ invalid json }", "utf8");

		const extCode = `
export default function (mu) {
  // Corrupt state should not crash - starts fresh
  const value = mu.getExtensionState("any");
  
  mu.registerExtensionIndicator({
    id: "corrupt-ok",
    label: "CORRUPT OK",
    color: "success"
  });
}
`;
		await writeFile(extPath, extCode, "utf8");

		// Should not throw even with corrupt state
		await expect(loader.loadAll()).resolves.toBeDefined();

		const indicators = mgr.getIndicators();
		expect(indicators.find((i) => i.id === "corrupt-ok")).toBeDefined();
	});
});

describe("VAL-CORE-008: Unloaded extensions stop affecting hooks and indicators", () => {
	let projectDir: string;
	let configDir: string;
	let mgr: ExtensionManager;

	beforeEach(async () => {
		projectDir = await mkdtemp(join(tmpdir(), "mu-core-008-"));
		configDir = join(projectDir, "_config");
		await mkdir(configDir, { recursive: true });
		mgr = new ExtensionManager({ builtInTools: makeBuiltInTools() });
		mgr.setExtensionStateDir(join(configDir, "extensions"));
	});

	afterEach(async () => {
		await rm(projectDir, { recursive: true, force: true });
	});

	it("removes input hooks on extension unload", async () => {
		let transformed = false;

		const factory: ExtensionFactory = (api) => {
			api.input(async (text) => {
				transformed = true;
				return { type: "transform", text: text.toUpperCase() };
			});
		};

		await mgr.loadExtension(factory, "ext-hooks");

		// Hook is active
		const result1 = await mgr.applyInputHooks("hello");
		expect(result1.text).toBe("HELLO");
		expect(transformed).toBe(true);

		// Unload extension
		mgr.unloadBySourceId("ext-hooks");

		// Hook should no longer affect input
		transformed = false;
		const result2 = await mgr.applyInputHooks("hello");
		expect(result2.text).toBe("hello"); // Original text unchanged
		expect(transformed).toBe(false);
	});

	it("removes before-tool hooks on extension unload", async () => {
		let blocked = false;

		const factory: ExtensionFactory = (api) => {
			api.beforeToolCall(async (event) => {
				if (event.toolName === "bash") {
					blocked = true;
					return { type: "block", reason: "blocked for test" };
				}
				return { type: "noop" };
			});
		};

		await mgr.loadExtension(factory, "ext-before-tool");

		// Hook blocks bash
		const result1 = await (mgr as any).runner.applyBeforeToolCall({
			toolName: "bash",
			args: {},
		});
		expect(result1.blocked).toBe(true);

		// Unload extension
		mgr.unloadBySourceId("ext-before-tool");

		// Hook should no longer block
		blocked = false;
		const result2 = await (mgr as any).runner.applyBeforeToolCall({
			toolName: "bash",
			args: {},
		});
		expect(result2.blocked).toBe(false);
		expect(blocked).toBe(false);
	});

	it("removes after-tool hooks on extension unload", async () => {
		const factory: ExtensionFactory = (api) => {
			api.afterToolResult((result) => {
				return {
					...result,
					content: [{ type: "text", text: "modified" }],
				};
			});
		};

		await mgr.loadExtension(factory, "ext-after-tool");

		// Hook modifies result
		const result1 = (mgr as any).runner.applyAfterToolResult({
			role: "tool",
			toolCallId: "tc1",
			content: [{ type: "text", text: "original" }],
		});
		expect(result1.content[0].text).toBe("modified");

		// Unload extension
		mgr.unloadBySourceId("ext-after-tool");

		// Hook should no longer modify result
		const result2 = (mgr as any).runner.applyAfterToolResult({
			role: "tool",
			toolCallId: "tc2",
			content: [{ type: "text", text: "original" }],
		});
		expect(result2.content[0].text).toBe("original");
	});

	it("removes indicators on extension unload", async () => {
		const factory: ExtensionFactory = (api) => {
			api.registerExtensionIndicator({
				id: "ext-status",
				label: "EXT ACTIVE",
				color: "accent",
				priority: 10,
			});
		};

		await mgr.loadExtension(factory, "ext-indicator");

		// Indicator is present
		let indicators = mgr.getIndicators();
		expect(indicators.find((i) => i.id === "ext-status")).toBeDefined();

		// Unload extension
		mgr.unloadBySourceId("ext-indicator");

		// Indicator should be removed
		indicators = mgr.getIndicators();
		expect(indicators.find((i) => i.id === "ext-status")).toBeUndefined();
	});

	it("removes context hooks on extension unload", async () => {
		let contextHookCalled = false;

		const factory: ExtensionFactory = (api) => {
			api.context(async (messages) => {
				contextHookCalled = true;
				return messages;
			});
		};

		await mgr.loadExtension(factory, "ext-context");

		// Hook is active
		const preprocessor = mgr.getMessagePreprocessor();
		const msg = { role: "user" as const, content: "hello", timestamp: Date.now() };
		await preprocessor([msg]);
		expect(contextHookCalled).toBe(true);

		// Unload extension
		mgr.unloadBySourceId("ext-context");

		// Hook should no longer be called
		contextHookCalled = false;
		await preprocessor([msg]);
		expect(contextHookCalled).toBe(false);
	});
});

describe("VAL-CORE-009: Built-in slash commands keep precedence over extension commands", () => {
	let projectDir: string;
	let configDir: string;
	let mgr: ExtensionManager;
	let loader: ExtensionLoader;

	beforeEach(async () => {
		projectDir = await mkdtemp(join(tmpdir(), "mu-core-009-"));
		configDir = join(projectDir, "_config");
		await mkdir(configDir, { recursive: true });
		mgr = new ExtensionManager({ builtInTools: makeBuiltInTools() });
		loader = new ExtensionLoader(mgr, {
			projectDir,
			configDir,
			builtInExtensions: [
				{
					sourceId: "preset:built-in-cmd",
					factory: (api) => {
						api.registerCommand(
							{
								name: "review",
								description: "Built-in review command",
								execute: () => {
									// built-in command logic
								},
							},
							{ priority: 150 }, // Built-in priority
						);
					},
				},
			],
		});
	});

	afterEach(async () => {
		await rm(projectDir, { recursive: true, force: true });
	});

	it("built-in command wins over extension command with lower priority", async () => {
		const extDir = join(projectDir, ".mu", "extensions");
		await mkdir(extDir, { recursive: true });
		const extPath = join(extDir, "ext.ts");

		const extCode = `
export default function (mu) {
  mu.registerCommand({
    name: "review",
    description: "Extension review command",
    execute: () => {}
  }, { priority: 50 }); // Lower priority than built-in (150)
}
`;
		await writeFile(extPath, extCode, "utf8");

		await loader.loadAll();

		// Built-in command should win due to higher priority
		const cmd = mgr.getCommand("review");
		expect(cmd?.description).toBe("Built-in review command");
	});

	it("built-in command wins even when loaded after extension", async () => {
		const extDir = join(projectDir, ".mu", "extensions");
		await mkdir(extDir, { recursive: true });
		const extPath = join(extDir, "ext.ts");

		const extCode = `
export default function (mu) {
  mu.registerCommand({
    name: "review",
    description: "Extension review command",
    execute: () => {}
  }, { priority: 150 }); // Same priority as built-in
}
`;
		await writeFile(extPath, extCode, "utf8");

		await loader.loadAll();

		// Built-in should win because built-in extensions are loaded after discovered files
		// and last-write-wins for equal priority
		const cmd = mgr.getCommand("review");
		expect(cmd?.description).toBe("Built-in review command");
	});

	it("extension can still override built-in with higher priority", async () => {
		const extDir = join(projectDir, ".mu", "extensions");
		await mkdir(extDir, { recursive: true });
		const extPath = join(extDir, "ext.ts");

		const extCode = `
export default function (mu) {
  mu.registerCommand({
    name: "review",
    description: "Extension override",
    execute: () => {}
  }, { priority: 200 }); // Higher priority than built-in (150)
}
`;
		await writeFile(extPath, extCode, "utf8");

		await loader.loadAll();

		// Extension should win due to higher priority
		const cmd = mgr.getCommand("review");
		expect(cmd?.description).toBe("Extension override");
	});

	it("non-colliding extension commands remain available", async () => {
		const extDir = join(projectDir, ".mu", "extensions");
		await mkdir(extDir, { recursive: true });
		const extPath = join(extDir, "ext.ts");

		const extCode = `
export default function (mu) {
  // Colliding command (lower priority)
  mu.registerCommand({
    name: "review",
    description: "Extension review",
    execute: () => {}
  }, { priority: 50 });
  
  // Non-colliding command
  mu.registerCommand({
    name: "custom-cmd",
    description: "Custom extension command",
    execute: () => {}
  });
}
`;
		await writeFile(extPath, extCode, "utf8");

		await loader.loadAll();

		// Built-in wins for colliding command
		expect(mgr.getCommand("review")?.description).toBe("Built-in review command");

		// Non-colliding extension command is available
		expect(mgr.getCommand("custom-cmd")?.description).toBe("Custom extension command");
	});
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createEventBus } from "../src/core/event-bus.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import type { ExtensionActions, ExtensionContextActions, ToolGroupDefinition } from "../src/core/extensions/types.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";

describe("Tool Groups - Registration and Aggregation", () => {
	let tempDir: string;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tool-groups-test-"));
		sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(path.join(tempDir, "auth.json"));
		modelRegistry = ModelRegistry.create(authStorage);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const extensionActions: ExtensionActions = {
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: () => {},
		refreshTools: () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => {},
	};

	const contextActions: ExtensionContextActions = {
		getModel: () => undefined,
		isIdle: () => true,
		getSignal: () => undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	};

	function makeGroupDef(name: string, matchFn: (toolName: string) => boolean): ToolGroupDefinition {
		return {
			name,
			match: (toolName: string) => matchFn(toolName),
			render: () => null,
		};
	}

	it("registerToolGroup stores definition and getRegisteredToolGroupDefinitions returns them in load order", async () => {
		const runtime = createExtensionRuntime();
		const eventBus = createEventBus();

		const groupA = makeGroupDef("group-a", (t) => t === "read");
		const groupB = makeGroupDef("group-b", (t) => t === "grep");

		const ext1 = await loadExtensionFromFactory(
			(pi) => {
				pi.registerToolGroup(groupA);
			},
			tempDir,
			eventBus,
			runtime,
		);

		const ext2 = await loadExtensionFromFactory(
			(pi) => {
				pi.registerToolGroup(groupB);
			},
			tempDir,
			eventBus,
			runtime,
		);

		const runner = new ExtensionRunner([ext1, ext2], runtime, tempDir, sessionManager, modelRegistry);
		runner.bindCore(extensionActions, contextActions);

		const defs = runner.getRegisteredToolGroupDefinitions();
		expect(defs).toHaveLength(2);
		expect(defs[0]).toBe(groupA);
		expect(defs[1]).toBe(groupB);
	});

	it("duplicate name within same extension logs warning and ignores", async () => {
		const runtime = createExtensionRuntime();
		const eventBus = createEventBus();
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const group1 = makeGroupDef("my-group", (t) => t === "read");
		const group2 = makeGroupDef("my-group", (t) => t === "write");

		const ext = await loadExtensionFromFactory(
			(pi) => {
				pi.registerToolGroup(group1);
				pi.registerToolGroup(group2);
			},
			tempDir,
			eventBus,
			runtime,
		);

		const runner = new ExtensionRunner([ext], runtime, tempDir, sessionManager, modelRegistry);
		const defs = runner.getRegisteredToolGroupDefinitions();
		expect(defs).toHaveLength(1);
		expect(defs[0]).toBe(group1);
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("already registered"));

		warnSpy.mockRestore();
	});

	it("validation rejects invalid name/match/render with descriptive errors", async () => {
		const runtime = createExtensionRuntime();
		const eventBus = createEventBus();

		await expect(
			loadExtensionFromFactory(
				(pi) => {
					pi.registerToolGroup({ name: "", match: () => true, render: () => null });
				},
				tempDir,
				eventBus,
				runtime,
			),
		).rejects.toThrow("'name' must be a non-empty string");

		const runtime2 = createExtensionRuntime();
		await expect(
			loadExtensionFromFactory(
				(pi) => {
					pi.registerToolGroup({ name: "test", match: "not a function" as never, render: () => null });
				},
				tempDir,
				eventBus,
				runtime2,
			),
		).rejects.toThrow("'match' must be a function");

		const runtime3 = createExtensionRuntime();
		await expect(
			loadExtensionFromFactory(
				(pi) => {
					pi.registerToolGroup({ name: "test", match: () => true, render: 42 as never });
				},
				tempDir,
				eventBus,
				runtime3,
			),
		).rejects.toThrow("'render' must be a function");
	});

	it("first-match-wins priority when multiple group definitions could match", async () => {
		const runtime = createExtensionRuntime();
		const eventBus = createEventBus();

		const groupFromExt1 = makeGroupDef("read-group", (t) => t === "read");
		const groupFromExt2 = makeGroupDef("read-group", (t) => t === "read");

		const ext1 = await loadExtensionFromFactory(
			(pi) => {
				pi.registerToolGroup(groupFromExt1);
			},
			tempDir,
			eventBus,
			runtime,
		);

		const ext2 = await loadExtensionFromFactory(
			(pi) => {
				pi.registerToolGroup(groupFromExt2);
			},
			tempDir,
			eventBus,
			runtime,
		);

		const runner = new ExtensionRunner([ext1, ext2], runtime, tempDir, sessionManager, modelRegistry);
		runner.bindCore(extensionActions, contextActions);

		const defs = runner.getRegisteredToolGroupDefinitions();
		expect(defs).toHaveLength(2);
		// Both definitions are returned; first-match-wins is enforced by the consumer
		expect(defs[0]).toBe(groupFromExt1);
		expect(defs[1]).toBe(groupFromExt2);

		// Verify that iterating and finding the first match gives ext1's definition
		const firstMatch = defs.find((d) => d.match("read", {}));
		expect(firstMatch).toBe(groupFromExt1);
	});

	it("returns same object references (not clones)", async () => {
		const runtime = createExtensionRuntime();
		const eventBus = createEventBus();

		const group = makeGroupDef("my-group", (t) => t === "read");

		const ext = await loadExtensionFromFactory(
			(pi) => {
				pi.registerToolGroup(group);
			},
			tempDir,
			eventBus,
			runtime,
		);

		const runner = new ExtensionRunner([ext], runtime, tempDir, sessionManager, modelRegistry);
		const defs = runner.getRegisteredToolGroupDefinitions();
		expect(defs[0]).toBe(group);
	});

	it("multiple groups within same extension are returned in insertion order", async () => {
		const runtime = createExtensionRuntime();
		const eventBus = createEventBus();

		const groupA = makeGroupDef("group-a", (t) => t === "read");
		const groupB = makeGroupDef("group-b", (t) => t === "write");
		const groupC = makeGroupDef("group-c", (t) => t === "grep");

		const ext = await loadExtensionFromFactory(
			(pi) => {
				pi.registerToolGroup(groupA);
				pi.registerToolGroup(groupB);
				pi.registerToolGroup(groupC);
			},
			tempDir,
			eventBus,
			runtime,
		);

		const runner = new ExtensionRunner([ext], runtime, tempDir, sessionManager, modelRegistry);
		const defs = runner.getRegisteredToolGroupDefinitions();
		expect(defs).toHaveLength(3);
		expect(defs[0]).toBe(groupA);
		expect(defs[1]).toBe(groupB);
		expect(defs[2]).toBe(groupC);
	});
});

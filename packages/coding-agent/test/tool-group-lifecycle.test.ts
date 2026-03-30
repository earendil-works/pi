import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Terminal, Text, TUI } from "@mariozechner/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createEventBus } from "../src/core/event-bus.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import type {
	ExtensionActions,
	ExtensionContextActions,
	ToolGroupDefinition,
	ToolGroupMember,
} from "../src/core/extensions/types.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { ToolGroupComponent } from "../src/modes/interactive/components/tool-group.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

class FakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = true;
	writes: string[] = [];
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
}

function createTUI(): TUI {
	return new TUI(new FakeTerminal());
}

describe("Tool Group Lifecycle", () => {
	let tempDir: string;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tool-group-lifecycle-test-"));
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

	function makeGroupDef(
		name: string,
		matchFn: (toolName: string) => boolean,
		lifecycle?: ToolGroupDefinition["lifecycle"],
	): ToolGroupDefinition {
		return {
			name,
			match: (toolName: string) => matchFn(toolName),
			render: (members: ToolGroupMember[]) => new Text(`${members.length} members`, 0, 0),
			...(lifecycle !== undefined ? { lifecycle } : {}),
		};
	}

	describe("lifecycle scope defaulting", () => {
		it("omitted lifecycle defaults to message scope", async () => {
			const group = makeGroupDef("no-lifecycle", (t) => t === "read");
			expect(group.lifecycle).toBeUndefined();
			const resolvedScope = group.lifecycle?.scope ?? "message";
			expect(resolvedScope).toBe("message");
		});

		it("lifecycle: {} (present but no scope) defaults to message", async () => {
			const group = makeGroupDef("empty-lifecycle", (t) => t === "read", {});
			expect(group.lifecycle).toEqual({});
			const resolvedScope = group.lifecycle?.scope ?? "message";
			expect(resolvedScope).toBe("message");
		});

		it("lifecycle: { scope: undefined } defaults to message", async () => {
			const group = makeGroupDef("undef-scope", (t) => t === "read", { scope: undefined });
			const resolvedScope = group.lifecycle?.scope ?? "message";
			expect(resolvedScope).toBe("message");
		});
	});

	describe("explicit toolRun definitions are discoverable through registration flow", () => {
		it("toolRun-scoped definition is registered and discoverable", async () => {
			const runtime = createExtensionRuntime();
			const eventBus = createEventBus();

			const group = makeGroupDef("read-group", (t) => t === "read", { scope: "toolRun" });

			const ext = await loadExtensionFromFactory(
				(pi) => {
					pi.registerToolGroup(group);
				},
				tempDir,
				eventBus,
				runtime,
			);

			const runner = new ExtensionRunner([ext], runtime, tempDir, sessionManager, modelRegistry);
			runner.bindCore(extensionActions, contextActions);

			const defs = runner.getRegisteredToolGroupDefinitions();
			expect(defs).toHaveLength(1);
			expect(defs[0]).toBe(group);
			expect(defs[0].lifecycle?.scope).toBe("toolRun");
		});

		it("message-scoped definition is registered and discoverable", async () => {
			const runtime = createExtensionRuntime();
			const eventBus = createEventBus();

			const group = makeGroupDef("read-group", (t) => t === "read", { scope: "message" });

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
			expect(defs).toHaveLength(1);
			expect(defs[0]).toBe(group);
			expect(defs[0].lifecycle?.scope).toBe("message");
		});
	});

	describe("invalid scope values are rejected", () => {
		it("rejects invalid string scope", async () => {
			const runtime = createExtensionRuntime();
			const eventBus = createEventBus();

			await expect(
				loadExtensionFromFactory(
					(pi) => {
						pi.registerToolGroup({
							name: "bad-scope",
							match: () => true,
							render: () => null,
							lifecycle: { scope: "invalid" as any },
						});
					},
					tempDir,
					eventBus,
					runtime,
				),
			).rejects.toThrow('\'lifecycle.scope\' must be "message" or "toolRun"');
		});

		it("rejects non-object lifecycle (string)", async () => {
			const runtime = createExtensionRuntime();
			const eventBus = createEventBus();

			await expect(
				loadExtensionFromFactory(
					(pi) => {
						pi.registerToolGroup({
							name: "bad-lifecycle",
							match: () => true,
							render: () => null,
							lifecycle: "message" as any,
						});
					},
					tempDir,
					eventBus,
					runtime,
				),
			).rejects.toThrow("'lifecycle' must be an object");
		});

		it("rejects non-object lifecycle (number)", async () => {
			const runtime = createExtensionRuntime();
			const eventBus = createEventBus();

			await expect(
				loadExtensionFromFactory(
					(pi) => {
						pi.registerToolGroup({
							name: "bad-lifecycle",
							match: () => true,
							render: () => null,
							lifecycle: 42 as any,
						});
					},
					tempDir,
					eventBus,
					runtime,
				),
			).rejects.toThrow("'lifecycle' must be an object");
		});

		it("rejects non-object lifecycle (boolean)", async () => {
			const runtime = createExtensionRuntime();
			const eventBus = createEventBus();

			await expect(
				loadExtensionFromFactory(
					(pi) => {
						pi.registerToolGroup({
							name: "bad-lifecycle",
							match: () => true,
							render: () => null,
							lifecycle: true as any,
						});
					},
					tempDir,
					eventBus,
					runtime,
				),
			).rejects.toThrow("'lifecycle' must be an object");
		});

		it("rejects non-object lifecycle (array)", async () => {
			const runtime = createExtensionRuntime();
			const eventBus = createEventBus();

			await expect(
				loadExtensionFromFactory(
					(pi) => {
						pi.registerToolGroup({
							name: "bad-lifecycle",
							match: () => true,
							render: () => null,
							lifecycle: [] as any,
						});
					},
					tempDir,
					eventBus,
					runtime,
				),
			).rejects.toThrow("'lifecycle' must be an object");
		});

		it("rejects non-object lifecycle (null)", async () => {
			const runtime = createExtensionRuntime();
			const eventBus = createEventBus();

			await expect(
				loadExtensionFromFactory(
					(pi) => {
						pi.registerToolGroup({
							name: "bad-lifecycle",
							match: () => true,
							render: () => null,
							lifecycle: null as any,
						});
					},
					tempDir,
					eventBus,
					runtime,
				),
			).rejects.toThrow("'lifecycle' must be an object");
		});
	});

	describe("isClosed accessor", () => {
		it("reflects false before close and true after close", () => {
			const def = makeGroupDef("test", (t) => t === "read");
			const group = new ToolGroupComponent(createTUI(), def);

			expect(group.isClosed).toBe(false);

			group.addMember("tc-1", "read", {});
			expect(group.isClosed).toBe(false);

			group.close();
			expect(group.isClosed).toBe(true);
		});

		it("remains true after multiple close calls", () => {
			const def = makeGroupDef("test", (t) => t === "read");
			const group = new ToolGroupComponent(createTUI(), def);

			group.close();
			group.close();
			expect(group.isClosed).toBe(true);
		});
	});

	describe("loader/runner registration passes lifecycle metadata by reference", () => {
		it("lifecycle object is the same reference after registration", async () => {
			const runtime = createExtensionRuntime();
			const eventBus = createEventBus();

			const lifecycle = { scope: "toolRun" as const };
			const group: ToolGroupDefinition = {
				name: "ref-check",
				match: () => true,
				render: () => null,
				lifecycle,
			};

			const ext = await loadExtensionFromFactory(
				(pi) => {
					pi.registerToolGroup(group);
				},
				tempDir,
				eventBus,
				runtime,
			);

			const runner = new ExtensionRunner([ext], runtime, tempDir, sessionManager, modelRegistry);
			runner.bindCore(extensionActions, contextActions);

			const defs = runner.getRegisteredToolGroupDefinitions();
			expect(defs[0]).toBe(group);
			expect(defs[0].lifecycle).toBe(lifecycle);
		});
	});
});

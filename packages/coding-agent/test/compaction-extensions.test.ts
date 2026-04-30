/**
 * Tests for compaction extension events (before_compact / compact).
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import {
	createExtensionRuntime,
	type Extension,
	type SessionBeforeCompactEvent,
	type SessionCompactEvent,
	type SessionEvent,
} from "../src/core/extensions/index.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";
import { createCodingTools } from "../src/index.js";
import { createTestResourceLoader } from "./utilities.js";

const API_KEY = process.env.ANTHROPIC_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY;

describe.skipIf(!API_KEY)("Compaction extensions", () => {
	let session: AgentSession;
	let tempDir: string;
	let capturedEvents: SessionEvent[];

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-compaction-extensions-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		capturedEvents = [];
	});

	afterEach(async () => {
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	function createExtension(
		onBeforeCompact?: (event: SessionBeforeCompactEvent) => { cancel?: boolean; compaction?: any } | undefined,
		onCompact?: (event: SessionCompactEvent) => void,
	): Extension {
		const handlers = new Map<string, ((event: any, ctx: any) => Promise<any>)[]>();

		handlers.set("session_before_compact", [
			async (event: SessionBeforeCompactEvent) => {
				capturedEvents.push(event);
				if (onBeforeCompact) {
					return onBeforeCompact(event);
				}
				return undefined;
			},
		]);

		handlers.set("session_compact", [
			async (event: SessionCompactEvent) => {
				capturedEvents.push(event);
				if (onCompact) {
					onCompact(event);
				}
				return undefined;
			},
		]);

		return {
			path: "test-extension",
			resolvedPath: "/test/test-extension.ts",
			sourceInfo: createSyntheticSourceInfo("<test:test-extension>", { source: "test" }),
			handlers,
			tools: new Map(),
			messageRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		};
	}

	function createSession(extensions: Extension[]) {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => API_KEY,
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant. Be concise.",
				tools: createCodingTools(process.cwd()),
			},
		});

		const sessionManager = SessionManager.create(tempDir);
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage);

		const runtime = createExtensionRuntime();
		const resourceLoader = {
			...createTestResourceLoader(),
			getExtensions: () => ({ extensions, errors: [], runtime }),
		};

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader,
		});

		return session;
	}

	it("should emit before_compact and compact events", async () => {
		const extension = createExtension();
		createSession([extension]);

		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.prompt("What is 3+3? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.compact();

		const beforeCompactEvents = capturedEvents.filter(
			(e): e is SessionBeforeCompactEvent => e.type === "session_before_compact",
		);
		const compactEvents = capturedEvents.filter((e): e is SessionCompactEvent => e.type === "session_compact");

		expect(beforeCompactEvents.length).toBe(1);
		expect(compactEvents.length).toBe(1);

		const beforeEvent = beforeCompactEvents[0];
		expect(beforeEvent.preparation).toBeDefined();
		expect(beforeEvent.preparation.messagesToSummarize).toBeDefined();
		expect(beforeEvent.preparation.turnPrefixMessages).toBeDefined();
		expect(beforeEvent.preparation.tokensBefore).toBeGreaterThanOrEqual(0);
		expect(typeof beforeEvent.preparation.isSplitTurn).toBe("boolean");
		expect(beforeEvent.branchEntries).toBeDefined();
		// sessionManager, modelRegistry, and model are now on ctx, not event

		const afterEvent = compactEvents[0];
		expect(afterEvent.compactionEntry).toBeDefined();
		expect(afterEvent.compactionEntry.summary.length).toBeGreaterThan(0);
		expect(afterEvent.compactionEntry.tokensBefore).toBeGreaterThanOrEqual(0);
		expect(afterEvent.fromExtension).toBe(false);
	}, 120000);

	it("should allow extensions to cancel compaction", async () => {
		const extension = createExtension(() => ({ cancel: true }));
		createSession([extension]);

		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		await expect(session.compact()).rejects.toThrow("Compaction cancelled");

		const compactEvents = capturedEvents.filter((e) => e.type === "session_compact");
		expect(compactEvents.length).toBe(0);
	}, 120000);

	it("should allow extensions to provide custom compaction", async () => {
		const customSummary = "Custom summary from extension";

		const extension = createExtension((event) => {
			if (event.type === "session_before_compact") {
				return {
					compaction: {
						summary: customSummary,
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				};
			}
			return undefined;
		});
		createSession([extension]);

		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.prompt("What is 3+3? Reply with just the number.");
		await session.agent.waitForIdle();

		const result = await session.compact();

		expect(result.summary).toBe(customSummary);

		const compactEvents = capturedEvents.filter((e) => e.type === "session_compact");
		expect(compactEvents.length).toBe(1);

		const afterEvent = compactEvents[0];
		if (afterEvent.type === "session_compact") {
			expect(afterEvent.compactionEntry.summary).toBe(customSummary);
			expect(afterEvent.fromExtension).toBe(true);
		}
	}, 120000);

	it("should include entries in compact event after compaction is saved", async () => {
		const extension = createExtension();
		createSession([extension]);

		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.compact();

		const compactEvents = capturedEvents.filter((e) => e.type === "session_compact");
		expect(compactEvents.length).toBe(1);

		const afterEvent = compactEvents[0];
		if (afterEvent.type === "session_compact") {
			// sessionManager is now on ctx, use session.sessionManager directly
			const entries = session.sessionManager.getEntries();
			const hasCompactionEntry = entries.some((e: { type: string }) => e.type === "compaction");
			expect(hasCompactionEntry).toBe(true);
		}
	}, 120000);

	it("should continue with default compaction if extension throws error", async () => {
		const throwingExtension: Extension = {
			path: "throwing-extension",
			resolvedPath: "/test/throwing-extension.ts",
			sourceInfo: createSyntheticSourceInfo("<test:throwing-extension>", { source: "test" }),
			handlers: new Map<string, ((event: any, ctx: any) => Promise<any>)[]>([
				[
					"session_before_compact",
					[
						async (event: SessionBeforeCompactEvent) => {
							capturedEvents.push(event);
							throw new Error("Extension intentionally throws");
						},
					],
				],
				[
					"session_compact",
					[
						async (event: SessionCompactEvent) => {
							capturedEvents.push(event);
							return undefined;
						},
					],
				],
			]),
			tools: new Map(),
			messageRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		};

		createSession([throwingExtension]);

		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		const result = await session.compact();

		expect(result.summary).toBeDefined();
		expect(result.summary.length).toBeGreaterThan(0);

		const compactEvents = capturedEvents.filter((e): e is SessionCompactEvent => e.type === "session_compact");
		expect(compactEvents.length).toBe(1);
		expect(compactEvents[0].fromExtension).toBe(false);
	}, 120000);

	it("should call multiple extensions in order", async () => {
		const callOrder: string[] = [];

		const extension1: Extension = {
			path: "extension1",
			resolvedPath: "/test/extension1.ts",
			sourceInfo: createSyntheticSourceInfo("<test:extension1>", { source: "test" }),
			handlers: new Map<string, ((event: any, ctx: any) => Promise<any>)[]>([
				[
					"session_before_compact",
					[
						async () => {
							callOrder.push("extension1-before");
							return undefined;
						},
					],
				],
				[
					"session_compact",
					[
						async () => {
							callOrder.push("extension1-after");
							return undefined;
						},
					],
				],
			]),
			tools: new Map(),
			messageRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		};

		const extension2: Extension = {
			path: "extension2",
			resolvedPath: "/test/extension2.ts",
			sourceInfo: createSyntheticSourceInfo("<test:extension2>", { source: "test" }),
			handlers: new Map<string, ((event: any, ctx: any) => Promise<any>)[]>([
				[
					"session_before_compact",
					[
						async () => {
							callOrder.push("extension2-before");
							return undefined;
						},
					],
				],
				[
					"session_compact",
					[
						async () => {
							callOrder.push("extension2-after");
							return undefined;
						},
					],
				],
			]),
			tools: new Map(),
			messageRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		};

		createSession([extension1, extension2]);

		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.compact();

		expect(callOrder).toEqual(["extension1-before", "extension2-before", "extension1-after", "extension2-after"]);
	}, 120000);

	it("should pass correct data in before_compact event", async () => {
		let capturedBeforeEvent: SessionBeforeCompactEvent | null = null;

		const extension = createExtension((event) => {
			capturedBeforeEvent = event;
			return undefined;
		});
		createSession([extension]);

		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.prompt("What is 3+3? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.compact();

		expect(capturedBeforeEvent).not.toBeNull();
		const event = capturedBeforeEvent!;
		expect(typeof event.preparation.isSplitTurn).toBe("boolean");
		expect(event.preparation.firstKeptEntryId).toBeDefined();

		expect(Array.isArray(event.preparation.messagesToSummarize)).toBe(true);
		expect(Array.isArray(event.preparation.turnPrefixMessages)).toBe(true);

		expect(typeof event.preparation.tokensBefore).toBe("number");

		expect(Array.isArray(event.branchEntries)).toBe(true);

		// sessionManager, modelRegistry, and model are now on ctx, not event
		// Verify they're accessible via session
		expect(typeof session.sessionManager.getEntries).toBe("function");
		expect(typeof session.modelRegistry.getApiKeyAndHeaders).toBe("function");

		const entries = session.sessionManager.getEntries();
		expect(Array.isArray(entries)).toBe(true);
		expect(entries.length).toBeGreaterThan(0);
	}, 120000);

	it("should use extension compaction even with different values", async () => {
		const customSummary = "Custom summary with modified values";

		const extension = createExtension((event) => {
			if (event.type === "session_before_compact") {
				return {
					compaction: {
						summary: customSummary,
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: 999,
					},
				};
			}
			return undefined;
		});
		createSession([extension]);

		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		const result = await session.compact();

		expect(result.summary).toBe(customSummary);
		expect(result.tokensBefore).toBe(999);
	}, 120000);
});

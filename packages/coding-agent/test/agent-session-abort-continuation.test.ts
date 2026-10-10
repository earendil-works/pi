/**
 * Tests for extension abort with same-run continuation (ctx.abort(continuation)).
 *
 * Contract under test:
 * - plain ctx.abort() behaves exactly as before (partial kept, run settles aborted);
 * - ctx.abort(continuation) resumes the same run after the aborted request settles:
 *   optional discarded partial, injected reminder, follow-up queues drain normally;
 * - overlapping duplicate aborts coalesce (discard wins, identical reminders dedupe);
 * - budget maxAutoContinuations guards the loop; 0 disables;
 * - a plain abort is a user interrupt and drops the armed continuation;
 * - a failed continuation request settles like an error turn without re-continuing.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	type AbortContinuation,
	createExtensionRuntime,
	type Extension,
	type ExtensionContext,
	type MessageUpdateEvent,
	type TurnStartEvent,
} from "../src/core/extensions/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const TRIGGER = "TRIGGER";
const ABORTED_TEXT = `assistant ${TRIGGER} partial`;

function createAssistantMessage(text: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

function messageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function assistantMessages(session: AgentSession): AssistantMessage[] {
	return session.agent.state.messages.filter((message): message is AssistantMessage => message.role === "assistant");
}

function userTexts(session: AgentSession): string[] {
	return session.agent.state.messages
		.filter((message) => message.role === "user")
		.map((message) => messageText(message));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** "plain" makes the extension call ctx.abort() without a continuation. */
type AbortSpec = AbortContinuation | "plain";

interface SessionHarness {
	session: AgentSession;
	getCallCount: () => number;
	getFires: () => number;
	turnStarts: TurnStartEvent[];
	settledEvents: Array<{ aborted: boolean }>;
	openGate: () => void;
}

describe("AgentSession abort continuation", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `pi-abort-continuation-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	async function createSession(options?: {
		extensionSpecs?: AbortSpec[];
		alwaysFire?: boolean;
		hangFirst?: boolean;
		failContinuation?: boolean;
		resumedText?: string;
		maxAutoContinuations?: number;
	}): Promise<SessionHarness> {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		let callCount = 0;
		const turnStarts: TurnStartEvent[] = [];
		const settledEvents: Array<{ aborted: boolean }> = [];
		const specs: AbortSpec[] = options?.extensionSpecs ?? [{ reminder: "REMINDER", reason: "test-rule" }];
		const fireCounts = specs.map(() => 0);

		let gateResolve: (() => void) | undefined;
		const gatePromise = new Promise<void>((resolve) => {
			gateResolve = resolve;
		});

		// One extension per spec: duplicates from different extensions firing on the same in-flight
		// event exercise the coalescing path.
		const extensions: Extension[] = specs.map((spec, specIndex) => {
			const handlers = new Map<string, ((...args: unknown[]) => Promise<unknown>)[]>();
			handlers.set("message_update", [
				async (...args: unknown[]) => {
					const [event, ctx] = args as [MessageUpdateEvent, ExtensionContext];
					if (event.message.role !== "assistant") return;
					if (!messageText(event.message).includes(TRIGGER)) return;
					if (!options?.alwaysFire && fireCounts[specIndex] > 0) return;
					fireCounts[specIndex]++;
					if (spec === "plain") {
						ctx.abort();
						return;
					}
					const continuation: AbortContinuation = {
						reminder: spec.reminder ?? "REMINDER",
						reason: spec.reason ?? "test-rule",
					};
					if (spec.contextMode) continuation.contextMode = spec.contextMode;
					ctx.abort(continuation);
				},
			]);
			if (specIndex === 0) {
				handlers.set("turn_start", [
					async (...args: unknown[]) => {
						turnStarts.push(args[0] as TurnStartEvent);
					},
				]);
			}
			return {
				path: `test-abort-continuation-${specIndex}`,
				resolvedPath: `/test/test-abort-continuation-${specIndex}.ts`,
				sourceInfo: createSyntheticSourceInfo(`<test:test-abort-continuation-${specIndex}>`, { source: "test" }),
				handlers,
				tools: new Map(),
				messageRenderers: new Map(),
				commands: new Map(),
				flags: new Map(),
				shortcuts: new Map(),
			} satisfies Extension;
		});

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				callCount++;
				const index = callCount;
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					if (index === 1) {
						const msg = createAssistantMessage(ABORTED_TEXT, { stopReason: "aborted" });
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "text_delta", contentIndex: 0, delta: ABORTED_TEXT, partial: msg });
						const finish = () => stream.push({ type: "error", reason: "aborted", error: msg });
						if (options?.hangFirst) void gatePromise.then(finish);
						else finish();
					} else if (options?.failContinuation && index === 2) {
						const msg = createAssistantMessage("", { stopReason: "error", errorMessage: "boom" });
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
					} else {
						const msg = createAssistantMessage(options?.resumedText ?? "resumed");
						stream.push({ type: "start", partial: msg });
						stream.push({
							type: "text_delta",
							contentIndex: 0,
							delta: options?.resumedText ?? "resumed",
							partial: msg,
						});
						stream.push({ type: "done", reason: "stop", message: msg });
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		if (options?.maxAutoContinuations !== undefined) {
			settingsManager.applyOverrides({ maxAutoContinuations: options.maxAutoContinuations });
		}

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
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader,
		});
		session.subscribe((event) => {
			if (event.type === "agent_settled") settledEvents.push({ aborted: event.aborted });
		});

		return {
			session,
			getCallCount: () => callCount,
			getFires: () => fireCounts.reduce((sum, count) => sum + count, 0),
			turnStarts,
			settledEvents,
			openGate: () => gateResolve?.(),
		};
	}

	it("plain ctx.abort() keeps today's behavior: partial kept, run settles aborted", async () => {
		const harness = await createSession({ extensionSpecs: ["plain"] });
		await harness.session.prompt("go");

		expect(harness.getCallCount()).toBe(1);
		expect(harness.settledEvents).toEqual([{ aborted: true }]);
		expect(harness.turnStarts.every((event) => event.continuation === undefined)).toBe(true);
		const aborted = assistantMessages(harness.session).find((message) => message.stopReason === "aborted");
		expect(aborted && messageText(aborted)).toBe(ABORTED_TEXT);
		expect(userTexts(harness.session)).not.toContain("REMINDER");
	});

	it("keep-mode: partial retained, reminder injected, same run resumes", async () => {
		const harness = await createSession({ resumedText: "polite" });
		await harness.session.prompt("go");

		expect(harness.getCallCount()).toBe(2);
		expect(harness.settledEvents).toEqual([{ aborted: false }]);
		const aborted = assistantMessages(harness.session).find((message) => message.stopReason === "aborted");
		expect(aborted && messageText(aborted)).toBe(ABORTED_TEXT);
		expect(userTexts(harness.session)).toContain("REMINDER");
		expect(harness.turnStarts.some((event) => event.continuation?.attempt === 1)).toBe(true);
		const marker = harness.turnStarts.find((event) => event.continuation)?.continuation;
		expect(marker).toEqual({ attempt: 1, droppedPartial: false, reason: "test-rule" });
	});

	it("queued follow-up drains in the same run after a continuation", async () => {
		const harness = await createSession({ hangFirst: true, resumedText: "polite" });
		const promptPromise = harness.session.prompt("go");
		await waitFor(() => harness.getFires() > 0);
		await harness.session.sendUserMessage("follow-up please", { deliverAs: "followUp" });
		harness.openGate();
		await promptPromise;

		expect(harness.getCallCount()).toBe(3);
		expect(harness.settledEvents).toEqual([{ aborted: false }]);
		expect(userTexts(harness.session)).toContain("follow-up please");
	});

	it("discard-mode: aborted partial dropped, session entries round-trip", async () => {
		const harness = await createSession({
			extensionSpecs: [{ reminder: "REDO", contextMode: "discard", reason: "rule" }],
			resumedText: "redone",
		});
		await harness.session.prompt("go");

		expect(harness.getCallCount()).toBe(2);
		expect(harness.settledEvents).toEqual([{ aborted: false }]);
		const stateTexts = harness.session.agent.state.messages.map((message) => messageText(message));
		expect(stateTexts).not.toContain(ABORTED_TEXT);
		expect(userTexts(harness.session)).toContain("REDO");

		const branch = harness.session.sessionManager.getBranch();
		const edits = branch.filter((entry) => entry.type === "context_edit");
		expect(edits.length).toBeGreaterThanOrEqual(1);
		const projection = harness.session.sessionManager.buildSessionProjection();
		expect(projection.messages.map((message) => messageText(message))).not.toContain(ABORTED_TEXT);
		expect(projection.messages.map((message) => messageText(message))).toContain("REDO");

		const marker = harness.turnStarts.find((event) => event.continuation)?.continuation;
		expect(marker?.droppedPartial).toBe(true);
	});

	it("overlapping duplicate aborts coalesce into one continuation with merged reminders", async () => {
		const harness = await createSession({
			extensionSpecs: [
				{ reminder: "REM-A", contextMode: "keep", reason: "rule-a" },
				{ reminder: "REM-B", contextMode: "discard", reason: "rule-b" },
			],
		});
		await harness.session.prompt("go");

		expect(harness.getCallCount()).toBe(2);
		expect(harness.settledEvents).toEqual([{ aborted: false }]);
		const texts = userTexts(harness.session);
		expect(texts).toContain("REM-A");
		expect(texts).toContain("REM-B");
		const marker = harness.turnStarts.find((event) => event.continuation)?.continuation;
		expect(marker?.attempt).toBe(1);
		// discard from the second abort wins as the stronger intent
		expect(marker?.droppedPartial).toBe(true);
	});

	it("identical reminders from duplicate aborts are injected once", async () => {
		const harness = await createSession({
			extensionSpecs: [
				{ reminder: "SAME", reason: "r1" },
				{ reminder: "SAME", reason: "r2" },
			],
		});
		await harness.session.prompt("go");

		expect(harness.getCallCount()).toBe(2);
		expect(userTexts(harness.session).filter((text) => text === "SAME")).toHaveLength(1);
	});

	it("budget exhaustion settles like a plain abort and appends a notice", async () => {
		const harness = await createSession({
			alwaysFire: true,
			resumedText: `${TRIGGER} again`,
			maxAutoContinuations: 1,
		});
		await harness.session.prompt("go");

		expect(harness.getCallCount()).toBe(2);
		expect(harness.settledEvents).toEqual([{ aborted: true }]);
		const branch = harness.session.sessionManager.getBranch();
		const notice = branch.find(
			(entry) => entry.type === "custom_message" && entry.customType === "continuation_budget_exhausted",
		);
		expect(notice).toBeDefined();
	});

	it("maxAutoContinuations: 0 disables continuation entirely", async () => {
		const harness = await createSession({ maxAutoContinuations: 0 });
		await harness.session.prompt("go");

		expect(harness.getCallCount()).toBe(1);
		expect(harness.settledEvents).toEqual([{ aborted: true }]);
		expect(userTexts(harness.session)).not.toContain("REMINDER");
	});

	it("a plain abort during the continuation window wins and drops the intent", async () => {
		const harness = await createSession({ hangFirst: true });
		const promptPromise = harness.session.prompt("go");
		await waitFor(() => harness.getFires() > 0);
		void harness.session.abort();
		harness.openGate();
		await promptPromise;

		expect(harness.getCallCount()).toBe(1);
		expect(harness.settledEvents).toEqual([{ aborted: true }]);
		expect(harness.turnStarts.every((event) => event.continuation === undefined)).toBe(true);
		expect(userTexts(harness.session)).not.toContain("REMINDER");
	});

	it("failed continuation request settles like an error turn without re-continuing", async () => {
		const harness = await createSession({ failContinuation: true });
		await harness.session.prompt("go");

		expect(harness.getCallCount()).toBe(2);
		expect(harness.settledEvents).toEqual([{ aborted: false }]);
		const last = assistantMessages(harness.session).at(-1);
		expect(last?.stopReason).toBe("error");
		expect(last?.errorMessage).toBe("boom");
		const branch = harness.session.sessionManager.getBranch();
		expect(
			branch.some(
				(entry) => entry.type === "custom_message" && entry.customType === "continuation_budget_exhausted",
			),
		).toBe(false);
	});
});

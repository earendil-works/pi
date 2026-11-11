import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	type TranscriptContext,
	type UserMessage,
} from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { raceWithAbortSignal } from "../../src/utils/abort.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "./harness.ts";

const harnesses: Harness[] = [];
const directories: string[] = [];
const settings = { compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" as const };

async function fixture(options: HarnessOptions = {}) {
	const directory = mkdtempSync(join(tmpdir(), "pi-recovery-"));
	directories.push(directory);
	const sessionManager = options.sessionManager ?? SessionManager.create(directory, join(directory, "sessions"));
	const harness = await createHarness({
		settings,
		...options,
		sessionManager,
		agentDir: options.agentDir ?? directory,
	});
	harnesses.push(harness);
	return { directory, harness, sessionManager };
}

afterEach(async () => {
	for (const harness of harnesses.splice(0).reverse()) {
		await harness.session.abort();
		harness.cleanup();
	}
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function call(name: string, id = name) {
	return { type: "toolCall" as const, id, name, arguments: {} };
}

async function interruptedParallelRun() {
	const started = Promise.withResolvers<void>();
	const completed = Promise.withResolvers<void>();
	const blocked = Promise.withResolvers<void>();
	const directory = mkdtempSync(join(tmpdir(), "pi-recovery-effects-"));
	directories.push(directory);
	const effects = join(directory, "effects.txt");
	const tools: AgentTool[] = ["fast", "slow"].map((name) => ({
		name,
		label: name,
		description: `Write ${name} evidence`,
		parameters: Type.Object({}),
		async execute(_id, _args, signal) {
			appendFileSync(effects, `${name}\n`);
			if (name === "slow") {
				started.resolve();
				await raceWithAbortSignal(blocked.promise, signal);
			}
			return { content: [{ type: "text", text: `${name} evidence saved` }], details: {} };
		},
	}));
	const { harness, sessionManager } = await fixture({ agentDir: directory, tools });
	harness.setResponses([fauxAssistantMessage([call("fast"), call("slow")], { stopReason: "toolUse" })]);
	harness.session.subscribe((event) => {
		if (event.type === "tool_execution_end" && event.toolName === "fast") completed.resolve();
	});
	const running = harness.session.prompt("Save both pieces of evidence once");
	await Promise.all([started.promise, completed.promise]);
	await harness.session.followUp("Keep the original audit scope");
	const path = sessionManager.getSessionFile()!;
	const checkpoint = harness.session.recovery.checkpointPath!;
	const log = readFileSync(path, "utf8");
	const saved = readFileSync(checkpoint, "utf8");
	expect(
		sessionManager.getBranch().some((entry) => entry.type === "message" && entry.message.role === "toolResult"),
	).toBe(false);
	await harness.session.abort();
	await running;
	harness.session.dispose();
	// Restore the exact durable crash window, before parallel batching committed either result.
	writeFileSync(path, log);
	writeFileSync(checkpoint, saved);
	const reopened = await fixture({ sessionManager: SessionManager.open(path), agentDir: directory, tools });
	return { ...reopened, effects, checkpoint, path, directory };
}

describe("session execution recovery", () => {
	it("finishes the current response, parks its tool calls, and continues without another prompt", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let signal: AbortSignal | undefined;
		const { harness, directory } = await fixture();
		const file = join(directory, "result.txt");
		harness.setResponses([
			async (_context, options) => {
				signal = options?.signal;
				started.resolve();
				await raceWithAbortSignal(release.promise, options?.signal);
				return fauxAssistantMessage(
					{ type: "toolCall", id: "write-once", name: "write", arguments: { path: file, content: "saved once" } },
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("File saved"),
		]);
		const running = harness.session.prompt("Save the result");
		await started.promise;
		const paused = harness.session.recovery.pause();
		expect(signal?.aborted).toBe(false);
		release.resolve();
		await paused;
		expect(existsSync(file)).toBe(false);
		expect(harness.faux.state.callCount).toBe(1);
		harness.session.recovery.resume();
		await running;
		expect(readFileSync(file, "utf8")).toBe("saved once");
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.messages.filter((message) => message.role === "user").map(getMessageText)).toEqual([
			"Save the result",
		]);
	});

	it("lets an admitted tool finish its nested work before pausing the next model request", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let file = "";
		const { harness, directory } = await fixture({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "save_nested",
						label: "Save nested",
						description: "Save through the normal nested tool pipeline",
						parameters: Type.Object({}),
						async execute(_id, _args, signal, _update, ctx) {
							started.resolve();
							await raceWithAbortSignal(release.promise, signal);
							const outcome = await ctx.executeTool("write", { path: file, content: "nested evidence" });
							if (outcome.isError) throw new Error(getMessageText(outcome.result));
							return outcome.result;
						},
					});
				},
			],
		});
		file = join(directory, "nested.txt");
		harness.setResponses([
			fauxAssistantMessage(call("save_nested"), { stopReason: "toolUse" }),
			fauxAssistantMessage("Nested file saved"),
		]);
		const running = harness.session.prompt("Save through the parent tool");
		await started.promise;
		const paused = harness.session.recovery.pause();
		release.resolve();
		await paused;
		expect(readFileSync(file, "utf8")).toBe("nested evidence");
		expect(harness.faux.state.callCount).toBe(1);
		harness.session.recovery.resume();
		await running;
		const result = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "save_nested",
		);
		expect(result?.role === "toolResult" && result.nestedCalls?.calls[0]?.name).toBe("write");
	});

	it("restores completed parallel results, marks unknown effects honestly, and delivers queued input once", async () => {
		const { harness, effects } = await interruptedParallelRun();
		expect(harness.session.recovery.info().tools.map(({ name, outcome }) => ({ name, outcome }))).toEqual([
			{ name: "fast", outcome: "completed" },
			{ name: "slow", outcome: "unknown" },
		]);
		await expect(harness.session.prompt("Do not bypass recovery")).rejects.toThrow("needs review");
		expect(harness.faux.state.callCount).toBe(0);
		await harness.session.sendCustomMessage(
			{ customType: "late-child-result", content: "Late bounded child evidence", display: true },
			{ triggerTurn: false },
		);
		let context: TranscriptContext | undefined;
		harness.setResponses(
			Array.from({ length: 2 }, () => (value: TranscriptContext) => {
				context = value;
				return fauxAssistantMessage("Recovered evidence inspected; no operations repeated");
			}),
		);
		await harness.session.recovery.recover();
		const results = context!.messages.filter((message) => message.role === "toolResult");
		expect(results.map((result) => [result.toolName, result.isError, getMessageText(result)])).toEqual([
			["fast", false, "fast evidence saved"],
			["slow", true, expect.stringContaining("outcome is unknown")],
		]);
		expect(harness.session.messages.filter((message) => message.role === "user").map(getMessageText)).toEqual([
			"Save both pieces of evidence once",
			"Keep the original audit scope",
		]);
		expect(readFileSync(effects, "utf8").split("\n").filter(Boolean).sort()).toEqual(["fast", "slow"]);
		const late = harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === "late-child-result",
		);
		expect(late.map(getMessageText)).toEqual(["Late bounded child evidence"]);
		expect(harness.session.messages.indexOf(late[0])).toBeGreaterThan(
			harness.session.messages.findLastIndex((message) => message.role === "toolResult"),
		);
		expect(harness.session.recovery.needsRecovery).toBe(false);
	});

	it("discards pending work without erasing completed evidence or executing a recovery request", async () => {
		const { harness, effects, sessionManager } = await interruptedParallelRun();
		await harness.session.sendCustomMessage(
			{ customType: "aside", content: "ABANDONED_QUEUED_INPUT", display: false },
			{ deliverAs: "nextTurn" },
		);
		await harness.session.recovery.discard();
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.session.recovery.needsRecovery).toBe(false);
		expect(harness.session.messages.filter((message) => message.role === "toolResult").map(getMessageText)).toEqual([
			"fast evidence saved",
			expect.stringContaining("outcome is unknown"),
		]);
		expect(JSON.stringify(sessionManager.getEntries())).not.toContain("Keep the original audit scope");
		expect(readFileSync(effects, "utf8").split("\n").filter(Boolean).sort()).toEqual(["fast", "slow"]);
		harness.setResponses([fauxAssistantMessage("New user-directed task")]);
		await harness.session.prompt("Start a different task");
		expect(harness.faux.state.callCount).toBe(1);
		expect(JSON.stringify(harness.session.messages)).not.toContain("ABANDONED_QUEUED_INPUT");
	});

	it("deduplicates an already committed queued entry by ID, not by identical text", async () => {
		const { harness, directory, sessionManager } = await fixture();
		const started = Promise.withResolvers<void>();
		const blocked = Promise.withResolvers<void>();
		harness.setResponses([
			async (_context, options) => {
				started.resolve();
				await raceWithAbortSignal(blocked.promise, options?.signal);
				return fauxAssistantMessage("Interrupted response");
			},
		]);
		const run = harness.session.prompt("Original task");
		await started.promise;
		await harness.session.followUp("Same instruction");
		await harness.session.followUp("Same instruction");
		const checkpoint = harness.session.recovery.checkpointPath!;
		const saved = readFileSync(checkpoint, "utf8");
		const { inputs } = JSON.parse(saved) as { inputs: { id: string; message: UserMessage }[] };
		await harness.session.abort();
		await run;
		harness.session.dispose();
		// Simulate persistence succeeding just before removal of the queue receipt.
		sessionManager.appendMessage(inputs[0].message, inputs[0].id);
		writeFileSync(checkpoint, saved);
		const reopened = await fixture({
			sessionManager: SessionManager.open(sessionManager.getSessionFile()!),
			agentDir: directory,
		});
		reopened.harness.setResponses(
			Array.from({ length: 2 }, () => fauxAssistantMessage("Both intentional instructions retained")),
		);
		await reopened.harness.session.recovery.recover();
		const texts = reopened.harness.session.messages.filter((message) => message.role === "user").map(getMessageText);
		expect(texts).toEqual(["Original task", "Same instruction", "Same instruction"]);
	});

	it("rejects a second execution owner and rejects its stale checkpoint after the first owner leaves", async () => {
		const { harness, directory, sessionManager } = await fixture();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		harness.setResponses([
			async (_context, options) => {
				started.resolve();
				await raceWithAbortSignal(release.promise, options?.signal);
				return fauxAssistantMessage("First owner's durable answer");
			},
		]);
		const running = harness.session.prompt("Own this execution");
		await started.promise;
		const alias = join(directory, "same-session.jsonl");
		symlinkSync(sessionManager.getSessionFile()!, alias);
		const other = await fixture({ sessionManager: SessionManager.open(alias), agentDir: directory });
		await expect(other.harness.session.recovery.recover()).rejects.toThrow("execution owner");
		release.resolve();
		await running;
		harness.session.dispose();
		await expect(other.harness.session.recovery.recover()).rejects.toThrow("Reopen the session");
		expect(other.harness.faux.state.callCount).toBe(0);
		expect(readFileSync(sessionManager.getSessionFile()!, "utf8")).toContain("First owner's durable answer");
	});

	it("keeps an accepted first prompt discoverable if preparation is interrupted before the first model request", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { harness, directory, sessionManager } = await fixture({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						entered.resolve();
						await release.promise;
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("Original process finished after the snapshot")]);
		const run = harness.session.prompt("Keep this first goal across preparation");
		await entered.promise;
		const file = sessionManager.getSessionFile()!;
		const checkpoint = harness.session.recovery.checkpointPath!;
		const log = readFileSync(file, "utf8");
		const saved = readFileSync(checkpoint, "utf8");
		expect(
			(await SessionManager.list(sessionManager.getCwd(), sessionManager.getSessionDir())).map(
				(session) => session.id,
			),
		).toContain(sessionManager.getSessionId());
		release.resolve();
		await run;
		harness.session.dispose();
		writeFileSync(file, log);
		writeFileSync(checkpoint, saved);
		const reopened = await fixture({ sessionManager: SessionManager.open(file), agentDir: directory });
		reopened.harness.setResponses([fauxAssistantMessage("First goal restored")]);
		await reopened.harness.session.recovery.recover();
		expect(
			reopened.harness.session.messages.filter((message) => message.role === "user").map(getMessageText),
		).toEqual(["Keep this first goal across preparation"]);
	});

	it("holds automatic overflow summarization behind pause instead of starting a new helper request", async () => {
		const { harness, sessionManager } = await fixture({
			settings: {
				...settings,
				compaction: { enabled: true, prepareThreshold: 98, threshold: 99, keepRecentTokens: 64 },
			},
		});
		sessionManager.appendMessage({ role: "user", content: "Older requirements. ".repeat(1000), timestamp: 1 });
		sessionManager.appendMessage(fauxAssistantMessage("Older implementation evidence. ".repeat(1000)));
		harness.session.refreshContext();
		const entered = Promise.withResolvers<void>();
		let pausing: Promise<void> | undefined;
		harness.session.subscribe((event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.stopReason === "error"
			) {
				pausing = harness.session.recovery.pause();
				entered.resolve();
			}
		});
		harness.session.agent.sessionId = sessionManager.getSessionId();
		let mainRequests = 0;
		harness.setResponses(
			Array.from({ length: 8 }, () => (_context: TranscriptContext, options: Parameters<FauxResponseFactory>[1]) => {
				if (options?.sessionId !== sessionManager.getSessionId())
					return fauxAssistantMessage("Summary preserving the prior requirements and implementation evidence.");
				return ++mainRequests === 1
					? fauxAssistantMessage("", { stopReason: "error", errorMessage: "maximum context length exceeded" })
					: fauxAssistantMessage("Continued after overflow compaction");
			}),
		);
		const running = harness.session.prompt("Continue the existing implementation");
		await entered.promise;
		await pausing;
		expect(harness.faux.state.callCount).toBe(1);
		harness.session.recovery.resume();
		await running;
		expect(mainRequests).toBe(2);
		expect(getMessageText(harness.session.messages.at(-1))).toBe("Continued after overflow compaction");
	});
});

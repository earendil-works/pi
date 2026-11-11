import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { discoverAgentDefinitions } from "../../src/core/subagents/definitions.ts";
import { SubagentManager } from "../../src/core/subagents/manager.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "./harness.ts";

const fixtures: Array<{ directory: string; harness: Harness; managers: SubagentManager[] }> = [];

async function fixture(options: HarnessOptions = {}, storage: "disk" | "memory" = "disk") {
	const directory = mkdtempSync(join(tmpdir(), "pi-subagent-manager-"));
	const parent =
		storage === "disk"
			? SessionManager.create(directory, join(directory, "sessions"))
			: SessionManager.inMemory(directory);
	parent.appendMessage({ role: "user", content: "Parent-only private requirement", timestamp: 1 });
	parent.appendMessage(fauxAssistantMessage("Parent response"));
	const harness = await createHarness({
		...options,
		sessionManager: parent,
		settings: { compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off", ...options.settings },
	});
	let labelResponse: FauxResponseFactory = () => fauxAssistantMessage("Inspect delegated task");
	const setResponses = harness.setResponses;
	harness.setResponses = (responses) => {
		const pending = [...responses];
		const dispatch: FauxResponseFactory = async (context, options, state, model) => {
			if (options?.sessionId?.startsWith("label:")) return labelResponse(context, options, state, model);
			const response = pending.shift();
			if (!response) throw new Error("No queued task response");
			return typeof response === "function" ? response(context, options, state, model) : response;
		};
		setResponses(Array.from({ length: 128 }, () => dispatch));
	};
	const managers: SubagentManager[] = [];
	const createManager = () => {
		const manager = new SubagentManager({
			parent,
			cwd: harness.tempDir,
			agentDir: directory,
			modelRuntime: harness.session.modelRuntime,
			getSettings: () => harness.settingsManager.getSettings(),
			getModel: () => harness.session.model,
			getThinkingLevel: () => harness.session.agent.state.thinkingLevel,
			getAllowedTools: () => ["read", "grep", "find", "ls"],
			getSystemPrompt: () => harness.session.agent.state.systemPrompt,
		});
		managers.push(manager);
		return manager;
	};
	const manager = createManager();
	const role = discoverAgentDefinitions(harness.tempDir, directory).agents.find((agent) => agent.name === "worker")!;
	fixtures.push({ directory, harness, managers });
	return {
		directory,
		parent,
		harness,
		manager,
		createManager,
		role,
		setLabelResponse: (response: FauxResponseFactory) => {
			labelResponse = response;
		},
	};
}

afterEach(async () => {
	for (const { directory, harness, managers } of fixtures.splice(0)) {
		await Promise.all(managers.map((manager) => manager.close()));
		await harness.session.abort();
		harness.cleanup();
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("isolated sub-agent sessions", () => {
	it("persists and resumes only the child's history without changing or listing it as the parent", async () => {
		const { parent, harness, manager, createManager, role } = await fixture();
		const before = readFileSync(parent.getSessionFile()!, "utf8");
		harness.setResponses([fauxAssistantMessage("Child-only exact evidence")]);
		const child = manager.start(role, "Investigate the delegated topic");
		const completed = await manager.wait(child.id);
		expect(completed.agent.status, completed.agent.error).toBe("completed");
		expect(readFileSync(completed.agent.historyPath!, "utf8")).toContain("Child-only exact evidence");
		expect(readFileSync(parent.getSessionFile()!, "utf8")).toBe(before);
		expect((await SessionManager.list(parent.getCwd(), parent.getSessionDir())).map((session) => session.id)).toEqual(
			[parent.getSessionId()],
		);
		await manager.close();
		const resumed = createManager();
		harness.setResponses([
			(context) => {
				expect(JSON.stringify(context)).toContain("Child-only exact evidence");
				expect(JSON.stringify(context)).not.toContain("Parent-only private requirement");
				return fauxAssistantMessage("Resumed child findings");
			},
		]);
		resumed.resume(child.id, "Continue from your previous evidence");
		expect((await resumed.wait(child.id)).text).toBe("Resumed child findings");
		expect(readFileSync(parent.getSessionFile()!, "utf8")).toBe(before);
	});

	it("queues excess work at the configured limit and starts it only after a slot is released", async () => {
		const { harness, manager, role } = await fixture({ settings: { subagents: { maxConcurrent: 2 } } });
		const gates = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
		const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		harness.setResponses(
			gates.map((gate, index) => async (_context, options) => {
				started[index].resolve();
				options?.signal?.addEventListener("abort", () => gate.resolve(), { once: true });
				await gate.promise;
				return fauxAssistantMessage(`Finished task ${index}`);
			}),
		);
		const children = gates.map((_, index) => manager.start(role, `Task ${index}`));
		await Promise.all([started[0].promise, started[1].promise]);
		expect(children.map((child) => manager.inspect(child.id).status)).toEqual(["running", "running", "queued"]);
		gates[0].resolve();
		await started[2].promise;
		expect((await manager.wait(children[0].id)).text).toBe("Finished task 0");
		expect(manager.inspect(children[2].id).status).toBe("running");
		gates[1].resolve();
		gates[2].resolve();
		await Promise.all(children.map((child) => manager.wait(child.id)));
	});

	it("preserves the original task when a cancelled queued child is resumed after restart", async () => {
		const { harness, manager, createManager, role } = await fixture({
			settings: { subagents: { maxConcurrent: 1 } },
		});
		const running = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		harness.setResponses([
			async (_context, options) => {
				running.resolve();
				options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
				await release.promise;
				return fauxAssistantMessage("Stopped first task");
			},
		]);
		manager.start(role, "Occupy the first slot");
		await running.promise;
		const queued = manager.start(role, "Original queued goal: inspect the parser boundary");
		expect((await manager.cancel(queued.id)).status).toBe("stopped");
		await manager.close();
		const resumed = createManager();
		harness.setResponses([
			(context) => {
				expect(JSON.stringify(context)).toContain("Original queued goal: inspect the parser boundary");
				expect(JSON.stringify(context)).toContain("Continue with the security implications");
				return fauxAssistantMessage("The original goal and continuation were retained");
			},
		]);
		resumed.resume(queued.id, "Continue with the security implications");
		expect((await resumed.wait(queued.id)).agent.status).toBe("completed");
	});

	it("prevents two managers from writing one live child and drains cancellation before allowing resume", async () => {
		const { harness, manager, createManager, role } = await fixture();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		harness.setResponses([
			async (_context, options) => {
				started.resolve();
				options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
				await release.promise;
				return fauxAssistantMessage("Cancelled response");
			},
		]);
		const child = manager.start(role, "Own this child's log");
		await started.promise;
		const other = createManager();
		const before = readFileSync(child.historyPath!, "utf8");
		expect(() => other.resume(child.id, "Conflicting continuation")).toThrow();
		expect(() => other.remove(child.id)).toThrow();
		expect(readFileSync(child.historyPath!, "utf8")).toBe(before);
		expect((await manager.cancel(child.id)).status).toBe("stopped");
		harness.setResponses([fauxAssistantMessage("Exclusive resumed response")]);
		other.resume(child.id, "Resume after the old writer stopped");
		expect((await other.wait(child.id)).text).toBe("Exclusive resumed response");
	});

	it("does not return an earlier successful answer as the result of a failed continuation", async () => {
		const { harness, manager, role } = await fixture();
		harness.setResponses([fauxAssistantMessage("Previous successful answer")]);
		const child = manager.start(role, "Initial task");
		await manager.wait(child.id);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Deliberate continuation failure" }),
		]);
		manager.resume(child.id, "A continuation that fails");
		const result = await manager.wait(child.id);
		expect(result.agent.status).toBe("failed");
		expect(result.agent.error).toContain("Deliberate continuation failure");
		expect(manager.history(child.id).text).toContain("Deliberate continuation failure");
		expect(result.text).not.toContain("Previous successful answer");
	});

	it("keeps waiters bound to their run even if a completion listener immediately resumes the child", async () => {
		const { harness, manager, role } = await fixture();
		harness.setResponses([fauxAssistantMessage("First run answer"), fauxAssistantMessage("Second run answer")]);
		const child = manager.start(role, "First task");
		const first = manager.wait(child.id);
		const unsubscribe = manager.subscribe((event) => {
			if (event.id === child.id && event.type === "status" && manager.inspect(child.id).status === "completed") {
				unsubscribe();
				manager.resume(child.id, "Second task");
			}
		});
		const result = await first;
		expect(result.agent.run).toBe(1);
		expect(result.text).toBe("First run answer");
		expect((await manager.wait(child.id)).text).toBe("Second run answer");
	});

	it("keeps no-session children entirely in memory while still supporting continuation", async () => {
		const { directory, harness, manager, role } = await fixture({}, "memory");
		harness.setResponses([
			fauxAssistantMessage("Ephemeral evidence"),
			(context) => {
				expect(JSON.stringify(context)).toContain("Ephemeral evidence");
				return fauxAssistantMessage("Ephemeral continuation");
			},
		]);
		const child = manager.start(role, "Ephemeral task");
		await manager.wait(child.id);
		manager.resume(child.id, "Continue in memory");
		expect((await manager.wait(child.id)).text).toBe("Ephemeral continuation");
		expect(child.historyPath).toBeUndefined();
		expect(existsSync(join(directory, "subagents"))).toBe(false);
	});

	it("removes child history without removing or rewriting the parent's history", async () => {
		const { parent, harness, manager, role } = await fixture();
		const before = readFileSync(parent.getSessionFile()!, "utf8");
		harness.setResponses([fauxAssistantMessage("Disposable child answer")]);
		const child = manager.start(role, "A finished child");
		await manager.wait(child.id);
		manager.remove(child.id);
		expect(manager.list()).toEqual([]);
		expect(existsSync(child.historyPath!)).toBe(false);
		expect(readFileSync(parent.getSessionFile()!, "utf8")).toBe(before);
	});
	it("steers a running child without appending the steering exchange to the parent", async () => {
		const { parent, harness, manager, role } = await fixture();
		const before = readFileSync(parent.getSessionFile()!, "utf8");
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		harness.setResponses([
			async (_context, options) => {
				started.resolve();
				options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
				await release.promise;
				return fauxAssistantMessage("Initial partial conclusion");
			},
			(context) => {
				expect(JSON.stringify(context)).toContain("Also inspect the cancellation race");
				return fauxAssistantMessage("Updated conclusion includes cancellation");
			},
		]);
		const child = manager.start(role, "Inspect the initial boundary");
		await started.promise;
		await manager.message(child.id, "Also inspect the cancellation race");
		release.resolve();
		expect((await manager.wait(child.id)).text).toBe("Updated conclusion includes cancellation");
		expect(readFileSync(parent.getSessionFile()!, "utf8")).toBe(before);
	});

	it("does not retain phantom list entries after another owner deletes a finished child", async () => {
		const { harness, manager, createManager, role } = await fixture();
		harness.setResponses([fauxAssistantMessage("Finished child")]);
		const child = manager.start(role, "A completed task");
		await manager.wait(child.id);
		const other = createManager();
		expect(other.inspect(child.id).status).toBe("completed");
		manager.remove(child.id);
		expect(other.list()).toEqual([]);
	});

	it("advances a tiny history page across a complete Unicode character rather than looping at its surrogate", async () => {
		const { harness, manager, role } = await fixture();
		harness.setResponses([fauxAssistantMessage("A\u{1f600}B")]);
		const child = manager.start(role, "Return a Unicode result");
		await manager.wait(child.id);
		const full = manager.history(child.id).text;
		const offset = full.indexOf("\u{1f600}");
		const page = manager.history(child.id, offset, 1);
		expect(page.text).toBe("\u{1f600}");
		expect(page.nextOffset).toBe(offset + 2);
		expect(manager.history(child.id, page.nextOffset, 1).text).toBe("B");
	});

	it("inherits a parent-enabled non-default local tool without gaining write permissions", async () => {
		const { harness, manager, role } = await fixture();
		const file = join(harness.tempDir, "inherited-listing.txt");
		writeFileSync(file, "Unchanged shared-tree contents");
		harness.setResponses([
			fauxAssistantMessage(
				[
					{ type: "toolCall", id: "inherited-list", name: "ls", arguments: { path: "." } },
					{
						type: "toolCall",
						id: "ungranted-write",
						name: "write",
						arguments: { path: "inherited-listing.txt", content: "Overwritten" },
					},
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				const results = context.messages.filter((message) => message.role === "toolResult");
				expect(getMessageText(results.find((message) => message.toolCallId === "inherited-list"))).toContain(
					"inherited-listing.txt",
				);
				expect(results.find((message) => message.toolCallId === "ungranted-write")?.isError).toBe(true);
				return fauxAssistantMessage("The inherited directory tool works without write access");
			},
		]);
		const child = manager.start(role, "List this directory without modifying its files");
		expect((await manager.wait(child.id)).text).toBe("The inherited directory tool works without write access");
		expect(readFileSync(file, "utf8")).toBe("Unchanged shared-tree contents");
	});

	it("notifies history readers after the submitted user message is saved, while the model is still running", async () => {
		const { harness, manager, role } = await fixture();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let observedHistory = "";
		const unsubscribe = manager.subscribe((event) => {
			if (event.type === "message") observedHistory = manager.history(event.id).text;
		});
		harness.setResponses([
			async (_context, options) => {
				started.resolve();
				options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
				await release.promise;
				return fauxAssistantMessage("Stopped history-observability fixture");
			},
		]);
		const child = manager.start(role, "Task visible before the first model response");
		await started.promise;
		await vi.waitFor(() => expect(observedHistory).toContain("Task visible before the first model response"));
		expect(manager.inspect(child.id).status).toBe("running");
		unsubscribe();
		await manager.cancel(child.id);
	});
	it("publishes a terminal-safe title while work runs, without adding title messages to either conversation", async () => {
		const { parent, harness, manager, createManager, role, setLabelResponse } = await fixture();
		const before = readFileSync(parent.getSessionFile()!, "utf8");
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		setLabelResponse((context) => {
			expect(JSON.stringify(context)).not.toContain("Parent-only private requirement");
			return fauxAssistantMessage(
				'\u001b[31m"Audit session write ownership"\u001b[0m\nPrivate discarded title commentary',
			);
		});
		harness.setResponses([
			async (context, options) => {
				expect(JSON.stringify(context)).not.toContain("Audit session write ownership");
				started.resolve();
				options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
				await release.promise;
				return fauxAssistantMessage("The child alone produced this result");
			},
		]);
		const child = manager.start(role, "Investigate how delegated session writes are isolated");
		await started.promise;
		try {
			await vi.waitFor(() => expect(manager.inspect(child.id).label).toBe("Audit session write ownership"));
			expect(manager.inspect(child.id).status).toBe("running");
			expect(manager.history(child.id).text).not.toContain("Audit session write ownership");
			expect(manager.history(child.id).text).not.toContain("Private discarded title commentary");
		} finally {
			release.resolve();
		}
		const result = await manager.wait(child.id);
		expect(result.agent.status, result.agent.error).toBe("completed");
		expect(readFileSync(parent.getSessionFile()!, "utf8")).toBe(before);
		const entries = SessionManager.open(result.agent.historyPath!).getEntries();
		const titleUsage = entries.find((entry) => entry.type === "usage");
		const response = entries.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (titleUsage?.type !== "usage" || response?.type !== "message" || response.message.role !== "assistant")
			throw new Error("Missing independently recorded title or child usage");
		expect(result.agent.usage.output).toBe(titleUsage.usage.output + response.message.usage.output);
		await manager.close();
		const restored = createManager();
		expect(restored.inspect(child.id).label).toBe("Audit session write ownership");
	});

	it("keeps a successful task and its placeholder when the title request fails", async () => {
		const { harness, manager, role, setLabelResponse } = await fixture();
		setLabelResponse(() => ({
			...fauxAssistantMessage(""),
			stopReason: "error",
			errorMessage: "Title provider unavailable",
		}));
		harness.setResponses([fauxAssistantMessage("Delegated work succeeded")]);
		const child = manager.start(role, "Inspect cancellation ownership");
		const result = await manager.wait(child.id);
		expect(result.agent.status, result.agent.error).toBe("completed");
		expect(result.text).toBe("Delegated work succeeded");
		expect(result.agent.label).toBe("Inspect cancellation ownership");
		expect(result.agent.labelError).toBe("Title provider unavailable");
	});

	it("aborts the background title request when the child is stopped and never publishes the cancelled title", async () => {
		const { harness, manager, role, setLabelResponse } = await fixture();
		const titleStarted = Promise.withResolvers<void>();
		const titleAborted = Promise.withResolvers<void>();
		setLabelResponse(async (_context, options) => {
			titleStarted.resolve();
			await new Promise<void>((resolve) => {
				options?.signal?.addEventListener(
					"abort",
					() => {
						titleAborted.resolve();
						resolve();
					},
					{ once: true },
				);
			});
			return fauxAssistantMessage("Cancelled title must stay private");
		});
		harness.setResponses([fauxAssistantMessage("Finished task before the label")]);
		const child = manager.start(role, "Stop a title request");
		await titleStarted.promise;
		await manager.cancel(child.id);
		await titleAborted.promise;
		expect(manager.inspect(child.id).status).toBe("stopped");
		expect(manager.inspect(child.id).label).toBe("Stop a title request");
		expect(manager.inspect(child.id).labelError).toBeUndefined();
	});
});

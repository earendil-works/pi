/**
 * Unit tests for `--mode worker-loop`. Drives `runWorkerLoopMode` with a
 * fake SocketBus and a fake AgentSessionRuntime so the loop's envelope
 * dispatch, heartbeat cadence, idle-TTL exit, and shutdown handling can be
 * asserted without spawning the real bus, network, or model.
 *
 * The fakes mirror only the surface area worker-loop touches:
 *   - bus.drain() / bus.publish()
 *   - runtimeHost.session, runtimeHost.newSession(), runtimeHost.dispose()
 *   - session.subscribe(), session.prompt(), session.abort()
 */
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEventListener } from "../src/core/agent-session.js";
import type { AgentMessage, AgentMessageRecipient, SocketBus } from "../src/modes/worker-loop/socket-bus.js";
import { runWorkerLoopMode, validateWorkerLoopOptions } from "../src/modes/worker-loop/worker-loop-mode.js";

// ----------------------------------------------------------------------------
// Fakes
// ----------------------------------------------------------------------------

interface PublishedEnvelope {
	payload: unknown;
	to: AgentMessageRecipient;
}

class FakeBus implements Pick<SocketBus, "publish" | "drain" | "buildMessage" | "publishWithId"> {
	readonly socketPath = "/dev/null";
	readonly agentId: string;
	readonly agentType: string;
	readonly rpcTimeoutMs = 5_000;
	readonly published: PublishedEnvelope[] = [];
	private inbox: AgentMessage[][] = [];
	private resolveDrain: ((messages: AgentMessage[]) => void) | undefined;

	constructor(agentId: string, agentType: string) {
		this.agentId = agentId;
		this.agentType = agentType;
	}

	enqueue(messages: AgentMessage[]): void {
		if (this.resolveDrain) {
			const r = this.resolveDrain;
			this.resolveDrain = undefined;
			r(messages);
		} else {
			this.inbox.push(messages);
		}
	}

	async drain(): Promise<AgentMessage[]> {
		const next = this.inbox.shift();
		if (next !== undefined) return next;
		return [];
	}

	async publish(payload: unknown, to: AgentMessageRecipient): Promise<void> {
		this.published.push({ payload, to });
	}

	async publishWithId(): Promise<void> {
		// Unused in worker-loop today.
	}

	buildMessage(payload: unknown, to: AgentMessageRecipient, type: AgentMessage["type"] = "status"): AgentMessage {
		return {
			id: `m-${Math.random().toString(36).slice(2)}`,
			from: { agentId: this.agentId, agentType: this.agentType },
			to,
			type,
			payload,
			timestamp: Date.now(),
		};
	}
}

interface FakeSessionEvents {
	/** Emitted as `message_end` events the moment `prompt()` runs. */
	assistantMessages: AssistantMessage[];
}

function makeUsage(input: number, output: number, cacheRead = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function makeAssistantMessage(opts: {
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
	usage?: Usage;
}): AssistantMessage {
	return {
		role: "assistant",
		content: opts.text ? [{ type: "text", text: opts.text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: opts.usage ?? makeUsage(10, 5),
		stopReason: opts.stopReason ?? "stop",
		errorMessage: opts.errorMessage,
		timestamp: Date.now(),
	};
}

interface FakeRuntimeOpts {
	/** Per-prompt response queue. shift()ed each call to `prompt()`. */
	responses: FakeSessionEvents[];
	/** Slow `prompt()` calls — useful for the timeout test. */
	promptDelayMs?: number;
	/** Fail `prompt()` with this error. */
	throwFromPrompt?: Error;
}

function createRuntime(opts: FakeRuntimeOpts) {
	const listeners = new Set<AgentSessionEventListener>();

	const session = {
		model: { provider: "openai", id: "gpt-4o-mini" },
		messages: [] as AssistantMessage[],
		subscribe(listener: AgentSessionEventListener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		prompt: vi.fn(async (_text: string) => {
			if (opts.promptDelayMs) {
				await new Promise((r) => setTimeout(r, opts.promptDelayMs));
			}
			if (opts.throwFromPrompt) throw opts.throwFromPrompt;
			const events = opts.responses.shift();
			if (!events) return;
			for (const msg of events.assistantMessages) {
				for (const l of listeners) {
					l({ type: "message_end", message: msg });
				}
			}
		}),
		abort: vi.fn(async () => {
			// no-op
		}),
	};

	const runtime = {
		session,
		newSession: vi.fn(async () => {
			// Fresh session — clear listeners so per-task subscriptions don't leak.
			listeners.clear();
			return undefined;
		}),
		dispose: vi.fn(async () => {}),
	};

	return { runtime, session, listeners };
}

function buildEnvelope(payload: unknown, agentId: string): AgentMessage {
	return {
		id: `m-${Math.random().toString(36).slice(2)}`,
		from: { agentId: "leader", agentType: "leader" },
		to: { agentId, agentType: "worker" },
		type: "request",
		payload,
		timestamp: Date.now(),
	};
}

const baseOptions = {
	socketPath: "/tmp/fake.sock",
	agentId: "worker-1",
	agentType: "worker",
	projectId: "proj-1",
	repoPath: "/tmp/repo",
	idleTtlMs: 50,
	heartbeatIntervalMs: 20,
	pollIntervalMs: 5,
};

afterEach(() => {
	vi.restoreAllMocks();
});

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe("validateWorkerLoopOptions", () => {
	it("returns errors for missing required fields", () => {
		const r = validateWorkerLoopOptions({});
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.diagnostics.map((d) => d.message)).toEqual(
				expect.arrayContaining([
					expect.stringContaining("--socket-path"),
					expect.stringContaining("--agent-id"),
					expect.stringContaining("--agent-type"),
					expect.stringContaining("--project-id"),
					expect.stringContaining("--repo-path"),
				]),
			);
		}
	});

	it("applies defaults when only required fields are present", () => {
		const r = validateWorkerLoopOptions({
			socketPath: "/s",
			agentId: "a",
			agentType: "worker",
			projectId: "p",
			repoPath: "/r",
		});
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.options.idleTtlMs).toBe(60 * 60_000);
			expect(r.options.heartbeatIntervalMs).toBe(10_000);
		}
	});
});

describe("runWorkerLoopMode envelope dispatch", () => {
	it("publishes AgentTaskResult on agent_task_request and exits on shutdown", async () => {
		const bus = new FakeBus("worker-1", "worker");
		const { runtime, session } = createRuntime({
			responses: [{ assistantMessages: [makeAssistantMessage({ text: "all done", usage: makeUsage(100, 50) })] }],
		});

		bus.enqueue([
			buildEnvelope(
				{
					kind: "agent_task_request",
					taskId: "task-1",
					projectId: "proj-1",
					milestoneId: "m-1",
					prompt: "do thing",
					worktreePath: "/tmp/repo",
				},
				"worker-1",
			),
		]);
		bus.enqueue([buildEnvelope({ kind: "shutdown", toAgentId: "worker-1", reason: "leader_kill" }, "worker-1")]);

		const result = await runWorkerLoopMode(runtime as never, {
			...baseOptions,
			bus: bus as unknown as SocketBus,
			idleTtlMs: 60_000,
			heartbeatIntervalMs: 60_000,
		});

		expect(result.exitReason).toBe("shutdown");
		expect(result.exitCode).toBe(0);
		expect(result.tasksHandled).toBe(1);

		expect(session.prompt).toHaveBeenCalledWith("do thing");

		const taskResults = bus.published.filter((p) => (p.payload as { kind?: string }).kind === "agent_task_result");
		expect(taskResults).toHaveLength(1);
		const taskResult = taskResults[0].payload as Record<string, unknown>;
		expect(taskResult.inReplyTo).toBe("task-1");
		expect(taskResult.status).toBe("success");
		expect(taskResult.rawOutput).toBe("all done");
		expect(taskResult.tokenUsage).toEqual({ input: 100, output: 50 });
		expect(taskResults[0].to).toBe("leader");

		expect(runtime.dispose).toHaveBeenCalledTimes(1);
	});

	it("ignores shutdown envelopes addressed to a different agent", async () => {
		const bus = new FakeBus("worker-1", "worker");
		const { runtime } = createRuntime({ responses: [] });

		bus.enqueue([buildEnvelope({ kind: "shutdown", toAgentId: "other-agent", reason: "leader_kill" }, "worker-1")]);
		// idle ttl is short so the loop exits via TTL, not shutdown.

		const result = await runWorkerLoopMode(runtime as never, {
			...baseOptions,
			bus: bus as unknown as SocketBus,
			idleTtlMs: 30,
		});

		expect(result.exitReason).toBe("idle_ttl");
		expect(result.tasksHandled).toBe(0);
	});

	it("publishes an error AgentTaskResult when the prompt throws", async () => {
		const bus = new FakeBus("worker-1", "worker");
		const { runtime } = createRuntime({
			responses: [],
			throwFromPrompt: new Error("model down"),
		});

		bus.enqueue([
			buildEnvelope(
				{
					kind: "agent_task_request",
					taskId: "task-err",
					projectId: "proj-1",
					milestoneId: "m-1",
					prompt: "boom",
					worktreePath: "/tmp/repo",
				},
				"worker-1",
			),
		]);
		bus.enqueue([buildEnvelope({ kind: "shutdown", toAgentId: "worker-1", reason: "leader_kill" }, "worker-1")]);

		await runWorkerLoopMode(runtime as never, {
			...baseOptions,
			bus: bus as unknown as SocketBus,
			idleTtlMs: 60_000,
			heartbeatIntervalMs: 60_000,
		});

		const taskResults = bus.published.filter((p) => (p.payload as { kind?: string }).kind === "agent_task_result");
		expect(taskResults).toHaveLength(1);
		const taskResult = taskResults[0].payload as Record<string, unknown>;
		expect(taskResult.status).toBe("error");
		expect(taskResult.errorMessage).toBe("model down");
	});

	it("flags timeouts when timeoutMs elapses before prompt resolves", async () => {
		const bus = new FakeBus("worker-1", "worker");
		const { runtime, session } = createRuntime({
			responses: [{ assistantMessages: [makeAssistantMessage({ text: "late" })] }],
			promptDelayMs: 200,
		});

		bus.enqueue([
			buildEnvelope(
				{
					kind: "agent_task_request",
					taskId: "task-slow",
					projectId: "proj-1",
					milestoneId: "m-1",
					prompt: "slow",
					worktreePath: "/tmp/repo",
					timeoutMs: 30,
				},
				"worker-1",
			),
		]);
		bus.enqueue([buildEnvelope({ kind: "shutdown", toAgentId: "worker-1", reason: "leader_kill" }, "worker-1")]);

		await runWorkerLoopMode(runtime as never, {
			...baseOptions,
			bus: bus as unknown as SocketBus,
			idleTtlMs: 60_000,
			heartbeatIntervalMs: 60_000,
		});

		const taskResults = bus.published.filter((p) => (p.payload as { kind?: string }).kind === "agent_task_result");
		expect(taskResults).toHaveLength(1);
		expect((taskResults[0].payload as { status: string }).status).toBe("timeout");
		expect(session.abort).toHaveBeenCalled();
	});
});

describe("runWorkerLoopMode lifecycle", () => {
	it("exits via idle TTL when no tasks arrive", async () => {
		const bus = new FakeBus("worker-1", "worker");
		const { runtime } = createRuntime({ responses: [] });

		const start = Date.now();
		const result = await runWorkerLoopMode(runtime as never, {
			...baseOptions,
			bus: bus as unknown as SocketBus,
			idleTtlMs: 25,
		});

		expect(result.exitReason).toBe("idle_ttl");
		expect(Date.now() - start).toBeGreaterThanOrEqual(25);
	});

	it("emits heartbeat envelopes on the configured cadence", async () => {
		const bus = new FakeBus("worker-1", "worker");
		const { runtime } = createRuntime({ responses: [] });

		await runWorkerLoopMode(runtime as never, {
			...baseOptions,
			bus: bus as unknown as SocketBus,
			idleTtlMs: 80,
			heartbeatIntervalMs: 15,
		});

		const heartbeats = bus.published.filter(
			(p) => (p.payload as { kind?: string }).kind === "heartbeat" && p.to === "broadcast",
		);
		// 80ms / 15ms ≈ 5 cadence ticks; allow slack for timer drift on busy CI.
		expect(heartbeats.length).toBeGreaterThanOrEqual(2);
		expect(heartbeats.length).toBeLessThanOrEqual(8);
		const sample = heartbeats[0].payload as Record<string, unknown>;
		expect(sample.agentId).toBe("worker-1");
		expect(sample.projectId).toBe("proj-1");
		expect(typeof sample.emittedAt).toBe("number");
	});
});

import type { ServiceCall } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, type JsonlSessionMetadata } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CoordinatorConnectionEvent } from "../src/experimental/coordinator.ts";
import { SessionWorkerManager } from "../src/experimental/session-worker-manager.ts";

const metadata: JsonlSessionMetadata = {
	id: "session-1",
	createdAt: 1,
	storageVersion: 1,
	cwd: "/tmp",
	path: "/tmp/session-1.jsonl",
	modifiedAt: 1,
};

class FakeCoordinator {
	readonly controlPath = "/tmp/control.sock";
	readonly serverConnectionId = "server-generation-1";
	readonly wasReplaced = false;
	readonly sent: { peerId: string; payload: unknown }[] = [];
	readonly #listeners = new Set<(event: CoordinatorConnectionEvent) => void>();
	onSend?: (peerId: string, payload: Record<string, unknown>) => void;

	onEvent(listener: (event: CoordinatorConnectionEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async send(peerId: string, payload: unknown): Promise<void> {
		this.sent.push({ peerId, payload });
		this.onSend?.(peerId, asObject(payload));
	}

	async broadcast(payload: unknown): Promise<void> {
		if (asObject(payload).type !== "discover_workers") return;
		this.emit({
			type: "message",
			from: "worker-1",
			payload: {
				type: "worker_ready",
				token: "worker-token",
				sessionKey: metadata.path,
				sessionId: metadata.id,
				pid: 123,
				metadata,
				pluginManifestPaths: [],
			},
		});
	}

	emit(event: CoordinatorConnectionEvent): void {
		for (const listener of this.#listeners) listener(event);
	}
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

async function createAttachedWorker(): Promise<{
	coordinator: FakeCoordinator;
	workers: SessionWorkerManager;
	handle: Awaited<ReturnType<SessionWorkerManager["openSession"]>>;
	attachment: Awaited<ReturnType<Awaited<ReturnType<SessionWorkerManager["openSession"]>>["attachClient"]>>;
	release(): Promise<void>;
}> {
	const coordinator = new FakeCoordinator();
	const workers = new SessionWorkerManager(coordinator, "/tmp");
	await workers.discover(new Set(["worker-1"]));
	const handle = await workers.openSession(metadata, BACKGROUND_CONTEXT, []);
	coordinator.onSend = (peerId, payload) => {
		if (payload.type !== "session_demand") return;
		queueMicrotask(() =>
			coordinator.emit({
				type: "message",
				from: peerId,
				payload: {
					type: "demand_applied",
					token: "worker-token",
					sessionKey: metadata.path,
					requestId: payload.requestId,
					attachmentId: payload.attachmentId,
					attached: payload.attached,
				},
			}),
		);
	};
	const attachment = await handle.attachClient!(BACKGROUND_CONTEXT);
	return {
		coordinator,
		workers,
		handle,
		attachment,
		release: () => Promise.resolve(attachment.release(BACKGROUND_CONTEXT)),
	};
}

describe("Session worker lifecycle failures", () => {
	test("adopts a discovered worker with its existing Session plugin selection", async () => {
		const coordinator = new FakeCoordinator();
		const workers = new SessionWorkerManager(coordinator, "/tmp");
		await workers.discover(new Set(["worker-1"]));
		expect(coordinator.sent).not.toContainEqual({ peerId: "worker-1", payload: { type: "shutdown" } });
		expect(workers.workerPids.size).toBe(1);
		expect(() => workers.assertSessionPluginManifestPaths(metadata, [])).not.toThrow();
		workers.detach();
	});

	test("rejects a different plugin selection for an active Session without stopping it", async () => {
		const { workers } = await createAttachedWorker();
		expect(() => workers.assertSessionPluginManifestPaths(metadata, ["/tmp/plugin/chord-facets.json"])).toThrow(
			"active with a different plugin selection",
		);
		expect(workers.workerPids.size).toBe(1);
		workers.detach();
	});

	test("compensates a timed-out attachment before rejecting it", async () => {
		vi.useFakeTimers();
		const coordinator = new FakeCoordinator();
		const workers = new SessionWorkerManager(coordinator, "/tmp");
		await workers.discover(new Set(["worker-1"]));
		const handle = await workers.openSession(metadata, BACKGROUND_CONTEXT, []);
		const demands: { attachmentId: string; attached: boolean }[] = [];
		coordinator.onSend = (peerId, payload) => {
			if (
				payload.type !== "session_demand" ||
				typeof payload.attachmentId !== "string" ||
				typeof payload.attached !== "boolean"
			) {
				return;
			}
			demands.push({ attachmentId: payload.attachmentId, attached: payload.attached });
			if (payload.attached) return;
			queueMicrotask(() =>
				coordinator.emit({
					type: "message",
					from: peerId,
					payload: {
						type: "demand_applied",
						token: "worker-token",
						sessionKey: metadata.path,
						requestId: payload.requestId,
						attachmentId: payload.attachmentId,
						attached: false,
					},
				}),
			);
		};

		const attaching = expect(handle.attachClient!(BACKGROUND_CONTEXT)).rejects.toThrow("timed out");
		await vi.advanceTimersByTimeAsync(5_000);
		await attaching;
		expect(demands).toHaveLength(2);
		expect(demands[0]).toMatchObject({ attachmentId: expect.any(String), attached: true });
		expect(demands[1]).toEqual({ attachmentId: demands[0]!.attachmentId, attached: false });
		workers.detach();
	});

	test("kills a worker when timed-out demand cannot be reconciled", async () => {
		vi.useFakeTimers();
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		const coordinator = new FakeCoordinator();
		const workers = new SessionWorkerManager(coordinator, "/tmp");
		await workers.discover(new Set(["worker-1"]));
		const handle = await workers.openSession(metadata, BACKGROUND_CONTEXT, []);
		coordinator.onSend = () => {};

		const attaching = expect(handle.attachClient!(BACKGROUND_CONTEXT)).rejects.toThrow("worker was terminated");
		await vi.advanceTimersByTimeAsync(5_000);
		await vi.advanceTimersByTimeAsync(5_000);
		await vi.advanceTimersByTimeAsync(10_000);
		await attaching;
		expect(kill).toHaveBeenCalledWith(123, "SIGKILL");
		expect(workers.workerPids.size).toBe(0);
		workers.detach();
	});

	test("bounds Harness-driven worker shutdown", async () => {
		vi.useFakeTimers();
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		const { coordinator, workers, handle, release } = await createAttachedWorker();
		await release();
		coordinator.onSend = () => {};

		const closing = handle.close(BACKGROUND_CONTEXT);
		await vi.advanceTimersByTimeAsync(10_000);
		await closing;
		expect(kill).toHaveBeenCalledWith(123, "SIGKILL");
		expect(workers.workerPids.size).toBe(0);
		workers.detach();
	});
});

describe("Session worker operations", () => {
	const serviceCall = { serviceId: "test.session", member: "run", args: ["Hello"] } satisfies ServiceCall;

	test("correlates service results to the worker generation and attachment", async () => {
		const { coordinator, workers, attachment, release } = await createAttachedWorker();
		coordinator.onSend = (peerId, payload) => {
			if (payload.type !== "operation") return;
			const scope = asObject(payload.scope);
			queueMicrotask(() => {
				coordinator.emit({
					type: "message",
					from: peerId,
					payload: {
						type: "operation_response",
						token: "worker-token",
						sessionKey: metadata.path,
						response: {
							type: "operation_result",
							requestId: payload.requestId,
							scope,
							result: { accepted: true },
						},
					},
				});
			});
		};
		await expect(attachment.invokeService(serviceCall, () => {}, BACKGROUND_CONTEXT)).resolves.toEqual({
			accepted: true,
		});
		const operation = coordinator.sent
			.map(({ payload }) => asObject(payload))
			.find(({ type }) => type === "operation");
		expect(operation).toMatchObject({
			scope: { serverConnectionId: "server-generation-1", attachmentId: expect.any(String) },
			call: serviceCall,
		});
		workers.detach();
		await release();
	});

	test("rejects a correlated response with mismatched worker identity", async () => {
		const { coordinator, workers, attachment, release } = await createAttachedWorker();
		coordinator.onSend = (peerId, payload) => {
			if (payload.type !== "operation") return;
			queueMicrotask(() =>
				coordinator.emit({
					type: "message",
					from: peerId,
					payload: {
						type: "operation_response",
						token: "wrong-token",
						sessionKey: metadata.path,
						response: {
							type: "operation_result",
							requestId: payload.requestId,
							scope: payload.scope,
							result: { accepted: true },
						},
					},
				}),
			);
		};
		await expect(attachment.invokeService(serviceCall, () => {}, BACKGROUND_CONTEXT)).rejects.toThrow(
			/mismatched operation response/,
		);
		workers.detach();
		await release();
	});

	test("rejects a null request scope", async () => {
		const { coordinator, workers, attachment, release } = await createAttachedWorker();
		coordinator.onSend = (peerId, payload) => {
			if (payload.type !== "operation") return;
			queueMicrotask(() =>
				coordinator.emit({
					type: "message",
					from: peerId,
					payload: {
						type: "operation_response",
						token: "worker-token",
						sessionKey: metadata.path,
						response: {
							type: "operation_result",
							requestId: payload.requestId,
							scope: null,
							result: { accepted: true },
						},
					},
				}),
			);
		};
		await expect(attachment.invokeService(serviceCall, () => {}, BACKGROUND_CONTEXT)).rejects.toThrow(
			/invalid operation response/,
		);
		workers.detach();
		await release();
	});

	test("rejects pending service calls on replacement without stopping the worker", async () => {
		const { coordinator, workers, attachment } = await createAttachedWorker();
		coordinator.onSend = () => {};
		const calling = attachment.invokeService(serviceCall, () => {}, BACKGROUND_CONTEXT);
		workers.detach();

		await expect(calling).rejects.toThrow(/replaced during a worker operation/);
		expect(coordinator.sent.map(({ payload }) => asObject(payload).type)).not.toContain("shutdown");
		expect(workers.workerPids.size).toBe(0);
	});
});

function asObject(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Expected object");
	return value as Record<string, unknown>;
}

import { afterEach, describe, expect, test, vi } from "vitest";
import { WorkerLifecycle } from "../src/experimental/session-worker.ts";

const GENERATION = "generation-1";

function createLifecycle(options: { initialDemandGraceMs?: number; orphanDemandGraceMs?: number } = {}) {
	const retire = vi.fn();
	const lifecycle = new WorkerLifecycle({
		initialServerConnectionId: GENERATION,
		initialDemandGraceMs: options.initialDemandGraceMs ?? 100,
		orphanDemandGraceMs: options.orphanDemandGraceMs ?? 200,
		onRetire: retire,
	});
	return { lifecycle, retire };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("Session worker lifecycle", () => {
	test("retires only after client demand and Harness activity are both gone", async () => {
		vi.useFakeTimers();
		const { lifecycle, retire } = createLifecycle();
		lifecycle.setDemand(GENERATION, "attachment-1", true);
		lifecycle.operationStarted("run", "main", "operation-1");
		lifecycle.setDemand(GENERATION, "attachment-1", false);
		expect(retire).not.toHaveBeenCalled();

		lifecycle.operationStopped("run", "main", "operation-1");
		await vi.runAllTicks();
		expect(retire).toHaveBeenCalledOnce();
		lifecycle.close();
	});

	test("retains the worker until every presentation attachment is released", () => {
		vi.useFakeTimers();
		const { lifecycle, retire } = createLifecycle();
		lifecycle.setDemand(GENERATION, "attachment-1", true);
		lifecycle.setDemand(GENERATION, "attachment-2", true);
		lifecycle.setDemand(GENERATION, "attachment-1", false);
		expect(retire).not.toHaveBeenCalled();
		lifecycle.setDemand(GENERATION, "attachment-2", false);
		expect(retire).toHaveBeenCalledOnce();
		lifecycle.close();
	});

	test("tracks a nested compaction independently from its enclosing run", () => {
		vi.useFakeTimers();
		const { lifecycle, retire } = createLifecycle();
		lifecycle.setDemand(GENERATION, "attachment-1", true);
		lifecycle.operationStarted("run", "main", "operation-1");
		lifecycle.operationStarted("compaction", "main", "operation-1");
		lifecycle.setDemand(GENERATION, "attachment-1", false);

		lifecycle.operationStopped("compaction", "main", "operation-1");
		expect(retire).not.toHaveBeenCalled();
		lifecycle.operationStopped("run", "main", "operation-1");
		expect(retire).toHaveBeenCalledOnce();
		lifecycle.close();
	});

	test.each(["compaction", "navigation"] as const)("clears suspended %s activity", (kind) => {
		vi.useFakeTimers();
		const { lifecycle, retire } = createLifecycle();
		lifecycle.setDemand(GENERATION, "attachment-1", true);
		lifecycle.operationStarted(kind, "main", "operation-1");
		lifecycle.setDemand(GENERATION, "attachment-1", false);

		lifecycle.operationStopped(kind, "main", "operation-1");
		expect(retire).toHaveBeenCalledOnce();
		lifecycle.close();
	});

	test("does not retire while a demand acknowledgement holds reconciliation", () => {
		vi.useFakeTimers();
		const { lifecycle, retire } = createLifecycle();
		lifecycle.setDemand(GENERATION, "attachment-1", true);
		const release = lifecycle.holdRetirement();
		lifecycle.setDemand(GENERATION, "attachment-1", false);
		expect(retire).not.toHaveBeenCalled();
		release();
		expect(retire).toHaveBeenCalledOnce();
		lifecycle.close();
	});

	test("holds retirement only for requests from the active attachment", () => {
		vi.useFakeTimers();
		const { lifecycle, retire } = createLifecycle();
		lifecycle.setDemand(GENERATION, "attachment-1", true);
		const release = lifecycle.beginRequest(GENERATION, "attachment-1");
		lifecycle.setDemand(GENERATION, "attachment-1", false);
		expect(retire).not.toHaveBeenCalled();
		release();
		expect(retire).toHaveBeenCalledOnce();
		expect(() => lifecycle.beginRequest(GENERATION, "attachment-1")).toThrow(/retiring/);
		lifecycle.close();
	});

	test("rejects requests from stale generations and attachments", () => {
		vi.useFakeTimers();
		const { lifecycle } = createLifecycle();
		lifecycle.setDemand(GENERATION, "attachment-1", true);
		expect(() => lifecycle.beginRequest("stale", "attachment-1")).toThrow(/stale server generation/);
		expect(() => lifecycle.beginRequest(GENERATION, "wrong-attachment")).toThrow(/active attachment/);
		lifecycle.close();
	});

	test("retains disconnected-generation demand for the orphan grace", async () => {
		vi.useFakeTimers();
		const { lifecycle, retire } = createLifecycle();
		lifecycle.setDemand(GENERATION, "attachment-1", true);
		lifecycle.serverDisconnected(GENERATION);

		vi.advanceTimersByTime(199);
		expect(retire).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		await vi.runAllTicks();
		expect(retire).toHaveBeenCalledOnce();
		lifecycle.close();
	});

	test("allows a replacement generation to retain the worker", async () => {
		vi.useFakeTimers();
		const { lifecycle, retire } = createLifecycle();
		lifecycle.setDemand(GENERATION, "attachment-1", true);
		lifecycle.serverDisconnected(GENERATION);
		lifecycle.serverConnected("generation-2");
		lifecycle.setDemand("generation-2", "attachment-2", true);

		vi.advanceTimersByTime(200);
		expect(retire).not.toHaveBeenCalled();
		lifecycle.setDemand("generation-2", "attachment-2", false);
		await vi.runAllTicks();
		expect(retire).toHaveBeenCalledOnce();
		lifecycle.close();
	});

	test("retires a launched worker that never receives initial demand", async () => {
		vi.useFakeTimers();
		const { lifecycle, retire } = createLifecycle();
		vi.advanceTimersByTime(100);
		await vi.runAllTicks();
		expect(retire).toHaveBeenCalledOnce();
		lifecycle.close();
	});

	test("rejects demand after retirement has won the race", () => {
		vi.useFakeTimers();
		const { lifecycle } = createLifecycle();
		vi.advanceTimersByTime(100);
		expect(() => lifecycle.setDemand(GENERATION, "attachment-1", true)).toThrow(/retiring/);
		lifecycle.close();
	});

	test("rejects demand from a stale server generation", () => {
		vi.useFakeTimers();
		const { lifecycle } = createLifecycle();
		expect(() => lifecycle.setDemand("stale", "attachment-1", true)).toThrow(/stale server generation/);
		lifecycle.close();
	});
});

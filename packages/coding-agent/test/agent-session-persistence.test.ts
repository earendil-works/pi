import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { AgentSessionServices } from "../src/core/agent-session-services.ts";

function createRuntime(options: { dispose: () => Promise<void>; emit?: () => Promise<void> }): AgentSessionRuntime {
	const extensionRunner = {
		hasHandlers: () => options.emit !== undefined,
		emit: options.emit ?? (async () => undefined),
	};
	const session = {
		extensionRunner,
		abort: async () => undefined,
		dispose: options.dispose,
	} as unknown as AgentSession;
	const services = { cwd: "/tmp", agentDir: "/tmp" } as AgentSessionServices;
	return new AgentSessionRuntime(session, services, vi.fn());
}

describe("AgentSessionRuntime persistence teardown", () => {
	it("awaits storage disposal before settling", async () => {
		let release!: () => void;
		const closed = new Promise<void>((resolve) => {
			release = resolve;
		});
		let settled = false;
		const runtime = createRuntime({ dispose: () => closed });
		const disposing = runtime.dispose().then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		release();
		await disposing;
		expect(settled).toBe(true);
	});

	it("preserves shutdown and cleanup failures", async () => {
		const shutdownError = new Error("shutdown failed");
		const cleanupError = new Error("cleanup failed");
		const runtime = createRuntime({
			emit: async () => {
				throw shutdownError;
			},
			dispose: async () => {
				throw cleanupError;
			},
		});

		let failure: unknown;
		try {
			await runtime.dispose();
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(AggregateError);
		expect(failure).toMatchObject({ cause: shutdownError, errors: [shutdownError, cleanupError] });
	});
});

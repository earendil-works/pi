/**
 * Regression tests for the shutdown hang: a `session_shutdown` handler that never settles kept
 * `ExtensionRunner.emit` waiting forever, so the runtime never finished disposing and the process
 * outlived its terminal. These tests pin the bound on that wait and prove the previous behaviour
 * (fully awaiting handlers) is untouched when no bound is requested.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner, emitSessionShutdownEvent } from "../src/core/extensions/runner.ts";
import type { ExtensionError, SessionShutdownEvent } from "../src/core/extensions/types.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

const shutdownEvent: SessionShutdownEvent = { type: "session_shutdown", reason: "quit" };

/** A handler that never settles, which is what actually happens when an extension teardown hangs. */
function neverSettles(): Promise<never> {
	return new Promise<never>(() => {});
}

async function raceFor(ms: number): Promise<"hung"> {
	return await new Promise<"hung">((resolve) => {
		setTimeout(() => resolve("hung"), ms).unref?.();
	});
}

describe("extension handler timeouts", () => {
	let tempDir: string;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-emit-timeout-"));
		sessionManager = SessionManager.inMemory();
		modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	async function runnerWith(factory: Parameters<typeof loadExtensionFromFactory>[0]) {
		const runtime = createExtensionRuntime();
		const eventBus = createEventBus();
		const extension = await loadExtensionFromFactory(factory, tempDir, eventBus, runtime);
		return new ExtensionRunner([extension], runtime, tempDir, sessionManager, modelRegistry);
	}

	it("still awaits a handler fully when no timeout is requested", async () => {
		let finished = false;
		const runner = await runnerWith((pi) => {
			pi.on("session_shutdown", async () => {
				await new Promise((resolve) => setTimeout(resolve, 25));
				finished = true;
			});
		});

		await runner.emit(shutdownEvent);

		expect(finished).toBe(true);
	});

	it("stops waiting for a handler that never settles and reports it", async () => {
		const errors: ExtensionError[] = [];
		let laterHandlerRan = false;
		const runner = await runnerWith((pi) => {
			pi.on("session_shutdown", () => neverSettles());
			pi.on("session_shutdown", () => {
				laterHandlerRan = true;
			});
		});
		runner.onError((error) => {
			errors.push(error);
		});

		const outcome = await Promise.race([
			runner.emit(shutdownEvent, { handlerTimeoutMs: 50 }).then(() => "returned" as const),
			raceFor(2000),
		]);

		expect(outcome).toBe("returned");
		// The handler after the stuck one must still run: a hang cannot swallow the rest of the teardown.
		expect(laterHandlerRan).toBe(true);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.event).toBe("session_shutdown");
		expect(errors[0]?.error).toMatch(/timed out after 50ms/);
	});

	it("bounds the shutdown dispatch by default so dispose can finish", async () => {
		const runner = await runnerWith((pi) => {
			pi.on("session_shutdown", () => neverSettles());
		});

		const started = Date.now();
		const outcome = await Promise.race([
			emitSessionShutdownEvent(runner, shutdownEvent).then(() => "returned" as const),
			raceFor(10_000),
		]);

		expect(outcome).toBe("returned");
		expect(Date.now() - started).toBeLessThan(5000);
	});

	it("returns true from emitSessionShutdownEvent when a handler was registered", async () => {
		const runner = await runnerWith((pi) => {
			pi.on("session_shutdown", () => {});
		});

		await expect(emitSessionShutdownEvent(runner, shutdownEvent)).resolves.toBe(true);
	});
});

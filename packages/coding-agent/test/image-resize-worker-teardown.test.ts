import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	releaseTerminate: undefined as (() => void) | undefined,
}));

vi.mock("node:worker_threads", async () => {
	const { EventEmitter } = await import("node:events");
	class FakeWorker extends EventEmitter {
		postMessage(): void {
			queueMicrotask(() => {
				this.emit("message", { type: "pi:image-resize-response", result: null });
			});
		}

		terminate(): Promise<number> {
			return new Promise<number>((resolve) => {
				state.releaseTerminate = () => resolve(1);
			});
		}
	}
	return { Worker: FakeWorker };
});

describe("resizeImage worker teardown", () => {
	it("does not resolve until the worker has terminated", async () => {
		const { IMAGE_RESIZE_WORKER_RESPONSE_TYPE } = await import("../src/utils/image-resize-core.ts");
		expect(IMAGE_RESIZE_WORKER_RESPONSE_TYPE).toBe("pi:image-resize-response");
		const { resizeImage } = await import("../src/utils/image-resize.ts");

		let resolved = false;
		const pending = resizeImage(new Uint8Array([1, 2, 3]), "image/png").then((result) => {
			resolved = true;
			return result;
		});

		await vi.waitFor(() => expect(state.releaseTerminate).toBeDefined());
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(resolved).toBe(false);

		state.releaseTerminate?.();
		await expect(pending).resolves.toBeNull();
		expect(resolved).toBe(true);
	});
});

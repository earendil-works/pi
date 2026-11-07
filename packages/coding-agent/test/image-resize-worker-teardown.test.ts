import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resizeImage } from "../src/utils/image-resize.ts";

// Small 1x1 red PNG image (base64) - same fixture as image-resize-callers.test.ts.
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

describe("image resize worker teardown", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// Issue #10695: the resize wrapper did not await terminate(), so serial image reads
	// could start a new worker while the previous one was still shutting down, which
	// aborted the process on macOS with Node 24. resizeImage must not resolve while a
	// worker it started is still terminating.
	it("does not resolve until the resize worker has finished terminating", async () => {
		const originalTerminate = Worker.prototype.terminate;
		let pendingTerminations = 0;
		vi.spyOn(Worker.prototype, "terminate").mockImplementation(function (this: Worker) {
			pendingTerminations++;
			return originalTerminate.apply(this).finally(() => {
				pendingTerminations--;
			});
		});

		const bytes = new Uint8Array(Buffer.from(TINY_PNG_BASE64, "base64"));

		for (let i = 0; i < 2; i++) {
			const result = await resizeImage(bytes, "image/png");
			expect(result).not.toBeNull();
			expect(pendingTerminations).toBe(0);
		}
	});
});

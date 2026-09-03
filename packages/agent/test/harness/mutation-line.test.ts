import { describe, expect, it } from "vitest";
import { MutationLine } from "../../src/harness/session/mutation-line.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolvePromise!: () => void;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

describe("MutationLine", () => {
	it("serializes every Session mutation", async () => {
		const line = new MutationLine();
		const gate = deferred();
		const order: string[] = [];
		const first = line.run(async () => {
			order.push("first:start");
			await gate.promise;
			order.push("first:end");
			return "first";
		});
		const second = line.run(() => {
			order.push("second");
			return "second";
		});

		await Promise.resolve();
		expect(order).toEqual(["first:start"]);
		gate.resolve();
		await expect(first).resolves.toBe("first");
		await expect(second).resolves.toBe("second");
		expect(order).toEqual(["first:start", "first:end", "second"]);
	});

	it("continues after a failed job while preserving the original failure", async () => {
		const line = new MutationLine();
		const rejection = new Error("mutation failed");

		await expect(
			line.run(() => {
				throw rejection;
			}),
		).rejects.toBe(rejection);
		await expect(line.run(() => "next")).resolves.toBe("next");
	});

	it("seals queued and future jobs while draining the running job", async () => {
		const line = new MutationLine();
		const gate = deferred();
		const running = line.run(async () => {
			await gate.promise;
			return "running";
		});
		await Promise.resolve();
		const queued = line.run(() => "queued");
		const closed = new Error("closed");

		const drained = line.seal(closed);
		await expect(line.run(() => "late")).rejects.toBe(closed);
		gate.resolve();
		await expect(running).resolves.toBe("running");
		await expect(queued).rejects.toBe(closed);
		await drained;
	});
});

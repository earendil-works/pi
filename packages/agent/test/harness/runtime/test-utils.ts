import { BACKGROUND_CONTEXT } from "../../../src/harness/context.ts";
import { MemoryStorage } from "../../../src/harness/session/memory.ts";
import type { CommitResult, Write } from "../../../src/harness/session/types.ts";

export class FailingMemoryStorage extends MemoryStorage {
	failure: Error | undefined;

	override commit(writes: Write[]) {
		const failure = this.failure;
		this.failure = undefined;
		return failure === undefined ? super.commit(writes, BACKGROUND_CONTEXT) : Promise.reject(failure);
	}
}

export class ControlledMemoryStorage extends MemoryStorage {
	beforeNextCommit: (() => Promise<void>) | undefined;

	override async commit(writes: Write[]): Promise<CommitResult> {
		const beforeCommit = this.beforeNextCommit;
		this.beforeNextCommit = undefined;
		await beforeCommit?.();
		return super.commit(writes, BACKGROUND_CONTEXT);
	}
}

export function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: () => resolvePromise?.() };
}

import type { Context } from "../../context.ts";
import type { CommitResult, Write } from "../types.ts";
import { StorageDecorator } from "./storage-decorator.ts";

/** Test-only transparent Storage decorator that records commit admission. */
export class InstrumentedStorage extends StorageDecorator {
	private readonly commitAttempts: Write[][] = [];

	getCommitAttempts(): readonly Write[][] {
		return this.commitAttempts.slice();
	}

	clearCommitAttempts(): void {
		this.commitAttempts.length = 0;
	}

	override commit(writes: Write[], context: Context): Promise<CommitResult> {
		this.commitAttempts.push(writes);
		return this.delegate.commit(writes, context);
	}
}

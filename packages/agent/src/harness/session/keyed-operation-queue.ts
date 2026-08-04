export class KeyedOperationQueue<TKey> {
	private readonly tails = new Map<TKey, Promise<void>>();
	private readonly maxConcurrentOperations: number | undefined;
	private readonly permitWaiters: Array<() => void> = [];
	private activeOperations = 0;
	private barrier: Promise<void> = Promise.resolve();

	constructor(options: { maxConcurrentOperations?: number } = {}) {
		if (
			options.maxConcurrentOperations !== undefined &&
			(!Number.isInteger(options.maxConcurrentOperations) || options.maxConcurrentOperations < 1)
		) {
			throw new RangeError("maxConcurrentOperations must be a positive integer");
		}
		this.maxConcurrentOperations = options.maxConcurrentOperations;
	}

	enqueue<T>(key: TKey, operation: () => Promise<T> | T): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve();
		const result = Promise.all([this.barrier, previous]).then(() => this.runOperation(operation));
		const tail = result.then(
			() => undefined,
			() => undefined,
		);
		this.tails.set(key, tail);
		void tail.then(() => {
			if (this.tails.get(key) === tail) this.tails.delete(key);
		});
		return result;
	}

	enqueueBarrier<T>(operation: () => Promise<T> | T): Promise<T> {
		const result = Promise.all([this.barrier, ...this.tails.values()]).then(() => this.runOperation(operation));
		this.barrier = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async drain(): Promise<void> {
		await Promise.all([this.barrier, ...this.tails.values()]);
	}

	private async runOperation<T>(operation: () => Promise<T> | T): Promise<T> {
		await this.acquirePermit();
		try {
			return await operation();
		} finally {
			this.releasePermit();
		}
	}

	private async acquirePermit(): Promise<void> {
		if (this.maxConcurrentOperations === undefined) return;
		if (this.activeOperations < this.maxConcurrentOperations) {
			this.activeOperations += 1;
			return;
		}
		await new Promise<void>((resolve) => this.permitWaiters.push(resolve));
	}

	private releasePermit(): void {
		if (this.maxConcurrentOperations === undefined) return;
		const next = this.permitWaiters.shift();
		if (next) next();
		else this.activeOperations -= 1;
	}
}

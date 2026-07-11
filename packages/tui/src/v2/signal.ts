export type SignalListener<T> = (value: T) => void;

/** Small synchronous signal used for retained-strip invalidation. */
export class Signal<T> {
	private readonly listeners = new Set<SignalListener<T>>();

	subscribe(listener: SignalListener<T>): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(value: T): void {
		for (const listener of [...this.listeners]) listener(value);
	}

	clear(): void {
		this.listeners.clear();
	}
}

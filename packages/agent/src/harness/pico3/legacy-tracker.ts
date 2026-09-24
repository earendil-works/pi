import {
	type Change,
	type Tracker as ChordTracker,
	type JsonValue,
	type Op,
	type Prepared,
	track as trackChord,
} from "@earendil-works/chord/delta";

/** Temporary compatibility surface for Pico3's flush-based document handling. */
export interface Tracker<T extends object> {
	readonly state: T;
	readonly target: T;
	readonly dirty: boolean;
	flush(): Op[];
	rebase(): void;
}

class LegacyTracker<T extends object> implements Tracker<T> {
	private readonly tracker: ChordTracker<T>;
	private change: Change<T> | undefined;
	private forceBase = true;

	constructor(initial: T) {
		this.tracker = trackChord(initial);
	}

	get state(): T {
		this.change ??= this.tracker.beginChange();
		return this.change.state as T;
	}

	get target(): T {
		return this.tracker.value;
	}

	get dirty(): boolean {
		return this.forceBase || this.change !== undefined;
	}

	flush(): Op[] {
		let prepared: Prepared<T> | undefined;
		if (this.change !== undefined) {
			const change = this.change;
			this.change = undefined;
			prepared = change.prepare();
			// Pico3 adopts before storage. A storage failure faults the owning Session.
			this.tracker.adopt(prepared);
		}
		if (this.forceBase) {
			this.forceBase = false;
			return [["r", this.tracker.value as unknown as JsonValue]];
		}
		return (prepared?.ops ?? []) as Op[];
	}

	rebase(): void {
		this.forceBase = true;
	}
}

export function track<T extends object>(initial: T): Tracker<T> {
	return new LegacyTracker(initial);
}

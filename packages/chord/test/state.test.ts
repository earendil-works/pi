import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../src/context/index.ts";
import type { Draft, Op } from "../src/delta/index.ts";
import {
	type Context,
	type JsonValue,
	type ReplicatedStateSource,
	type ReplicatedStateSourceAttachment,
	type ReplicatedStateSourceFrame,
	replicatedState,
} from "../src/index.ts";
import { ReplicatedStateReplica } from "../src/services/state.ts";
import { getReplicatedStateInternals } from "../src/services/state-internals.ts";

describe("transactional replicated state", () => {
	it("publishes one immutable structurally shared revision", () => {
		const initial = { changed: { value: 1 }, retained: { value: 2 } };
		const state = replicatedState(initial);
		const previous = state.value;
		const deliveries: number[] = [];
		state.subscribe((_value, _context, delivery) => deliveries.push(delivery.sequence));
		state.change(BACKGROUND_CONTEXT, (draft) => {
			draft.changed.value = 3;
			draft.changed.value = 4;
		});
		expect(state.value).toEqual({ changed: { value: 4 }, retained: { value: 2 } });
		expect(state.value).not.toBe(previous);
		expect(state.value.changed).not.toBe(previous.changed);
		expect(state.value.retained).toBe(previous.retained);
		expect(Object.isFrozen(state.value)).toBe(false);
		expect(deliveries).toEqual([0, 1]);
	});

	it("rolls back callback failures and revokes escaped drafts", () => {
		const state = replicatedState({ nested: { value: 1 } });
		const previous = state.value;
		let escaped: Draft<{ value: number }> | undefined;
		expect(() =>
			state.change(BACKGROUND_CONTEXT, (draft) => {
				escaped = draft.nested;
				draft.nested.value = 2;
				throw new Error("stop");
			}),
		).toThrow("stop");
		expect(state.value).toBe(previous);
		expect(() => escaped?.value).toThrow(TypeError);
	});

	it("rejects PromiseLike callbacks and aborts their draft", () => {
		const state = replicatedState({ value: 0 });
		const previous = state.value;
		expect(() =>
			state.change(BACKGROUND_CONTEXT, ((draft: Draft<{ value: number }>) => {
				draft.value = 1;
				return Promise.resolve();
			}) as (draft: Draft<{ value: number }>) => void),
		).toThrow(/synchronous/);
		expect(state.value).toBe(previous);
	});

	it("rejects nested changes and replacements without losing the outer rollback", () => {
		const state = replicatedState({ left: 0, right: 0 });
		expect(() =>
			state.change(BACKGROUND_CONTEXT, (draft) => {
				draft.left = 1;
				state.change(BACKGROUND_CONTEXT, (nested) => {
					nested.right = 2;
				});
			}),
		).toThrow(/reentrantly/);
		expect(state.value).toEqual({ left: 0, right: 0 });
		expect(() =>
			state.change(BACKGROUND_CONTEXT, () => {
				state.replace(BACKGROUND_CONTEXT, { left: 1, right: 2 });
			}),
		).toThrow(/change callback/);
		expect(state.value).toEqual({ left: 0, right: 0 });
	});

	it("queues listener-triggered changes in sequence order", () => {
		const state = replicatedState({ value: 0 });
		const sourceSequences: number[] = [];
		const deliveries: Array<{ value: number; sequence: number }> = [];
		const lateDeliveries: Array<{ kind: string; sequence: number }> = [];
		let nested = false;
		getReplicatedStateInternals(state)!.subscribe((_operations, sequence) => {
			if (!nested) {
				nested = true;
				state.change(BACKGROUND_CONTEXT, (draft) => {
					draft.value = 2;
				});
				state.subscribe((_value, _context, delivery) => lateDeliveries.push(delivery));
			}
			void sequence;
		});
		getReplicatedStateInternals(state)!.subscribe((_operations, sequence) => sourceSequences.push(sequence));
		state.subscribe((value, _context, delivery) => {
			if (delivery.kind === "update") deliveries.push({ value: value.value, sequence: delivery.sequence });
		});
		state.change(BACKGROUND_CONTEXT, (draft) => {
			draft.value = 1;
		});
		expect(sourceSequences).toEqual([1, 2]);
		expect(deliveries).toEqual([
			{ value: 1, sequence: 1 },
			{ value: 2, sequence: 2 },
		]);
		expect(lateDeliveries).toEqual([{ kind: "hydrate", sequence: 2 }]);
	});

	it("isolates listener failures after committing the revision", () => {
		const state = replicatedState({ value: 0 });
		const received: number[] = [];
		getReplicatedStateInternals(state)!.subscribe(() => {
			throw new Error("listener failed");
		});
		getReplicatedStateInternals(state)!.subscribe((_operations, sequence) => received.push(sequence));
		expect(() =>
			state.change(BACKGROUND_CONTEXT, (draft) => {
				draft.value = 1;
			}),
		).toThrow("listener failed");
		expect(state.value).toEqual({ value: 1 });
		expect(received).toEqual([1]);
	});

	it("copies assigned values by value", () => {
		const external = { value: 1 };
		const state = replicatedState<{ left: { value: number } | null; right: { value: number } | null }>({
			left: null,
			right: null,
		});
		state.change(BACKGROUND_CONTEXT, (draft) => {
			draft.left = external;
			draft.right = external;
			draft.left.value = 2;
		});
		expect(external.value).toBe(1);
		expect(state.value).toEqual({ left: { value: 2 }, right: { value: 1 } });
		expect(state.value.left).not.toBe(state.value.right);
	});

	it("takes immutable ownership of alias-free replacements", () => {
		const state = replicatedState({ left: { value: 1 }, right: { value: 2 } });
		const replacement = { left: { ...state.value.left }, right: { ...state.value.left } };
		state.replace(BACKGROUND_CONTEXT, replacement);
		expect(state.value).toBe(replacement);
		expect(state.value.left).not.toBe(state.value.right);
		state.change(BACKGROUND_CONTEXT, (draft) => {
			draft.left.value = 9;
		});
		expect(state.value).toEqual({ left: { value: 9 }, right: { value: 1 } });
	});

	it("preserves compact string, splice, and permutation operations", () => {
		const a = { id: "a" };
		const b = { id: "b" };
		const c = { id: "c" };
		const state = replicatedState({ text: "abcdefgh", values: [a, b, c] });
		const batches: JsonValue[] = [];
		getReplicatedStateInternals(state)!.subscribe((operations) => batches.push(operations as unknown as JsonValue));
		state.change(BACKGROUND_CONTEXT, (draft) => {
			draft.text = "defghxyz";
			draft.values.shift();
		});
		state.change(BACKGROUND_CONTEXT, (draft) => {
			draft.values.reverse();
		});
		expect(batches).toEqual([
			[
				["t", ["text"], 3],
				["a", ["text"], "xyz"],
				["p", ["values"], 0, 1, []],
			],
			[["m", ["values"], [1, 0]]],
		]);
	});

	it("validates replica revisions without freezing shared immutable payloads", () => {
		const replica = new ReplicatedStateReplica<{ rows: { value: number }[] }>(() => {});
		const initial = { rows: [{ value: 1 }] };
		replica.hydrate(0, [["r", initial]], BACKGROUND_CONTEXT);
		expect(replica.value).toBe(initial);
		expect(Object.isFrozen(initial)).toBe(false);
		expect(Object.isFrozen(initial.rows[0])).toBe(false);

		const inserted = { value: 2 };
		replica.update(1, [["p", ["rows"], 1, 0, [inserted]]], BACKGROUND_CONTEXT);
		expect(replica.value).not.toBe(initial);
		expect(replica.value?.rows).toEqual([{ value: 1 }, { value: 2 }]);
		expect(replica.value?.rows[0]).toBe(initial.rows[0]);
		expect(replica.value?.rows[1]).toBe(inserted);
		expect(initial.rows).toHaveLength(1);
		expect(Object.isFrozen(inserted)).toBe(false);
	});

	it("clears a replica when an adopted update is invalid", () => {
		const errors: Error[] = [];
		const replica = new ReplicatedStateReplica<{ value: number }>((error) => errors.push(error));
		replica.hydrate(0, [["r", { value: 0 }]], BACKGROUND_CONTEXT);
		expect(() => replica.update(1, [["s", ["value"], Number.NaN]], BACKGROUND_CONTEXT)).toThrow(/strict JSON/);
		expect(replica.value).toBeUndefined();
		expect(() => replica.update(2, [["s", ["value"], 2]], BACKGROUND_CONTEXT)).toThrow(/before hydration/);

		const malformed = new ReplicatedStateReplica<{ values: number[] }>((error) => errors.push(error));
		malformed.hydrate(0, [["r", { values: [1, 2] }]], BACKGROUND_CONTEXT);
		expect(() => malformed.update(1, [["m", ["values"], [0]]], BACKGROUND_CONTEXT)).toThrow();
		expect(malformed.value).toBeUndefined();
		expect(errors).toEqual([]);
	});

	it("replaces atomically and ignores deeply equal replacements", () => {
		const state = replicatedState({ value: { nested: 1 }, retained: { nested: 2 } });
		const previous = state.value;
		state.replace(BACKGROUND_CONTEXT, { value: { nested: 1 }, retained: { nested: 2 } });
		expect(state.value).toBe(previous);
		state.replace(BACKGROUND_CONTEXT, { ...state.value, value: { nested: 2 } });
		expect(state.value).toEqual({ value: { nested: 2 }, retained: { nested: 2 } });
		expect(state.value.retained).toBe(previous.retained);
	});
});

type SourceValue = Readonly<{ value: number }>;

class TestSource<T> implements ReplicatedStateSource<T> {
	readonly attachments = new Set<TestSourceAttachment<T>>();
	onAttach: (() => void) | undefined;
	#value: T;
	#cursor: number;

	constructor(value: T, cursor = 0) {
		this.#value = value;
		this.#cursor = cursor;
	}

	attach(): ReplicatedStateSourceAttachment<T> {
		const attachment = new TestSourceAttachment(Object.freeze({ value: this.#value, cursor: this.#cursor }), () =>
			this.attachments.delete(attachment),
		);
		this.attachments.add(attachment);
		this.onAttach?.();
		return attachment;
	}

	commit(value: T, ops: readonly Op[], context: Context = BACKGROUND_CONTEXT, cursor = this.#cursor + 1): void {
		this.#value = value;
		this.#cursor = cursor;
		const frame = Object.freeze({ cursor, value, ops, context });
		for (const attachment of [...this.attachments]) attachment.publish(frame);
	}
}

class TestSourceAttachment<T> implements ReplicatedStateSourceAttachment<T> {
	readonly snapshot: { readonly value: T; readonly cursor: number };
	readonly #onDispose: () => void;
	readonly #buffer: ReplicatedStateSourceFrame<T>[] = [];
	#listener: ((frame: ReplicatedStateSourceFrame<T>) => void) | undefined;
	#activated = false;
	#disposed = false;

	constructor(snapshot: { readonly value: T; readonly cursor: number }, onDispose: () => void) {
		this.snapshot = snapshot;
		this.#onDispose = onDispose;
	}

	activate(listener: (frame: ReplicatedStateSourceFrame<T>) => void): void {
		if (this.#activated) throw new Error("attachment is already active");
		this.#activated = true;
		this.#listener = listener;
		for (const frame of this.#buffer.splice(0)) listener(frame);
	}

	publish(frame: ReplicatedStateSourceFrame<T>): void {
		if (this.#disposed) return;
		if (this.#listener === undefined) this.#buffer.push(frame);
		else this.#listener(frame);
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#buffer.length = 0;
		this.#onDispose();
	}
}

describe("authoritative replicated state sources", () => {
	it("captures before activation and drains queued commits in order", () => {
		const initial = Object.freeze({ value: 0 });
		const first = Object.freeze({ value: 1 });
		const second = Object.freeze({ value: 2 });
		const firstOps = Object.freeze([["s", ["value"], 1] as const]);
		const secondOps = Object.freeze([["s", ["value"], 2] as const]);
		const source = new TestSource<SourceValue>(initial, 10);
		source.onAttach = () => {
			source.commit(first, firstOps);
			source.commit(second, secondOps);
		};

		const state = replicatedState(source);
		const deliveries: Array<{ value: SourceValue; sequence: number }> = [];
		state.subscribe((value, _context, delivery) => deliveries.push({ value, sequence: delivery.sequence }));
		expect(state.value).toBe(second);
		expect(deliveries).toEqual([{ value: second, sequence: 2 }]);
		expect(getReplicatedStateInternals(state)?.snapshot()).toEqual({ value: second, sequence: 2 });
	});

	it("hydrates at sequence zero when attaching after existing commits", () => {
		const initial = Object.freeze({ value: 0 });
		const current = Object.freeze({ value: 1 });
		const source = new TestSource<SourceValue>(initial, 40);
		source.commit(current, Object.freeze([["s", ["value"], 1] as const]));
		const state = replicatedState(source);
		const deliveries: number[] = [];
		state.subscribe((_value, _context, delivery) => deliveries.push(delivery.sequence));
		expect(state.value).toBe(current);
		expect(deliveries).toEqual([0]);
	});

	it("publishes exact source value and operation references without applying or re-diffing", () => {
		const source = new TestSource<SourceValue>(Object.freeze({ value: 0 }));
		const state = replicatedState(source);
		const next = Object.freeze({ value: 1 });
		const ops = Object.freeze([["s", ["value"], 1] as const]);
		let publishedOps: readonly Op[] | undefined;
		getReplicatedStateInternals(state)?.subscribe((received) => {
			publishedOps = received;
		});
		let publishedValue: SourceValue | undefined;
		state.subscribe((value, _context, delivery) => {
			if (delivery.kind === "update") publishedValue = value;
		});

		source.commit(next, ops);
		expect(state.value).toBe(next);
		expect(publishedValue).toBe(next);
		expect(publishedOps).toBe(ops);
	});

	it("buffers reentrant frames and skips updates covered by a late hydration", () => {
		const source = new TestSource<SourceValue>(Object.freeze({ value: 0 }));
		const state = replicatedState(source);
		const received: number[] = [];
		const late: Array<{ kind: string; sequence: number; value: number }> = [];
		let nested = false;
		getReplicatedStateInternals(state)?.subscribe((_ops, sequence) => {
			if (sequence !== 1 || nested) return;
			nested = true;
			source.commit(Object.freeze({ value: 2 }), Object.freeze([["s", ["value"], 2] as const]));
			state.subscribe((value, _context, delivery) => late.push({ ...delivery, value: value.value }));
		});
		state.subscribe((value, _context, delivery) => {
			if (delivery.kind === "update") received.push(value.value);
		});

		source.commit(Object.freeze({ value: 1 }), Object.freeze([["s", ["value"], 1] as const]));
		expect(received).toEqual([1, 2]);
		expect(late).toEqual([{ kind: "hydrate", sequence: 2, value: 2 }]);
	});

	it("reports listener failures without throwing them into the source", () => {
		const source = new TestSource<SourceValue>(Object.freeze({ value: 0 }));
		const errors: Error[] = [];
		const state = replicatedState(source, { onError: (error) => errors.push(error) });
		const received: number[] = [];
		state.subscribe((_value, _context, delivery) => {
			if (delivery.kind === "update") throw new Error("listener failed");
		});
		state.subscribe((value, _context, delivery) => {
			if (delivery.kind === "update") received.push(value.value);
		});

		expect(() =>
			source.commit(Object.freeze({ value: 1 }), Object.freeze([["s", ["value"], 1] as const])),
		).not.toThrow();
		source.commit(Object.freeze({ value: 2 }), Object.freeze([["s", ["value"], 2] as const]));
		expect(received).toEqual([1, 2]);
		expect(errors.map((error) => error.message)).toEqual(["listener failed", "listener failed"]);
	});

	it("reports cursor gaps, disposes the broken attachment, and ignores later frames", () => {
		const source = new TestSource<SourceValue>(Object.freeze({ value: 0 }), 5);
		const errors: Error[] = [];
		const state = replicatedState(source, { onError: (error) => errors.push(error) });
		source.commit(Object.freeze({ value: 2 }), Object.freeze([["s", ["value"], 2] as const]), BACKGROUND_CONTEXT, 7);
		expect(errors[0]?.message).toContain("expected 6, received 7");
		expect(source.attachments.size).toBe(0);
		expect(state.value).toEqual({ value: 0 });
		source.commit(Object.freeze({ value: 3 }), Object.freeze([["s", ["value"], 3] as const]), BACKGROUND_CONTEXT, 8);
		expect(state.value).toEqual({ value: 0 });
	});

	it("keeps attachments independent and disposes each idempotently", () => {
		const source = new TestSource<SourceValue>(Object.freeze({ value: 0 }));
		const first = replicatedState(source);
		const second = replicatedState(source);
		expect(source.attachments.size).toBe(2);
		source.commit(Object.freeze({ value: 1 }), Object.freeze([["s", ["value"], 1] as const]));
		expect(first.value.value).toBe(1);
		expect(second.value.value).toBe(1);

		first.dispose();
		first.dispose();
		expect(source.attachments.size).toBe(1);
		source.commit(Object.freeze({ value: 2 }), Object.freeze([["s", ["value"], 2] as const]));
		expect(first.value.value).toBe(1);
		expect(second.value.value).toBe(2);
		second.dispose();
		expect(source.attachments.size).toBe(0);
	});
});

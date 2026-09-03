// ─────────────────────────────────────────────────────────────────────────────
// harness/delta — intent-recording change tracking over plain JSON.
//
// Depends on nothing else in the harness. Session storage, the runtime and the
// facet host consume it; keep the arrows pointing that way.
//
// State is plain TS. You mutate it normally. Ops come out carrying what you
// *did*, not what changed — `text += chunk` yields an append, not a 50 KB
// replacement; `arr.unshift(x)` yields one splice, not O(n) index writes.
// ─────────────────────────────────────────────────────────────────────────────

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export type Seg = string | number;
export type Path = readonly Seg[];

/** Non-empty: `s`/`d`/`a`/`t` cannot target the root. Enforced by the type. */
export type NonEmptyPath = readonly [Seg, ...Seg[]];

/** A path inline on first use, an interned id thereafter. */
export type PathRef<P extends Path = Path> = P | number;

/**
 * Tuples are the form — in memory, on the wire, on disk. There is no keyed
 * variant and no codec between them.
 *
 * `r` is the ONLY op that replaces a whole value. It is an op rather than a
 * frame kind for the same reason `a` and `t` exist: they are specialisations of
 * `s` that are smaller and state intent. It also makes base detection a token
 * comparison rather than a path inspection, which matters because recovery stops
 * at the last base batch — a correctness boundary.
 *
 * Only `p` may target the root, and only because a tracked value can itself be
 * an array. A `p` covering its entire target is normalised at RECORD time to `r`
 * or `s`, so a root `p` is always a partial modification.
 *
 * The two-element forms reuse the previous op's path; arity disambiguates.
 */
export type Op =
  | readonly ["r", JsonValue]
  | readonly ["s", NonEmptyPath, JsonValue]
  | readonly ["d", NonEmptyPath]
  | readonly ["a", NonEmptyPath, string]
  | readonly ["t", NonEmptyPath, number]
  | readonly ["p", Path, number, number, JsonValue[]];

/**
 * What crosses a boundary. Adds path interning and arity omission, and nothing
 * else. `["r", value]` carries no path, so it encodes to itself — which is why
 * `isBase` works on either vocabulary.
 */
export type WireOp =
  | readonly ["r", JsonValue]
  | readonly ["s", PathRef<NonEmptyPath>, JsonValue] | readonly ["s", JsonValue]
  | readonly ["d", PathRef<NonEmptyPath>]            | readonly ["d"]
  | readonly ["a", PathRef<NonEmptyPath>, string]    | readonly ["a", string]
  | readonly ["t", PathRef<NonEmptyPath>, number]    | readonly ["t", number]
  | readonly ["p", PathRef, number, number, JsonValue[]]
  | readonly ["p", number, number, JsonValue[]]
  | readonly ["#", number, Path];

/**
 * There is no frame type. What travels is `Op[]`.
 *
 * A **base batch** is one whose first op is `r`; the first batch of a stream is
 * always one, and storage tags it "base" so recovery can stop there. Sequencing
 * lives on the transport — a list element's `seq`, or an SSE `id:` — never in the
 * payload. See `delta.md` §6.
 */

// ─── Safety ──────────────────────────────────────────────────────────────────

/**
 * Path segments that reach the prototype chain. Rejected at record time AND at
 * apply time, including through an interned id.
 *
 * Reserved as SEGMENTS, not as values: an object with a literal `__proto__` key
 * replicates fine as a whole value; only a path walking through it is refused.
 * That is a real restriction on what is mutable — see `delta.md` §7.1.
 */
export declare const RESERVED_SEGMENTS: ReadonlySet<string>;

export declare class UnsafePathError extends Error {
  readonly segment: Seg;
}

/** Rejects reserved segments, symbol keys, and negative or non-integer indices. */
export declare function assertSafePath(path: Path): void;

/**
 * Rejects anything `JSON.stringify` would not round-trip: Map, Set, Date, RegExp,
 * typed arrays, class instances, functions, BigInt, cycles.
 *
 * `structuredClone` is NOT a JSON check — it clones a Map happily, and the op then
 * carries `{}` while the producer keeps a real Map. Silent divergence.
 */
export declare function assertJsonValue(value: unknown): asserts value is JsonValue;

/**
 * Validate an op's structure before applying it. A decoder must not trust tuple
 * shape: an unvalidated applier spreads a string into an array given
 * `["p",["xs"],0,0,"not-an-array"]`, and writes at the root given a string path.
 *
 * An unknown verb is an error, not a no-op — skipping it is how a newer producer's
 * op vanishes and a replica drifts. This is the CVE-2025-55182 lesson
 * (`delta.md` §7.3).
 */
export declare function assertValidOp(op: unknown): asserts op is Op;

/**
 * The same, for the wire grammar, where ids and short forms are legal.
 * `decode` uses this; `apply` uses `assertValidOp`. Validating a decoded op
 * against the wire grammar is laxer than its type — a two-element `["s", value]`
 * would pass and then be read as a path.
 */
export declare function assertValidWireOp(op: unknown): asserts op is WireOp;

// ─── Classification ─────────────────────────────────────────────────────────
//
// Ops are tuples, so classification is easy to hand-roll and easy to get wrong.
// `op[0] === "s"` is not enough — a set on any path is "s"; what makes a base is
// that it targets the ROOT. And because a tuple may omit the PathRef (arity
// disambiguates), `op[1]` is a PathRef or a value depending on length. These
// exist so nobody writes that comparison twice.

/** True for the `r` op. */
export declare function isReplace(op: Op): boolean;

/**
 * True when this batch begins with `r` — a **base batch**. Exact rather than a
 * heuristic, because flush guarantees `r` appears at index 0 or not at all.
 * Storage tags such elements `"base"` so recovery can stop at the last one.
 */
export declare function isBase(ops: readonly (Op | WireOp)[]): boolean;

// ─── Codec ───────────────────────────────────────────────────────────────────

/**
 * Path interning and arity omission. ONE PAIR PER STREAM — the id table spans a
 * whole subscription or file, so a consumer joining later needs its own.
 *
 * The table resets on a base batch, because a reader replays from the last one
 * with a fresh decoder and everything after it must be self-contained.
 */
export declare function encoder(): { encode(ops: readonly Op[]): WireOp[] };
export declare function decoder(): { decode(wire: readonly WireOp[]): Op[] };

// ─── Tracker ─────────────────────────────────────────────────────────────────

export interface TrackerOptions {
  /**
   * Cap on characters compared when deriving append/truncate from a string
   * write. A window slide's overlap lies near the end, so a cap bounds cost
   * without changing the result. Default 65536; 0 disables detection.
   */
  maxOverlapScan?: number;
  /** Merge compatible adjacent ops on flush. Default true. */
  coalesce?: boolean;
}

export interface Tracker<T extends object> {
  /**
   * Mutate this. Plain TS: assignment, push, splice, delete, all of it.
   *
   * Assigning to it replaces the whole value: emits `["r", next]` and discards
   * ops recorded before it. It must be a SETTER on the tracker — a plain
   * property would be overwritten, swapping the proxy for a plain object and
   * silently ending tracking.
   *
   * To force a base batch without changing the value, call `rebase()`.
   */
  state: T;
  /** The untracked backing object. Reads only — writing here emits nothing. */
  readonly target: T;
  /**
   * Drain. Empty when nothing changed.
   *
   * The FIRST flush is always a base batch, carrying the value including any
   * mutations made before it — a consumer starts with nothing, so a stream must
   * open with something to apply deltas to.
   *
   * Ops that a later op makes unreachable are dropped first — a field written
   * three times emits one op, and a parent replaced after its child emits one.
   * Object key order is not preserved by that pass; see `delta.md` §5.
   */
  flush(): Op[];
  /** Discard without emitting. For a producer that just sent a base batch. */
  discard(): void;
  get dirty(): boolean;
}

export declare function track<T extends object>(root: T, options?: TrackerOptions): Tracker<T>;

// ─── Applier ─────────────────────────────────────────────────────────────────

/**
 * Apply ops to a plain mutable object. Five verbs plus the dictionary entry, no
 * domain knowledge, no library, no registry lookup.
 *
 * Returns the value, because a root set replaces it outright and cannot be done
 * in place. Throws `PathError` when a path does not resolve, which a consumer
 * treats exactly like a sequence gap: request a fresh base frame.
 *
 * Must not be pointed at a value produced by Immer, which deep-freezes.
 */
/**
 * Fold ops into a value and return it — returned rather than mutated in place,
 * because `r` replaces the value outright. Tolerates an `undefined` target,
 * since a root op never reads it, so a consumer needs no base-batch branch.
 *
 * An `r` payload is **adopted, not copied**: the consumer owns the batch it was
 * handed. Do not hand one batch to two in-process consumers, or their replicas
 * will alias.
 */
export declare function apply<T>(target: T, ops: readonly Op[]): T;

export declare class PathError extends Error {
  readonly path: Path;
}

// ─── Replica ─────────────────────────────────────────────────────────────────

export interface Replica<T> {
  /** Current value. `undefined` until the first base frame. */
  readonly value: T | undefined;
  /**
   * Feed one batch, with the sequence number the transport supplied. Returns
   * "gap" when `seq` is not contiguous or a path failed to resolve; the caller
   * then requests a fresh base batch.
   */
  receive(ops: readonly Op[], seq: number): "ok" | "gap";
}

export declare function replica<T>(): Replica<T>;

// ─── Semantics ───────────────────────────────────────────────────────────────
//
// ROOT OPS
//   `["s", [], v]` replaces the value; `["p", [], …]` splices it when the value
//   is an array. The applier must special-case `path.length === 0` before
//   resolving a parent — a prototype handling only a root set threw on the first
//   randomised sequence that produced a root splice.
//
// STRINGS
//   A write of `next` over `prev` derives ops from the longest suffix of `prev`
//   that is a prefix of `next`:
//     overlap === prev.length  ->  append(next.slice(overlap))
//     overlap > 0              ->  truncate(prev.length - overlap) + append(rest)
//     overlap === 0            ->  set(next)
//   Always correct: the overlap is verified, not guessed. This is what makes a
//   rolling window cheap — the case every effect-recording library degrades on.
//
//   Use a native probe, not a hand-written KMP: `indexOf` a short head of `next`
//   in `prev`, verify with `endsWith`. Measured 47x faster over 2000 slides on a
//   50 KB string, verified identical across 200.
//
//   `t` counts UTF-16 code units, matching String.prototype.slice. Not bytes.
//
// ARRAYS
//   Mutator methods are intercepted in the `get` trap, so intent is recorded
//   before the engine performs index writes:
//     push/unshift/pop/shift/splice  ->  one `p`
//     sort/reverse/fill/copyWithin   ->  `s` of the whole array (rare)
//   Direct index writes are honest `s` ops. `a.length = n` is translated —
//   shrink to a splice, grow to a splice of nulls — never emitted as a path,
//   because `length` is not a document location.
//
// TRANSACTIONS
//   Several writes to one address in one commit must each be recorded against
//   the previous one's result, not against pre-transaction state. The applier
//   replays in order; anything else applies the second against a stale base.
//
// ALIASING
//   Op payloads are structured-cloned at record time. Without this a later
//   mutation retroactively changes an already-emitted op and a local replay
//   aliases the source — an observed bug, not a hypothetical.
//
// UNDEFINED
//   `x = undefined` normalises to `d`. JSON has no undefined, and a set with a
//   missing value is indistinguishable from a lost value after a round trip.
//
// SCOPE
//   JsonValue only. No Map, Set, Date, RegExp, class instances, getters, symbol
//   keys, or cycles. That keeps this to five traps and one string algorithm, and
//   makes structuredClone on payloads always safe.

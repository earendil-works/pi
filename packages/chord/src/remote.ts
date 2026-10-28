import { Value } from "typebox/value";
import { HYDRATION, type Hydration } from "./cell.ts";
import { type AnyContract, takesNoArgs } from "./contract.ts";
import { applyImmutable, type Decoder, decoder } from "./delta/index.ts";
import { ChordError, invalid } from "./errors.ts";
import {
	CtxImpl,
	notifyStatus,
	REF_BASE,
	type RefCore,
	type RefOwner,
	raceSignal,
	refsByProxy,
	type StatusListener,
} from "./object.ts";
import type { Ctx, Readable, RefStatus, Shape, StateEvent } from "./types.ts";
import { fromWireError, type RootRef, type WireError } from "./wire.ts";

const noop = (): void => {};

/** One state frame for a member, as the binding receives it (payload unpacked). */
export interface StateIn {
	readonly as: "snap" | "reset" | "ops" | "error";
	readonly value?: unknown;
	readonly ops?: readonly unknown[];
	readonly error?: WireError;
}

/** What a binding needs from the link it is bound to (implemented by Connection). */
export interface RemoteChannel {
	/** Sends a hold for `binding`; `again`: the binding already has values (a re-hold), its unit is not urgent. */
	hold(binding: RemoteBinding, again: boolean): number;
	release(id: number): void;
	call(hold: number, member: string, args: unknown, root: RootRef | undefined, signal: AbortSignal): Promise<unknown>;
	/** Starts (`sub`) or stops (`unsub`) the state of a hold. */
	wantState(hold: number, wanted: boolean): void;
}

/** What a binding needs from its host. */
export interface RemoteHost {
	readonly inFactory: number;
	report(error: unknown): void;
	root<T>(fn: (ctx: Ctx) => T | Promise<T>, options?: { signal?: AbortSignal }): Promise<T>;
	/** The binding has no views left: the host lingers it or closes it. */
	bindingIdle(binding: RemoteBinding): void;
	/** The binding ended or was closed: the host forgets it. */
	forgetBinding(binding: RemoteBinding): void;
}

type Settle = { resolve: () => void; reject: (error: unknown) => void };

function deferred(): { promise: Promise<void> } & Settle {
	let resolve = noop;
	let reject: (error: unknown) => void = noop;
	const promise = new Promise<void>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	promise.catch(noop);
	return { promise, resolve, reject };
}

/** A member's value with the decoder of its current stream. */
interface MemberState {
	value: unknown;
	decoder: Decoder;
}

/**
 * One hold per host and key (type, normalized input, principal key, contract fingerprint), shared by every reference to
 * it: one hold over the link, one stream per state member, calls over the same hold. References are views onto it.
 *
 * A hold implies the state of its variant (unless no view wants state): the provider answers with a unit, the shape
 * followed by a snapshot of each state member the binding lacks. A shape is applied only once all of its snapshots are
 * here, so a live binding always has every state member of its variant. After the first hydration the values stay
 * readable while the binding re-holds (link loss): status `loading`, last values kept.
 */
export class RemoteBinding {
	readonly host: RemoteHost;
	readonly key: string;
	readonly contract: AnyContract;
	readonly at: string;
	readonly input: unknown;
	/** Forwarded principal (omitted for the host's own principal). */
	readonly principal: unknown | undefined;
	/** `ended`: gone with `error`, or closed (no views, no linger). */
	status: "loading" | "live" | "ended" = "loading";
	error: unknown;
	/** The applied shape (kept while re-holding). */
	shape: Shape | undefined;
	/** Every state member of the applied shape has a value (stays true while re-holding). */
	hydrated = false;
	/** The current hold; undefined while resolving the route or after a link loss. */
	hold: { readonly channel: RemoteChannel; readonly id: number } | undefined;
	/** What the provider was told: state for this hold (`state: false` / `sub` / `unsub`). */
	stateOn = false;
	readonly views = new Set<RemoteRef>();
	readonly members = new Map<string, MemberState>();
	/** Lingering since (no views): set by the host. */
	lingerTimer: ReturnType<typeof setTimeout> | undefined;
	readonly #listeners = new Map<string, Set<ViewReadable>>();
	/** A shape waiting for its snapshots. */
	#pending: { shape: Shape; readonly missing: Set<string>; readonly values: Map<string, MemberState> } | undefined;
	/** Resolved while a shape is applied for the current hold (calls wait for it). */
	#live = deferred();
	/** A shape was applied once (a re-hold says `again`). */
	#applied = false;
	/** Waiting for the first hydration (`whenHydrated`). */
	readonly #hydrationWaiters = new Set<Settle>();

	constructor(
		host: RemoteHost,
		fields: { key: string; contract: AnyContract; at: string; input: unknown; principal: unknown | undefined },
	) {
		this.host = host;
		this.key = fields.key;
		this.contract = fields.contract;
		this.at = fields.at;
		this.input = fields.input;
		this.principal = fields.principal;
	}

	get ended(): boolean {
		return this.status === "ended";
	}

	/** Views that want state. */
	get stateViews(): number {
		let count = 0;
		for (const view of this.views) if (view.wantsState) count++;
		return count;
	}

	/** Whether the next hold should carry state: some view wants it, or nobody is left (lingering keeps it). */
	get wantsState(): boolean {
		return this.views.size === 0 ? this.stateOn : this.stateViews > 0;
	}

	/** Whether a re-hold is `again` (the binding already has a shape). */
	get applied(): boolean {
		return this.#applied;
	}

	// ─── views ───

	addView(view: RemoteRef): void {
		this.views.add(view);
		if (this.lingerTimer !== undefined) {
			clearTimeout(this.lingerTimer);
			this.lingerTimer = undefined;
		}
		this.#syncState();
		view.update();
	}

	removeView(view: RemoteRef): void {
		if (!this.views.delete(view)) return;
		for (const set of this.#listeners.values())
			for (const readable of set) if (readable.view === view) set.delete(readable);
		if (this.views.size === 0) {
			this.host.bindingIdle(this);
			return;
		}
		this.#syncState();
	}

	/** Tells the provider to start or stop state when the views' wish changed. */
	#syncState(): void {
		if (this.ended || this.views.size === 0) return;
		const wanted = this.stateViews > 0;
		if (wanted === this.stateOn) return;
		this.stateOn = wanted;
		if (!wanted) {
			this.hydrated = false;
			this.members.clear();
			if (this.#pending !== undefined) this.#pending.missing.clear();
		}
		if (this.hold !== undefined) this.hold.channel.wantState(this.hold.id, wanted);
		for (const view of this.views) view.update();
	}

	listen(name: string, readable: ViewReadable): void {
		let set = this.#listeners.get(name);
		if (set === undefined) {
			set = new Set();
			this.#listeners.set(name, set);
		}
		set.add(readable);
	}

	unlisten(name: string, readable: ViewReadable): void {
		this.#listeners.get(name)?.delete(readable);
	}

	/** Whether `name` is a state member of the applied variant (as the consumer's contract describes it). */
	inVariant(name: string): boolean {
		const variant = this.shape?.variant;
		return variant !== undefined && this.contract.description.variants[variant]?.[name]?.kind === "state";
	}

	/** The members' value as views read it: throws `not_ready` before the first hydration, `not_in_variant` outside it. */
	read(name: string): unknown {
		if (this.status === "ended") throw this.terminalError();
		if (!this.hydrated) throw new ChordError("not_ready", `${this.key}.${name} is not hydrated yet`);
		if (!this.inVariant(name))
			throw new ChordError(
				"not_in_variant",
				`${this.key}: ${name} is not a state member of variant ${this.shape?.variant}`,
			);
		return this.members.get(name)?.value;
	}

	/** Resolves once the binding has its state (rejects if it ends first). */
	whenHydrated(): Promise<void> {
		if (this.hydrated) return Promise.resolve();
		if (this.ended) return Promise.reject(this.terminalError());
		return new Promise<void>((resolve, reject) => this.#hydrationWaiters.add({ resolve, reject }));
	}

	#settleHydration(error?: unknown): void {
		const waiters = [...this.#hydrationWaiters];
		this.#hydrationWaiters.clear();
		for (const waiter of waiters) {
			if (error === undefined) waiter.resolve();
			else waiter.reject(error);
		}
	}

	readable(name: string): boolean {
		return this.status !== "ended" && this.hydrated && this.inVariant(name);
	}

	terminalError(): unknown {
		return this.error ?? new ChordError("released", `reference ${this.key} released`);
	}

	// ─── driven by the host and the link ───

	bound(channel: RemoteChannel, id: number): void {
		this.hold = { channel, id };
		this.stateOn = this.wantsState;
	}

	/** A unit begins: `listed` are the members whose snapshots follow. */
	shaped(shape: Shape, listed: readonly string[]): void {
		if (this.ended) return;
		const previous = this.#pending;
		const missing = new Set<string>(listed);
		// A newer shape before the older one's snapshots (relays may reorder them): wait for both.
		if (previous !== undefined) for (const name of previous.missing) missing.add(name);
		const wanted = new Set(this.#stateMembers(shape));
		for (const name of [...missing]) if (!wanted.has(name) || !this.stateOn) missing.delete(name);
		this.#pending = { shape, missing, values: previous?.values ?? new Map() };
		if (missing.size === 0) this.#apply();
	}

	/** A state frame for member `name` of the current hold. */
	state(name: string, frame: StateIn): void {
		if (this.ended) return;
		if (frame.as === "error") {
			const error = fromWireError(frame.error!);
			// Before the first hydration nobody could read anything: the binding fails instead of waiting forever.
			if (!this.hydrated && this.stateOn) {
				this.gone(error);
				this.close();
			} else this.host.report(error);
			return;
		}
		const pending = this.#pending;
		if (frame.as === "ops") {
			const target = pending?.values.get(name) ?? this.members.get(name);
			if (target === undefined) return;
			const ops = target.decoder.decode(frame.ops ?? []);
			target.value = applyImmutable(target.value, ops);
			if (target === this.members.get(name)) this.#deliver(name, { type: "ops", ops, value: target.value });
			return;
		}
		const fresh: MemberState = { value: frame.value, decoder: decoder() };
		if (pending !== undefined && (pending.missing.has(name) || pending.values.has(name))) {
			pending.values.set(name, fresh);
			pending.missing.delete(name);
			if (pending.missing.size === 0) this.#apply();
			return;
		}
		if (!this.inVariant(name)) return;
		this.members.set(name, fresh);
		this.#deliver(name, { type: "reset", value: fresh.value });
	}

	/** The provider ended the object (or refused the hold): every view is gone. */
	gone(error: unknown): void {
		if (this.ended) return;
		this.status = "ended";
		this.error = error;
		this.hold = undefined;
		this.#pending = undefined;
		this.#live.reject(error);
		this.#settleHydration(error);
		for (const view of [...this.views]) view.end(error);
		this.#listeners.clear();
		this.host.forgetBinding(this);
	}

	/** The link went down but may come back (upstream reconnect): keep the values, wait for the re-hold. */
	detached(): void {
		if (this.ended) return;
		this.hold = undefined;
		this.#pending = undefined;
		if (this.status === "live") {
			this.status = "loading";
			this.#live = deferred();
		}
		for (const view of this.views) view.update();
	}

	/** No views and no linger: releases the hold and forgets the binding. */
	close(): void {
		if (this.lingerTimer !== undefined) clearTimeout(this.lingerTimer);
		this.lingerTimer = undefined;
		if (this.hold !== undefined) this.hold.channel.release(this.hold.id);
		this.hold = undefined;
		if (this.status !== "ended") {
			this.status = "ended";
			const error = new ChordError("released", `reference ${this.key} released`);
			this.#live.reject(error);
			this.#settleHydration(error);
			for (const view of [...this.views]) view.end(error);
		}
		this.#pending = undefined;
		this.#listeners.clear();
		this.host.forgetBinding(this);
	}

	/** Calls `name` over the current hold, waiting for it while the binding (re)holds. */
	async call(name: string, args: unknown, ctx: Ctx): Promise<unknown> {
		for (;;) {
			if (this.ended) throw this.terminalError();
			if (this.status !== "live" || this.hold === undefined) await raceSignal(this.#live.promise, ctx.signal);
			const hold = this.hold;
			if (hold === undefined || this.status !== "live") continue;
			const variant = this.shape?.variant;
			const description = variant === undefined ? undefined : this.contract.description.variants[variant]?.[name];
			if (description?.kind !== "method") {
				throw new ChordError("not_in_variant", `${this.key}: ${name} is not a method of variant ${variant}`);
			}
			// Send only what the consumer's own schema knows (the additive rule's premise; see ObjectImpl.call).
			const sent = description.args === undefined ? undefined : Value.Clean(description.args, Value.Clone(args));
			return hold.channel.call(
				hold.id,
				name,
				sent,
				{ rootId: ctx.rootId, codeVersion: ctx.codeVersion },
				ctx.signal,
			);
		}
	}

	#stateMembers(shape: Shape): string[] {
		const members = shape.variant === undefined ? undefined : this.contract.description.variants[shape.variant];
		if (members === undefined) return [];
		return shape.members.filter((name) => members[name]?.kind === "state");
	}

	/** Applies the pending shape with its snapshots: members outside the variant go, new values are announced. */
	#apply(): void {
		const pending = this.#pending;
		if (pending === undefined) return;
		this.#pending = undefined;
		this.shape = pending.shape;
		const wanted = new Set(this.#stateMembers(pending.shape));
		for (const name of [...this.members.keys()]) if (!wanted.has(name)) this.members.delete(name);
		for (const [name, state] of pending.values) if (wanted.has(name)) this.members.set(name, state);
		this.hydrated = this.stateOn && [...wanted].every((name) => this.members.has(name));
		if (this.hydrated) this.#settleHydration();
		this.status = "live";
		this.#applied = true;
		this.#live.resolve();
		for (const view of this.views) view.update();
		for (const [name, state] of pending.values) {
			if (wanted.has(name)) this.#deliver(name, { type: "reset", value: state.value });
		}
		for (const view of [...this.views]) view.shapeChanged();
	}

	#deliver(name: string, event: StateEvent<unknown>): void {
		const readables = this.#listeners.get(name);
		if (readables === undefined) return;
		for (const readable of [...readables]) readable.deliver(event);
	}
}

/**
 * A state member of a remote reference: the binding's value. Reading throws `not_ready` before the first hydration and
 * `not_in_variant` outside the variant. A listener added before the hydration gets its snapshot then.
 */
class ViewReadable implements Readable<unknown> {
	readonly view: RemoteRef;
	readonly #name: string;
	readonly #values = new Set<(value: unknown) => void>();
	readonly #events = new Set<(event: StateEvent<unknown>) => void>();
	/** Event listeners that have not had their snapshot yet. */
	readonly #unseen = new Set<(event: StateEvent<unknown>) => void>();

	constructor(view: RemoteRef, name: string) {
		this.view = view;
		this.#name = name;
	}

	get value(): unknown {
		if (this.view.ended) throw this.view.terminalError();
		return this.view.binding.read(this.#name);
	}

	/** Not hydrated before the binding's first snapshots (a local object forwarding this member waits for them). */
	get [HYDRATION](): Hydration | undefined {
		const binding = this.view.binding;
		if (binding.hydrated) return undefined;
		return { hydrated: false, whenHydrated: () => binding.whenHydrated() };
	}

	subscribe(listener: (value: unknown) => void): () => void {
		this.#values.add(listener);
		this.#attach();
		if (this.#readable()) this.#safe(() => listener(this.view.binding.members.get(this.#name)?.value));
		return () => this.#remove(this.#values, listener);
	}

	events(listener: (event: StateEvent<unknown>) => void): () => void {
		this.#events.add(listener);
		this.#attach();
		if (this.#readable()) {
			const value = this.view.binding.members.get(this.#name)?.value;
			this.#safe(() => listener({ type: "snap", value }));
		} else this.#unseen.add(listener);
		return () => {
			this.#unseen.delete(listener);
			this.#remove(this.#events, listener);
		};
	}

	deliver(event: StateEvent<unknown>): void {
		for (const listener of [...this.#events]) {
			if (!this.#unseen.delete(listener)) this.#safe(() => listener(event));
			else if (event.type !== "ops") this.#safe(() => listener({ type: "snap", value: event.value }));
		}
		for (const listener of [...this.#values]) this.#safe(() => listener(event.value));
	}

	stop(): void {
		this.#values.clear();
		this.#events.clear();
		this.#unseen.clear();
		this.view.binding.unlisten(this.#name, this);
	}

	#readable(): boolean {
		return !this.view.ended && this.view.binding.readable(this.#name);
	}

	#attach(): void {
		if (!this.view.ended) this.view.binding.listen(this.#name, this);
	}

	#remove<T>(set: Set<T>, listener: T): void {
		set.delete(listener);
		if (this.#values.size + this.#events.size === 0) this.view.binding.unlisten(this.#name, this);
	}

	#safe(fn: () => void): void {
		try {
			fn();
		} catch (error) {
			this.view.binding.host.report(error);
		}
	}
}

/**
 * A reference to an object on another host: a view onto the host's shared binding for its key. Each view has its own
 * owner, status, observers and `release`; ending by the provider and re-holding belong to the binding.
 */
export class RemoteRef implements RefCore {
	readonly object = undefined;
	readonly binding: RemoteBinding;
	readonly owner: RefOwner;
	/** False: a method-only view (`state: false`), ready once live. */
	readonly wantsState: boolean;
	readonly proxy: object;
	readonly ready: Promise<void>;
	status: RefStatus = "loading";
	error: unknown;
	readonly shapeListeners = new Set<(shape: Shape) => void>();
	readonly #statusListeners = new Set<StatusListener>();
	readonly #readables = new Map<string, ViewReadable>();
	readonly #callers = new Map<string, (...given: unknown[]) => Promise<unknown>>();
	#settleReady: Settle | undefined;

	constructor(binding: RemoteBinding, owner: RefOwner, wantsState: boolean) {
		this.binding = binding;
		this.owner = owner;
		this.wantsState = wantsState;
		const ready = deferred();
		this.ready = ready.promise;
		this.#settleReady = ready;
		this.proxy = new Proxy(this, {
			get: (target, property) => {
				if (REF_BASE.has(property)) {
					const value: unknown = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				}
				if (typeof property !== "string" || property === "then") return undefined;
				return target.member(property);
			},
		});
		refsByProxy.set(this.proxy, this);
	}

	get contract(): AnyContract {
		return this.binding.contract;
	}

	get address(): string {
		return this.binding.key;
	}

	get ended(): boolean {
		return this.status === "released" || this.status === "gone";
	}

	get variant(): string | undefined {
		return this.binding.shape?.variant;
	}

	get shape(): Shape | undefined {
		return this.binding.shape;
	}

	onShape(listener: (shape: Shape) => void): () => void {
		this.shapeListeners.add(listener);
		return () => this.shapeListeners.delete(listener);
	}

	onStatus(listener: StatusListener): () => void {
		this.#statusListeners.add(listener);
		return () => this.#statusListeners.delete(listener);
	}

	terminalError(): unknown {
		return this.status === "gone" ? this.error : new ChordError("released", `reference ${this.address} released`);
	}

	release(): void {
		if (this.ended) return;
		this.status = "released";
		this.#notify();
		this.#settleReady?.reject(new ChordError("released", `reference ${this.address} released`));
		this.#settleReady = undefined;
		for (const readable of this.#readables.values()) readable.stop();
		this.binding.removeView(this);
	}

	// ─── driven by the binding ───

	/** Follows the binding: live once it has a shape (and, for a state view, its state) over a current hold. */
	update(): void {
		if (this.ended) return;
		const binding = this.binding;
		const live = binding.status === "live" && binding.hold !== undefined && (!this.wantsState || binding.hydrated);
		const next: RefStatus = live ? "live" : "loading";
		if (next === this.status) return;
		this.status = next;
		this.#notify();
		if (live) {
			this.#settleReady?.resolve();
			this.#settleReady = undefined;
		}
	}

	end(error: unknown): void {
		if (this.ended) return;
		const released = error instanceof ChordError && error.code === "released";
		this.status = released ? "released" : "gone";
		if (!released) this.error = error;
		this.#notify();
		this.#settleReady?.reject(error);
		this.#settleReady = undefined;
		for (const readable of this.#readables.values()) readable.stop();
	}

	shapeChanged(): void {
		const shape = this.binding.shape;
		if (shape === undefined || this.ended) return;
		for (const listener of [...this.shapeListeners]) {
			try {
				listener(shape);
			} catch (error) {
				this.binding.host.report(error);
			}
		}
	}

	#notify(): void {
		notifyStatus(this.#statusListeners, this.status, this.error, (error) => this.binding.host.report(error));
	}

	// ─── members ───

	member(name: string): unknown {
		const description = Object.values(this.contract.description.variants)
			.map((members) => members[name])
			.find((member) => member !== undefined);
		if (description?.kind === "method") return this.#caller(name);
		if (description?.kind === "state") {
			let readable = this.#readables.get(name);
			if (readable === undefined) {
				readable = new ViewReadable(this, name);
				this.#readables.set(name, readable);
			}
			return readable;
		}
		return undefined;
	}

	#caller(name: string): (...given: unknown[]) => Promise<unknown> {
		let caller = this.#callers.get(name);
		if (caller === undefined) {
			const noArgs = takesNoArgs(this.contract, name);
			caller = (...given) => {
				// A method without arguments is called as `ref.name(ctx)`.
				const [args, ctx] = (noArgs ? [undefined, given[0]] : given) as [unknown, Ctx | undefined];
				const host = this.binding.host;
				if (host.inFactory > 0)
					throw new ChordError("not_ready", `${this.address}.${name} called inside a factory`);
				// The same checks as a local reference's caller (RefImpl.caller and ObjectImpl.call): a ctx from another host
				// or one not made by Chord would carry a root this host does not own over its link.
				if (ctx !== undefined && !(ctx instanceof CtxImpl)) {
					return Promise.reject(invalid("foreign_ctx", "ctx must come from a Chord host"));
				}
				try {
					ctx?.check(host);
				} catch (error) {
					return Promise.reject(error);
				}
				if (ctx === undefined || ctx.holder) {
					return host.root((root) => this.#call(name, args, root), { signal: ctx?.signal });
				}
				return this.#call(name, args, ctx);
			};
			this.#callers.set(name, caller);
		}
		return caller;
	}

	#call(name: string, args: unknown, ctx: Ctx): Promise<unknown> {
		if (this.ended) return Promise.reject(this.terminalError());
		return this.binding.call(name, args, ctx);
	}
}

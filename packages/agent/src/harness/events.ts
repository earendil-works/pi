import type { EventListener, Events, HarnessEvent, HarnessEventType, WatchHandle } from "./agent-harness.ts";
import type { Context } from "./context.ts";

type UntypedEventListener = (event: HarnessEvent, context: Context) => void | Promise<void>;
type ResnapshotCapture<T> = (context: Context, markBoundary: () => void) => Promise<T>;

/** Passive harness event bus with isolated handler failures. */
export class HarnessEventBus implements Events {
	private readonly listeners = new Map<HarnessEventType, Set<UntypedEventListener>>();
	private readonly watchListeners = new Set<UntypedEventListener>();
	private deliveryTail: Promise<void> = Promise.resolve();
	private closedError: Error | undefined;

	on<TType extends HarnessEventType>(
		type: TType,
		listener: EventListener<Extract<HarnessEvent, { type: TType }>>,
	): () => void {
		if (this.closedError !== undefined) throw this.closedError;
		const wrapped: UntypedEventListener = (event, context) =>
			listener(event as Extract<HarnessEvent, { type: TType }>, context);
		let listeners = this.listeners.get(type);
		if (listeners === undefined) {
			listeners = new Set();
			this.listeners.set(type, listeners);
		}
		listeners.add(wrapped);
		return () => listeners?.delete(wrapped);
	}

	emit(event: HarnessEvent, context: Context): Promise<void> {
		return this.emitBatch([event], context);
	}

	/** Bind current recipients and append one contiguous batch to the global delivery tail. */
	emitBatch(events: readonly HarnessEvent[], context: Context): Promise<void> {
		if (this.closedError !== undefined || events.length === 0) return Promise.resolve();
		const bound = events.map((event) => {
			const payload = structuredClone(event);
			return { payload, recipients: this.snapshotRecipients(payload) };
		});
		const delivery = this.deliveryTail.then(async () => {
			for (const { payload, recipients } of bound) await this.deliver(payload, recipients, true, context);
		});
		this.deliveryTail = delivery.catch(() => {});
		return delivery;
	}

	watch<T>(
		snapshot: T,
		filter: (event: HarnessEvent) => boolean,
		_context: Context,
		resnapshot?: ResnapshotCapture<T>,
	): WatchHandle<T> {
		if (this.closedError !== undefined) throw this.closedError;
		return this.installWatcher(snapshot, filter, resnapshot);
	}

	async watchFromSnapshot<T>(
		capture: (context: Context) => Promise<T>,
		filter: (event: HarnessEvent) => boolean,
		context: Context,
	): Promise<WatchHandle<T>> {
		if (this.closedError !== undefined) throw this.closedError;
		const watcher = this.installWatcher<T>(undefined, filter, async (captureContext, markBoundary) => {
			const snapshot = await capture(captureContext);
			markBoundary();
			return snapshot;
		});
		try {
			watcher.setSnapshot(await capture(context));
			return watcher;
		} catch (error) {
			watcher.unsubscribe();
			throw error;
		}
	}

	close(error: Error): void {
		this.closedError ??= error;
		void this.deliveryTail.finally(() => {
			this.listeners.clear();
			this.watchListeners.clear();
		});
	}

	private installWatcher<T>(
		snapshot: T | undefined,
		filter: (event: HarnessEvent) => boolean,
		resnapshot: ResnapshotCapture<T> | undefined,
	): BufferedEventWatcher<T> {
		let watcher!: BufferedEventWatcher<T>;
		const capture =
			resnapshot === undefined
				? undefined
				: async (context: Context) => {
						let marked = false;
						const next = await resnapshot(context, () => {
							if (marked) throw new Error("Resnapshot boundary was already marked");
							marked = true;
							this.enqueueBarrier(() => watcher.markResnapshotBoundary());
						});
						if (!marked) throw new Error("Resnapshot capture did not mark its boundary");
						return next;
					};
		watcher = new BufferedEventWatcher(snapshot, capture, async (error, event, context) => {
			if (event.type === "handler_error") return;
			const normalized = error instanceof Error ? error : new Error(String(error));
			const lane = "lane" in event && typeof event.lane === "string" ? event.lane : undefined;
			await this.emit(
				{
					type: "handler_error",
					kind: "event",
					event: event.type,
					error: normalized.message,
					...(normalized.stack === undefined ? {} : { stack: normalized.stack }),
					...(lane === undefined ? {} : { lane }),
				},
				context,
			);
		});
		const watchListener: UntypedEventListener = (event, context) => {
			if (filter(event)) watcher.push(event, context);
		};
		this.watchListeners.add(watchListener);
		watcher.setUnsubscribe(() => this.watchListeners.delete(watchListener));
		return watcher;
	}

	private enqueueBarrier(barrier: () => void): void {
		const delivery = this.deliveryTail.then(barrier);
		this.deliveryTail = delivery.catch(() => {});
	}

	private snapshotRecipients(event: HarnessEvent): UntypedEventListener[] {
		return [...(this.listeners.get(event.type) ?? []), ...this.watchListeners];
	}

	private async deliver(
		event: HarnessEvent,
		recipients: readonly UntypedEventListener[],
		reportErrors: boolean,
		context: Context,
	): Promise<void> {
		for (const listener of recipients) {
			try {
				await listener(structuredClone(event), context);
			} catch (error) {
				if (!reportErrors || event.type === "handler_error") continue;
				const normalized = error instanceof Error ? error : new Error(String(error));
				const lane = "lane" in event && typeof event.lane === "string" ? event.lane : undefined;
				const handlerError: HarnessEvent = {
					type: "handler_error",
					kind: "event",
					event: event.type,
					error: normalized.message,
					...(normalized.stack === undefined ? {} : { stack: normalized.stack }),
					...(lane === undefined ? {} : { lane }),
				};
				await this.deliver(handlerError, this.snapshotRecipients(handlerError), false, context);
			}
		}
	}
}

class BufferedEventWatcher<T> implements WatchHandle<T> {
	snapshot: T;
	private readonly resnapshotCallback: ((context: Context) => Promise<T>) | undefined;
	private readonly onError: (error: unknown, event: HarnessEvent, context: Context) => void | Promise<void>;
	private buffer: Array<{ event: HarnessEvent; context: Context; epoch: number }> = [];
	private listener: EventListener | undefined;
	private unsubscribeCallback: (() => void) | undefined;
	private deliveryTail: Promise<void> = Promise.resolve();
	private epoch = 0;
	private resnapshotState:
		| {
				phase: "dropping" | "holding";
				held: Array<{ event: HarnessEvent; context: Context }>;
				reached: Promise<void>;
				resolveReached: () => void;
		  }
		| undefined;
	private state: "buffering" | "started" | "unsubscribed" = "buffering";

	constructor(
		snapshot: T | undefined,
		resnapshot: ((context: Context) => Promise<T>) | undefined,
		onError: (error: unknown, event: HarnessEvent, context: Context) => void | Promise<void>,
	) {
		this.snapshot = snapshot as T;
		this.resnapshotCallback = resnapshot;
		this.onError = onError;
	}

	setSnapshot(snapshot: T): void {
		this.snapshot = snapshot;
	}

	start(listener: EventListener): void {
		if (this.state !== "buffering") throw new Error("WatchHandle.start() may be called only once");
		this.state = "started";
		this.listener = listener;
		const buffered = this.buffer;
		this.buffer = [];
		for (const bufferedEvent of buffered) {
			this.enqueue(bufferedEvent.event, bufferedEvent.context, bufferedEvent.epoch);
		}
	}

	async resnapshot(context: Context): Promise<T> {
		if (this.state === "unsubscribed") throw new Error("WatchHandle is unsubscribed");
		if (this.resnapshotCallback === undefined) throw new Error("WatchHandle does not support resnapshot");
		if (this.resnapshotState !== undefined) throw new Error("WatchHandle resnapshot is already in progress");
		let resolveReached!: () => void;
		const reached = new Promise<void>((resolve) => {
			resolveReached = resolve;
		});
		const resnapshotState = {
			phase: "dropping" as const,
			held: [] as Array<{ event: HarnessEvent; context: Context }>,
			reached,
			resolveReached,
		};
		this.epoch++;
		this.resnapshotState = resnapshotState;
		try {
			const snapshot = await this.resnapshotCallback(context);
			await reached;
			this.snapshot = snapshot;
			this.resnapshotState = undefined;
			for (const held of resnapshotState.held) this.push(held.event, held.context);
			return snapshot;
		} catch (error) {
			this.resnapshotState = undefined;
			for (const held of resnapshotState.held) this.push(held.event, held.context);
			throw error;
		}
	}

	markResnapshotBoundary(): void {
		const resnapshot = this.resnapshotState;
		if (resnapshot === undefined || resnapshot.phase !== "dropping") return;
		resnapshot.phase = "holding";
		resnapshot.resolveReached();
	}

	unsubscribe(): void {
		if (this.state === "unsubscribed") return;
		this.state = "unsubscribed";
		this.buffer = [];
		this.listener = undefined;
		this.unsubscribeCallback?.();
		this.unsubscribeCallback = undefined;
	}

	push(event: HarnessEvent, context: Context): void {
		if (this.state === "unsubscribed") return;
		if (this.resnapshotState?.phase === "dropping") return;
		if (this.resnapshotState?.phase === "holding") {
			this.resnapshotState.held.push({ event, context });
			return;
		}
		if (this.state === "buffering") {
			this.buffer.push({ event, context, epoch: this.epoch });
			return;
		}
		this.enqueue(event, context, this.epoch);
	}

	setUnsubscribe(callback: () => void): void {
		this.unsubscribeCallback = callback;
	}

	private enqueue(event: HarnessEvent, context: Context, epoch: number): void {
		const listener = this.listener;
		if (listener === undefined) return;
		this.deliveryTail = this.deliveryTail
			.then(async () => {
				if (this.state === "started" && epoch === this.epoch) await listener(event, context);
			})
			.catch(async (error) => {
				try {
					await this.onError(error, event, context);
				} catch {}
			});
	}
}

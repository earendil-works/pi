/**
 * Worker-side implementation of the `Lane` service.
 *
 * The lane, harness, and model registry stay here. Each presentation gets its own `lane.watch()`,
 * whose snapshot and event stream the harness already pairs with no gap and no duplicate, so nothing
 * here re-implements that alignment: a subscription is just a watch handle plus an id.
 */

import { randomUUID } from "node:crypto";
import type { AgentLane, Context, HarnessEvent, LaneSnapshot, WatchHandle } from "@earendil-works/pi-agent-core";
import type { Models } from "@earendil-works/pi-ai";
import type {
	CommandResult,
	LaneServiceApi,
	LaneSubscription,
	ModelRef,
	ModelsState,
	SessionSnapshot,
} from "../shared/protocol.ts";

export interface LaneServiceOptions {
	lane: AgentLane;
	models: Models;
	context: Context;
	session: { id: string; cwd: string; path: string };
	/** Model catalog state belongs to the `Models` service; the snapshot carries a copy. */
	modelsState: () => ModelsState;
	publish: (subscriptionId: string, to: string, event: HarnessEvent) => void;
}

export class LaneService implements LaneServiceApi {
	readonly #options: LaneServiceOptions;
	readonly #watches = new Map<string, { handle: WatchHandle<LaneSnapshot>; to: string }>();

	constructor(options: LaneServiceOptions) {
		this.#options = options;
	}

	/** Capture a snapshot. The harness buffers this subscription's events until `start`. */
	async watch(presentationId: string): Promise<LaneSubscription> {
		const { lane, context, session } = this.#options;
		const subscriptionId = randomUUID();
		const handle = await lane.watch(context);
		try {
			this.#watches.set(subscriptionId, { handle, to: presentationId });
			const snapshot: SessionSnapshot = {
				sessionId: session.id,
				cwd: session.cwd,
				sessionPath: session.path,
				lane: handle.snapshot,
				models: this.#options.modelsState(),
			};
			return { subscriptionId, snapshot };
		} catch (error) {
			// A watcher that is never started buffers without bound.
			handle.unsubscribe();
			throw error;
		}
	}

	/** Begin delivery, draining what buffered since the snapshot. */
	async start(subscriptionId: string): Promise<void> {
		const watch = this.#watches.get(subscriptionId);
		if (!watch) throw new Error(`Unknown subscription: ${subscriptionId}`);
		watch.handle.start((event) => this.#options.publish(subscriptionId, watch.to, event));
	}

	async unwatch(subscriptionId: string): Promise<void> {
		this.#watches.get(subscriptionId)?.handle.unsubscribe();
		this.#watches.delete(subscriptionId);
	}

	prompt(text: string): Promise<CommandResult> {
		return this.#command(() => this.#options.lane.prompt(text, undefined, this.#options.context));
	}

	steer(text: string): Promise<CommandResult> {
		return this.#command(() => this.#options.lane.steer(text, undefined, this.#options.context));
	}

	followUp(text: string): Promise<CommandResult> {
		return this.#command(() => this.#options.lane.followUp(text, undefined, this.#options.context));
	}

	compact(): Promise<CommandResult> {
		return this.#command(() => this.#options.lane.compact(undefined, this.#options.context));
	}

	abort(): Promise<CommandResult> {
		return this.#command(() => this.#options.lane.abort(this.#options.context));
	}

	/**
	 * The lane stores a durable identity, so the ref passes straight through. The registry lookup is
	 * only a courtesy: an identity this worker cannot serve fails at generation time otherwise.
	 */
	async setModel(ref: ModelRef): Promise<CommandResult> {
		if (!this.#options.models.getModel(ref.provider, ref.modelId)) {
			return { ok: false, error: `Unknown model: ${ref.provider}/${ref.modelId}` };
		}
		try {
			await this.#options.lane.setModel(ref, this.#options.context);
			return { ok: true };
		} catch (error) {
			return { ok: false, error: message(error) };
		}
	}

	close(): void {
		for (const watch of this.#watches.values()) watch.handle.unsubscribe();
		this.#watches.clear();
	}

	async #command(run: () => Promise<{ ok: boolean; error?: { message: string } }>): Promise<CommandResult> {
		try {
			const result = await run();
			return result.ok ? { ok: true } : { ok: false, error: result.error?.message ?? "Command failed" };
		} catch (error) {
			return { ok: false, error: message(error) };
		}
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

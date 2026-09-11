import { defineFacet, type Facet, type MutableReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type AgentLane,
	type HarnessEvent,
	type LaneSnapshot,
	type LaneTranscriptSnapshot,
	type LaneWatchEvent,
	reduceLaneSnapshot,
	type WatchHandle,
} from "@earendil-works/pi-agent-core";
import { Transcript, type Transcript as TranscriptService, type TranscriptState } from "./transcript.ts";

interface TranscriptRuntime {
	readonly service: TranscriptService;
	activate(): Promise<void>;
	dispose(): Promise<void>;
}

export function createTranscriptService(
	lane: AgentLane,
	createState: (initial: TranscriptState) => MutableReplicatedState<TranscriptState>,
): TranscriptRuntime {
	const state = createState({ snapshot: null, event: null });
	let watch: WatchHandle<LaneSnapshot> | undefined;
	let rebase: Promise<void> | undefined;
	let rebaseError: Error | undefined;

	const publishSnapshot = (
		next: LaneSnapshot,
		event: LaneWatchEvent | null,
		context: Parameters<typeof state.publish>[0],
	): void => {
		state.state.snapshot = next as LaneTranscriptSnapshot;
		state.state.event = event;
		state.publish(context);
	};

	const scheduleRebase = (context: Parameters<typeof state.publish>[0]): void => {
		if (rebase !== undefined) return;
		const activeWatch = watch;
		if (activeWatch === undefined) return;
		const pending = (async () => {
			const refreshed = await activeWatch.resnapshot(context);
			publishSnapshot(refreshed, null, context);
		})();
		rebase = pending;
		void pending.then(
			() => {
				if (rebase === pending) rebase = undefined;
			},
			(error: unknown) => {
				rebaseError = error instanceof Error ? error : new Error(String(error));
				if (rebase === pending) rebase = undefined;
			},
		);
	};

	const onEvent = (event: HarnessEvent, context: Parameters<typeof state.publish>[0]): void => {
		if (rebaseError !== undefined) throw rebaseError;
		const forwarded = toLaneWatchEvent(event);
		if (forwarded === undefined) return;
		const snapshot = state.state.snapshot;
		if (snapshot === null) throw new Error("Transcript service is not active");
		if (reduceLaneSnapshot(snapshot, event) === "rebase") scheduleRebase(context);
		state.state.event = forwarded;
		state.publish(context);
	};

	return {
		service: { state },
		async activate() {
			if (watch !== undefined) throw new Error("Transcript service is already active");
			const opened = await lane.watch(BACKGROUND_CONTEXT);
			watch = opened;
			publishSnapshot(opened.snapshot, null, BACKGROUND_CONTEXT);
			opened.start(onEvent);
		},
		async dispose() {
			let failure: unknown;
			try {
				await rebase;
			} catch (error) {
				failure = error;
			}
			watch?.unsubscribe();
			watch = undefined;
			if (failure !== undefined) throw failure;
		},
	};
}

export function createTranscriptServiceFacet(lane: AgentLane): Facet {
	return defineFacet({
		id: "@pi/transcript",
		setup(env) {
			const runtime = createTranscriptService(lane, env.replicatedState);
			env.provide(Transcript, runtime.service);
			env.onActivate(() => runtime.activate());
			env.own(() => runtime.dispose());
		},
	});
}

function toLaneWatchEvent(event: HarnessEvent): LaneWatchEvent | undefined {
	switch (event.type) {
		case "handler_error":
		case "turn_start":
		case "turn_end":
		case "value_update":
		case "lane_created":
			return undefined;
		case "config_update":
			if (event.property !== "model" && event.property !== "thinkingLevel" && event.property !== "activeTools") {
				return undefined;
			}
			return event as LaneWatchEvent;
		case "message_update": {
			if (event.message.role !== "assistant") {
				throw new TypeError("Harness message_update did not carry an assistant message");
			}
			const { event: _providerEvent, ...update } = event;
			return update as LaneWatchEvent;
		}
		default:
			return event as LaneWatchEvent;
	}
}

// The view `TranscriptView`: a session's conversation. It holds the session's `Transcript` (the worker's one object
// per conversation, starting the worker), shows the window of entries with "Load earlier" before it and the running
// answer after it, and for writers the composer. Kept at the bottom while the reader is there.

import { Button } from "@earendil-works/elanor-react";
import { type RefState, Transcript } from "@earendil-works/p3/v1";
import { useHold, useRefState, useVariant, useWatch } from "@earendil-works/p3/v1/web";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import { useLayoutEffect, useMemo, useRef } from "react";
import { Composer } from "./composer.tsx";
import { type EntriesReader, useEarlier } from "./earlier.ts";
import { Entries } from "./entries.tsx";
import styles from "./transcript-pane.module.css";

/** Session `session`'s conversation, as the caller may see it (readers) and write to it (writers). */
export function TranscriptPane(props: { readonly session: string }) {
	const ref = useHold(Transcript, { session: props.session });
	const writer = useVariant(ref, "writer");
	const reader = useVariant(ref, "reader");
	const state = useRefState(ref);
	const live = writer ?? reader;
	// The worker sends Durable's conversation view as it is (`null` until it arrived).
	const view = (useWatch(live?.view) ?? undefined) as ConversationView | null | undefined;
	// Its items are Durable's entries, as the worker read them.
	const read = useMemo<EntriesReader | undefined>(
		() => (live === undefined ? undefined : (query, ctx) => live.entries(query, ctx) as ReturnType<EntriesReader>),
		[live],
	);
	const earlier = useEarlier(read, view ?? undefined);
	const scroller = useStickToBottom(view);
	if (state?.kind === "failed" && state.cause.kind === "denied") {
		return <p className={styles.note}>You have no access to this session.</p>;
	}
	if (state?.kind === "ended") return <p className={styles.note}>This conversation ended.</p>;
	// The window's documents are Durable's built-in ones; `pi.live` is the live state.
	const liveState = (view?.docs["pi.live"] ?? {}) as LiveState;
	return (
		<div className={styles.pane} data-transcript={live?.variant ?? "loading"}>
			<div className={styles.scroll} onScroll={scroller.onScroll} ref={scroller.ref}>
				{earlier.more ? (
					<Button
						className={styles.earlier}
						data-load-earlier=""
						density="compact"
						hierarchy="tertiary"
						onClick={earlier.load}
						pending={earlier.loading}
					>
						Load earlier
					</Button>
				) : null}
				{earlier.error === undefined ? null : <p className={styles.error}>{earlier.error}</p>}
				{view === undefined || view === null ? (
					<p className={styles.note}>{waiting(state)}</p>
				) : view.entries.length === 0 && earlier.entries.length === 0 && liveState.run === undefined ? (
					<p className={styles.note} data-empty="">
						Nothing here yet.
					</p>
				) : (
					<Entries entries={[...earlier.entries, ...view.entries]} live={liveState} />
				)}
			</div>
			{writer === undefined ? null : (
				<Composer
					send={(message, ctx) => writer.send(message, ctx)}
					stop={(ctx) => writer.stop(ctx)}
					working={liveState.run !== undefined}
				/>
			)}
		</div>
	);
}

/** What the pane says while it has no view: loading, the session's failure, or a retry under way. */
function waiting(state: RefState | undefined): string {
	if (state?.kind !== "failed") return "Loading…";
	if (state.cause.kind === "broken") return `This session cannot be opened: ${state.cause.error.message}`;
	return "Reconnecting…";
}

/** How close to the end (in pixels) counts as at the end. */
const NEAR_END = 48;

/**
 * Keeps the scroller at its end while the reader is there: each new `view` scrolls down unless the reader scrolled
 * up. Read in a layout effect, before the browser paints the new entries.
 */
function useStickToBottom(view: unknown) {
	const ref = useRef<HTMLDivElement>(null);
	const atEnd = useRef(true);
	useLayoutEffect(() => {
		const element = ref.current;
		if (element !== null && atEnd.current && view !== undefined) element.scrollTop = element.scrollHeight;
	}, [view]);
	return {
		ref,
		onScroll: () => {
			const element = ref.current;
			if (element !== null) {
				atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_END;
			}
		},
	};
}

// The transcript pane of a session's view: a session's conversation. It holds the session's `Transcript` (the worker's
// one object per conversation, starting the worker), shows the window of entries with "Load earlier" before it and the
// running answer after it (Read), and the composer (Send; its stop button with Stop). Kept at the bottom while the
// reader is there.

import { Button } from "@earendil-works/elanor-react";
import {
	type Context,
	Me,
	type MessagesOf,
	type RefState,
	Transcript,
	type Translator,
	withGranted,
} from "@earendil-works/p3/v1";
import type { ConversationView, LiveState } from "@earendil-works/p3/v1/web";
import { useHold, useLive, useMessages, useRefState, useWatch } from "@earendil-works/p3/v1/web";
import { useLayoutEffect, useMemo, useRef } from "react";
import { Composer } from "./composer.tsx";
import { type EntriesReader, useEarlier } from "./earlier.ts";
import { Entries } from "./entries.tsx";
import { messages } from "./messages.ts";
import styles from "./transcript-pane.module.css";

/** Session `session`'s conversation, as the caller's ticks on the session let them read it, send and stop. */
export function TranscriptPane(props: { readonly session: string }) {
	const ref = useHold(Transcript, { session: props.session });
	const live = useLive(ref);
	const reader = withGranted(live, "view", "entries");
	const sender = withGranted(live, "send");
	const stopper = withGranted(live, "stop");
	const state = useRefState(ref);
	// The worker sends Durable's conversation view as it is (`null` until it arrived).
	const view = (useWatch(reader?.view) ?? undefined) as ConversationView | null | undefined;
	// Its items are Durable's entries, as the worker read them.
	const read = useMemo<EntriesReader | undefined>(
		() =>
			reader === undefined ? undefined : (query, ctx) => reader.entries(query, ctx) as ReturnType<EntriesReader>,
		[reader],
	);
	const earlier = useEarlier(read, view ?? undefined);
	const scroller = useStickToBottom(view);
	const { t } = useMessages(messages);
	const me = useWatch(useLive(useHold(Me, {}))?.me);
	if (state?.kind === "failed" && state.cause.kind === "denied") return <p className={styles.note}>{t("denied")}</p>;
	if (state?.kind === "ended") return <p className={styles.note}>{t("ended")}</p>;
	// The window's documents are Durable's built-in ones; `pi.live` is the live state.
	const liveState = (view?.docs["pi.live"] ?? {}) as LiveState;
	return (
		<div
			className={styles.pane}
			data-transcript={live === undefined ? "loading" : sender === undefined ? "reader" : "writer"}
		>
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
						{t("loadEarlier")}
					</Button>
				) : null}
				{earlier.error === undefined ? null : <p className={styles.error}>{earlier.error}</p>}
				{reader === undefined && live !== undefined ? null : view === undefined || view === null ? (
					<p className={styles.note}>{waiting(state, t)}</p>
				) : view.entries.length === 0 && earlier.entries.length === 0 && liveState.run === undefined ? (
					<p className={styles.note} data-empty="">
						{t("empty")}
					</p>
				) : (
					<Entries entries={[...earlier.entries, ...view.entries]} live={liveState} />
				)}
			</div>
			{sender === undefined ? null : (
				<Composer
					// The draft is the person's, per session: kept in page state through a reload of this plugin.
					draft={`transcript.draft.${me?.kind === "person" ? me.id : ""}.${props.session}`}
					send={(message, ctx) => sender.send(message, ctx)}
					{...(stopper === undefined ? {} : { stop: (ctx: Context) => stopper.stop(ctx) })}
					working={liveState.run !== undefined}
				/>
			)}
		</div>
	);
}

/** What the pane says while it has no view: loading, the session's failure, or a retry under way. */
function waiting(state: RefState | undefined, t: Translator<"transcript", MessagesOf<typeof messages>>): string {
	if (state?.kind !== "failed") return t("loading");
	if (state.cause.kind === "broken") return t("broken", state.cause.error.message);
	return t("reconnecting");
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

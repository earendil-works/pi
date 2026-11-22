// The view `SessionListView`: an app's active sessions as a list the caller opens one of. Each mounted list holds a
// `SessionsList` of its own (a fresh `view` id), so "Load more" in one screen never grows another's; a session shows
// its title (or "New session") and what its agent does.

import { Button } from "@earendil-works/elanor-react";
import { type SessionRow, type SessionState, SessionsList } from "@earendil-works/p3/v1";
import { useHold, useRefState, useVariant, useWatch } from "@earendil-works/p3/v1/web";
import { useState } from "react";
import { useAction } from "./action.ts";
import styles from "./session-list.module.css";

/** An app's sessions, the last touched first; `selected` is marked, a click calls `onOpen` with the session's id. */
export function SessionList(props: {
	readonly app: string;
	readonly selected?: string;
	readonly onOpen: (session: string) => void;
}) {
	const view = useViewId();
	const list = useHold(SessionsList, { app: props.app, set: "active", view });
	const sessions = useVariant(list, "sessions");
	const state = useRefState(list);
	const value = useWatch(sessions?.list);
	const more = useAction();
	if (state?.kind === "failed" || state?.kind === "ended") {
		return <p className={styles.note}>The sessions cannot be shown.</p>;
	}
	if (value === undefined) return <p className={styles.note}>Loading…</p>;
	if (value.rows.length === 0) return <p className={styles.note}>No sessions yet.</p>;
	return (
		<nav aria-label="Sessions" className={styles.list} data-session-list="">
			<ul>
				{value.rows.map((row) => (
					<li key={row.id}>
						<SessionItem row={row} selected={row.id === props.selected} onOpen={props.onOpen} />
					</li>
				))}
			</ul>
			{value.moreAfter && sessions !== undefined ? (
				<Button
					className={styles.more}
					density="compact"
					hierarchy="tertiary"
					onClick={() => more.run((ctx) => sessions.more(ctx))}
					pending={more.pending}
				>
					Load more
				</Button>
			) : null}
			{more.error === undefined ? null : <p className={styles.error}>{more.error}</p>}
		</nav>
	);
}

/**
 * A fresh id for one mounted list (`SessionsList`'s and `PeopleList`'s `view`), kept while it stays mounted. Random,
 * so two pages of one person never share a list; `getRandomValues` works on a page served over plain HTTP too.
 */
export function useViewId(): string {
	const [id] = useState(() =>
		Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, "0")).join(""),
	);
	return id;
}

/** What the list says of an agent's state; a settled one says nothing. */
const STATE_LABELS: Readonly<Record<SessionState, string | undefined>> = {
	working: "Working",
	waiting: "Waiting",
	failed: "Failed",
	settled: undefined,
};

/** One session of the list: its title and its state. */
function SessionItem(props: {
	readonly row: SessionRow;
	readonly selected: boolean;
	readonly onOpen: (session: string) => void;
}) {
	const { row } = props;
	const label = STATE_LABELS[row.state];
	return (
		<button
			aria-current={props.selected ? "page" : undefined}
			className={styles.item}
			data-session={row.id}
			onClick={() => props.onOpen(row.id)}
			type="button"
		>
			<span className={styles.title}>{row.title === "" ? "New session" : row.title}</span>
			{label === undefined ? null : (
				<span className={styles.state} data-state={row.state}>
					{label}
				</span>
			)}
		</button>
	);
}

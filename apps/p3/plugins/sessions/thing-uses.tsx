// "Used in": where a thing is, for whoever manages it. The sessions that link it (`ThingUses`: one list per opened
// thing, its next page on request; each by its title and how it has the thing there), and for a thing "in all my
// sessions" also every session that follows its owner, which links nothing and so is in no list.

import { Button } from "@earendil-works/elanor-react";
import { type Bringer, SessionInfo, ThingUses } from "@earendil-works/p3/v1";
import { useHold, useLive, useWatch } from "@earendil-works/p3/v1/web";
import type { Action } from "./action.ts";
import { useViewId } from "./session-list.tsx";
import styles from "./session-things.module.css";

/**
 * The sessions that link thing `thing`, and with `followers` (its owner as the reader names them, for a thing "in all
 * my sessions") every session that follows them.
 */
export function ThingUsesList(props: {
	readonly thing: string;
	readonly followers: string | undefined;
	readonly action: Action;
}) {
	const uses = useLive(useHold(ThingUses, { thing: props.thing, view: useViewId() }));
	const list = useWatch(uses?.list);
	if (list === undefined) return <p className={styles.note}>Loading…</p>;
	const linked = list.rows.length > 0;
	return (
		<div className={styles.uses} data-thing-uses={props.thing}>
			<p className={styles.whose}>Linked in</p>
			{linked ? null : (
				<p className={styles.note}>{props.followers === undefined ? "No session." : "No session links it."}</p>
			)}
			<ul className={styles.items}>
				{list.rows.map(({ session, by }) => (
					<li className={styles.item} data-use={session} key={session}>
						<SessionTitle session={session} />
						<span className={styles.access}>{BY_LABELS[by.kind]}</span>
					</li>
				))}
			</ul>
			{props.followers === undefined ? null : (
				<p className={styles.note} data-followers="">
					{linked ? "and every" : "It is in every"} session that follows {props.followers}.
				</p>
			)}
			{list.moreAfter && uses !== undefined ? (
				<Button density="compact" hierarchy="tertiary" onClick={() => props.action.run((ctx) => uses.more(ctx))}>
					More
				</Button>
			) : null}
		</div>
	);
}

/** How a session has a thing, as "Used in" says it. */
const BY_LABELS: Readonly<Record<Bringer["kind"], string>> = {
	person: "Linked",
	app: "By its app",
	agent: "By its agent",
	followed: "Followed",
};

/** Session `session`'s title (else "New session"), as its info gives it to the viewer. */
function SessionTitle(props: { readonly session: string }) {
	const row = useWatch(useLive(useHold(SessionInfo, { session: props.session }))?.session);
	return <span className={styles.grow}>{row === undefined ? "…" : row.title === "" ? "New session" : row.title}</span>;
}

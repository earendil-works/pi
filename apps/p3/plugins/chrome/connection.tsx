// The page's connection to its server as the chrome shows it: a light and a word (connected, connecting, offline).

import type { ConnectionState } from "@earendil-works/p3/v1";
import { useMessages } from "@earendil-works/p3/v1/web";
import styles from "./frame.module.css";
import { messages } from "./messages.ts";

/** How each connection state reads. */
const LABELS = { connected: "connected", connecting: "connecting", waiting: "offline" } as const;

/** The connection's light and its label; the label hides on narrow screens, the light stays. */
export function ConnectionStatus(props: { readonly state: ConnectionState }) {
	const { t } = useMessages(messages);
	return (
		<output aria-live="polite" className={styles.status} data-connection={props.state}>
			<span aria-hidden="true" className={styles.statusLight} data-state={props.state} />
			<span className={styles.statusLabel}>{t(LABELS[props.state])}</span>
		</output>
	);
}

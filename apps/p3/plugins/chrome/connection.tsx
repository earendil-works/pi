// The page's connection to its server as the chrome shows it: a light and a word (connected, connecting, offline).

import type { ConnectionState } from "@earendil-works/p3/v1";
import styles from "./frame.module.css";

/** How each connection state reads. */
export const CONNECTION_LABELS: Readonly<Record<ConnectionState, string>> = {
	connected: "Connected",
	connecting: "Connecting…",
	waiting: "Offline",
};

/** The connection's light and its label; the label hides on narrow screens, the light stays. */
export function ConnectionStatus(props: { readonly state: ConnectionState }) {
	return (
		<output aria-live="polite" className={styles.status} data-connection={props.state}>
			<span aria-hidden="true" className={styles.statusLight} data-state={props.state} />
			<span className={styles.statusLabel}>{CONNECTION_LABELS[props.state]}</span>
		</output>
	);
}

// The machine's view (`Views`): its name and status (ready, or unavailable while its type is not installed). The
// folders in use and their sessions come with `inUse` (ERNDL-1172).

import { useHold, useLive, useMessages, useRefState, useWatch } from "@earendil-works/p3/v1/web";
// Other plugins' web contracts by path, never through `/v1/web`.
import type { ThingViewProps } from "../things/contract.web.tsx";
import { Machine } from "./kind.ts";
import styles from "./machine-view.module.css";
import { messages } from "./messages.ts";

/** Machine `props.thing` held in `props.workspace`. */
export function MachineView(props: ThingViewProps) {
	const { t } = useMessages(messages);
	const ref = useHold(Machine, { workspace: props.workspace, thing: props.thing });
	const state = useRefState(ref);
	const info = useWatch(useLive(ref)?.info);
	if (state?.kind === "failed" && state.cause.kind === "denied") return <p className={styles.note}>{t("denied")}</p>;
	if (state?.kind === "failed" || state?.kind === "ended")
		return <p className={styles.note}>{t("unavailableView")}</p>;
	if (info === undefined) return <p className={styles.note}>{t("loading")}</p>;
	return (
		<section aria-label={info.name || t("kind")} className={styles.view} data-machine={info.status}>
			<p className={styles.title}>{info.name || t("kind")}</p>
			<p className={styles.note}>{info.status === "ready" ? t("ready") : t("unavailable")}</p>
		</section>
	);
}

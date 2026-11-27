// The Terminals view (`Views`): the terminals open in a workspace as tabs, one shown at a time on a `TerminalScreen`
// (screen.ts; `GhosttyScreen`), and, with Use, New terminal (where the workspace works: `useWorkLocation`), typing and
// Close. The screen reaches the shown terminal through its link (terminal-link.ts: the attach socket at the address
// `attach` answers); Watch and Use withheld take the list away at once and end the socket.

import { Button, IconButton } from "@earendil-works/elanor-react";
import type { Reference } from "@earendil-works/p3/v1";
import { CloseIcon, useHold, useLive, useMessages, useRefState, useWatch } from "@earendil-works/p3/v1/web";
import { useMemo, useState } from "react";
import { useWorkLocation } from "../environments/contract.web.tsx";
import { type ThingViewProps, useAction } from "../things/contract.web.tsx";
import { GhosttyScreen } from "./ghostty-screen.tsx";
import { Terminals } from "./kind.ts";
import { messages } from "./messages.ts";
import { terminalLink } from "./terminal-link.ts";
import styles from "./terminals-view.module.css";

/** What the tabs open on: the workspace, its Terminals thing, and the machine and folder new terminals start in. */
type TabsProps = {
	readonly workspace: string;
	readonly thing: string;
	readonly machine: string;
	readonly folder: string;
};

/** The size a new terminal starts with, before its screen measures itself. */
const START = { columns: 80, rows: 24 };

/** Terminals `props.thing` held in `props.workspace`; new terminals start where the workspace works. */
export function TerminalsView(props: ThingViewProps) {
	const { t } = useMessages(messages);
	const at = useWorkLocation(props.workspace);
	if (at.kind === "loading") return <p className={styles.note}>{t("loading")}</p>;
	if (at.kind === "unreadable") return <p className={styles.note}>{t("unavailable")}</p>;
	return <Tabs {...props} folder={at.folder} key={at.machine} machine={at.machine} />;
}

/** The terminals of `props.workspace` as tabs. */
function Tabs(props: TabsProps) {
	const { t } = useMessages(messages);
	const ref = useHold(Terminals, { workspace: props.workspace, thing: props.thing });
	const live = useLive(ref);
	const state = useRefState(ref);
	const list = useWatch(live?.terminals);
	const [chosen, setChosen] = useState<string | undefined>(undefined);
	const action = useAction();
	if (state?.kind === "failed" && state.cause.kind === "denied") return <p className={styles.note}>{t("denied")}</p>;
	if (state?.kind === "failed" || state?.kind === "ended") return <p className={styles.note}>{t("unavailable")}</p>;
	if (live === undefined) return <p className={styles.note}>{t("loading")}</p>;
	if (list === undefined) return <p className={styles.note}>{t("denied")}</p>;
	const shown = list.find((terminal) => terminal.id === chosen) ?? list[list.length - 1];
	const open = live.open;
	const close = live.close;
	return (
		<section aria-label={t("view")} className={styles.view} data-terminals="">
			<div className={styles.tabs} role="tablist">
				{list.map((terminal, index) => (
					<button
						aria-selected={terminal.id === shown?.id}
						className={styles.tab}
						data-terminal-tab={terminal.id}
						key={terminal.id}
						onClick={() => setChosen(terminal.id)}
						role="tab"
						type="button"
					>
						{`${index + 1} · ${terminal.folder.slice(terminal.folder.lastIndexOf("/") + 1) || "/"}`}
					</button>
				))}
				{open === undefined ? null : (
					<Button
						data-terminals-open=""
						density="compact"
						hierarchy="tertiary"
						disabled={action.pending}
						onClick={() =>
							action.run(async (context) =>
								setChosen(await open({ machine: props.machine, folder: props.folder, ...START }, context)),
							)
						}
					>
						{t("open")}
					</Button>
				)}
			</div>
			{shown === undefined ? (
				<p className={styles.note}>{t("none")}</p>
			) : (
				<>
					<div className={styles.bar}>
						<span className={styles.folder}>{shown.folder}</span>
						{shown.exitCode === null ? null : <span className={styles.note}>{t("ended", shown.exitCode)}</span>}
						{close === undefined ? null : (
							<IconButton
								aria-label={t("close")}
								data-terminal-close=""
								onClick={() => action.run((context) => close({ terminal: shown.id }, context))}
							>
								<CloseIcon />
							</IconButton>
						)}
					</div>
					<Shown key={shown.id} label={shown.folder} live={live} terminal={shown.id} />
				</>
			)}
			{action.error === undefined ? null : <p className={styles.error}>{action.error}</p>}
		</section>
	);
}

/** Terminal `terminal` on its screen, through its link: typable and resizable with Use. */
function Shown(props: {
	readonly live: Reference<typeof Terminals>;
	readonly terminal: string;
	readonly label: string;
}) {
	const { live, terminal } = props;
	// A new link once Use comes or goes: the screen follows the terminal again, typable or not.
	const typable = live.type !== undefined;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `typable` is what the link reads of `live`'s members.
	const link = useMemo(() => terminalLink(live, terminal), [live, terminal, typable]);
	return <GhosttyScreen label={props.label} link={link} />;
}

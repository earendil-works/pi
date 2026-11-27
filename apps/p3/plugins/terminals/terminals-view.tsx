// The Terminals view (`Views`): the terminals open in a workspace as tabs, one shown at a time on a `TerminalScreen`
// (screen.tsx; `PlainScreen` until a renderer is decided), and, with Use, New terminal (where the workspace works:
// `useWorkLocation`), typing and Close. The screen reads the shown terminal's bytes from the address `attach` answers
// (kept output, then what follows, raw); Watch and Use withheld take the list away at once and end the bytes.

import { Button, IconButton } from "@earendil-works/elanor-react";
import { BACKGROUND_CONTEXT, type Reference, reportError, withCancel } from "@earendil-works/p3/v1";
import { CloseIcon, useHold, useLive, useMessages, useRefState, useWatch } from "@earendil-works/p3/v1/web";
import { useCallback, useState } from "react";
import { useWorkLocation } from "../environments/contract.web.tsx";
import { type ThingViewProps, useErrorText } from "../things/contract.web.tsx";
import { Terminals } from "./kind.ts";
import { messages } from "./messages.ts";
import { PlainScreen } from "./screen.tsx";
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
	const errorText = useErrorText();
	const ref = useHold(Terminals, { workspace: props.workspace, thing: props.thing });
	const live = useLive(ref);
	const state = useRefState(ref);
	const list = useWatch(live?.terminals);
	const [chosen, setChosen] = useState<string | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	if (state?.kind === "failed" && state.cause.kind === "denied") return <p className={styles.note}>{t("denied")}</p>;
	if (state?.kind === "failed" || state?.kind === "ended") return <p className={styles.note}>{t("unavailable")}</p>;
	if (live === undefined) return <p className={styles.note}>{t("loading")}</p>;
	if (list === undefined) return <p className={styles.note}>{t("denied")}</p>;
	const shown = list.find((terminal) => terminal.id === chosen) ?? list[list.length - 1];
	const failed = (failure: unknown) => setError(errorText(failure));
	const open = live.open;
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
						onClick={() => {
							setError(undefined);
							open({ machine: props.machine, folder: props.folder, ...START }, BACKGROUND_CONTEXT)
								.then(setChosen)
								.catch(failed);
						}}
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
						{live.close === undefined ? null : (
							<IconButton
								aria-label={t("close")}
								data-terminal-close=""
								onClick={() => live.close?.({ terminal: shown.id }, BACKGROUND_CONTEXT).catch(failed)}
							>
								<CloseIcon />
							</IconButton>
						)}
					</div>
					<Shown key={shown.id} label={shown.folder} live={live} terminal={shown.id} />
				</>
			)}
			{error === undefined ? null : <p className={styles.error}>{error}</p>}
		</section>
	);
}

/** Terminal `terminal` on its screen: its bytes from the reference, its keys and size back to it with Use. */
function Shown(props: {
	readonly live: Reference<typeof Terminals>;
	readonly terminal: string;
	readonly label: string;
}) {
	const { live, terminal } = props;
	const subscribe = useCallback(
		(onBytes: (bytes: Uint8Array) => void) => followBytes(live, terminal, onBytes),
		[live, terminal],
	);
	const type = live.type;
	const resize = live.resize;
	return (
		<PlainScreen
			label={props.label}
			subscribe={subscribe}
			{...(type === undefined ? {} : { onInput: (bytes) => void type({ terminal, bytes }, BACKGROUND_CONTEXT) })}
			{...(resize === undefined
				? {}
				: { onResize: (columns, rows) => void resize({ terminal, columns, rows }, BACKGROUND_CONTEXT) })}
		/>
	);
}

/**
 * Hands `onBytes` terminal `terminal`'s bytes in order until the returned stop: the address `attach` answers, read as
 * a stream (kept output first, then each piece as it comes); a failure is reported and leaves the screen as it was.
 */
function followBytes(
	live: Reference<typeof Terminals>,
	terminal: string,
	onBytes: (bytes: Uint8Array) => void,
): () => void {
	const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
	const start = async () => {
		const attached = await live.attach?.({ terminal }, context);
		if (attached === undefined) return;
		const response = await fetch(attached.url, { signal: context.abortSignal });
		const reader = response.body?.getReader();
		if (!response.ok || reader === undefined) throw new Error(`terminals: attach answered ${response.status}`);
		for (let next = await reader.read(); !next.done; next = await reader.read()) onBytes(next.value);
	};
	start().catch((error: unknown) => {
		if (!context.abortSignal?.aborted) reportError("terminals: a terminal's bytes", error, BACKGROUND_CONTEXT);
	});
	return cancel;
}

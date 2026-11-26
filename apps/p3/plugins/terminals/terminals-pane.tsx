// The terminal pane: the terminals open in a workspace as tabs, one shown at a time on a `TerminalScreen` (screen.tsx;
// `PlainScreen` until a renderer is decided), and, with Use, New terminal (on the pane's machine, in its folder),
// typing and Close. A component until slice 4's `Views` registers panes; what it opens on is its props. The screen
// gets the backlog first, then the output events numbered after it; Watch withheld takes the list and the output
// away at once.

import { Button, IconButton } from "@earendil-works/elanor-react";
import { BACKGROUND_CONTEXT, type EventSubscription, type Reference, withCancel } from "@earendil-works/p3/v1";
import { CloseIcon, useHold, useLive, useMessages, useRefState, useWatch } from "@earendil-works/p3/v1/web";
import { useCallback, useState } from "react";
import { type Output, Terminals } from "./contract.ts";
import { messages } from "./messages.ts";
import { PlainScreen, type TerminalScreen } from "./screen.tsx";
import styles from "./terminals-pane.module.css";

/** What the pane opens on: the workspace, its Terminals thing, and the machine and folder new terminals start in. */
export type TerminalsPaneProps = {
	readonly workspace: string;
	readonly thing: string;
	readonly machine: string;
	readonly folder: string;
	/** What draws a terminal (default `PlainScreen`). */
	readonly Screen?: TerminalScreen;
};

/** The size a new terminal starts with, before its screen measures itself. */
const START = { columns: 80, rows: 24 };

/** The pane on `props.workspace`'s terminals. */
export function TerminalsPane(props: TerminalsPaneProps) {
	const { t } = useMessages(messages);
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
	const failed = (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure));
	const open = live.open;
	const Screen = props.Screen ?? PlainScreen;
	return (
		<section aria-label={t("pane")} className={styles.pane} data-terminals="">
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
					<Shown key={shown.id} label={shown.folder} live={live} Screen={Screen} terminal={shown.id} />
				</>
			)}
			{error === undefined ? null : <p className={styles.error}>{error}</p>}
		</section>
	);
}

/** Terminal `terminal` on `Screen`: its bytes from the reference, its keys and size back to it with Use. */
function Shown(props: {
	readonly live: Reference<typeof Terminals>;
	readonly terminal: string;
	readonly label: string;
	readonly Screen: TerminalScreen;
}) {
	const { live, terminal, Screen } = props;
	const subscribe = useCallback(
		(onBytes: (bytes: Uint8Array) => void) => followBytes(live, terminal, onBytes),
		[live, terminal],
	);
	const input = live.input;
	const resize = live.resize;
	return (
		<Screen
			label={props.label}
			subscribe={subscribe}
			{...(input === undefined ? {} : { onInput: (data) => void input({ terminal, data }, BACKGROUND_CONTEXT) })}
			{...(resize === undefined
				? {}
				: { onResize: (columns, rows) => void resize({ terminal, columns, rows }, BACKGROUND_CONTEXT) })}
		/>
	);
}

/**
 * Hands `onBytes` terminal `terminal`'s output in order until the returned stop: the output events are followed
 * first and held back, then the backlog is read, then the held pieces numbered after it and every later one.
 */
function followBytes(
	live: Reference<typeof Terminals>,
	terminal: string,
	onBytes: (bytes: Uint8Array) => void,
): () => void {
	const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
	let stopped = false;
	let after: number | undefined;
	const held: Output[] = [];
	const piece = (output: Output) => {
		if (output.terminal !== terminal) return;
		if (after === undefined) held.push(output);
		else if (output.seq > after) {
			after = output.seq;
			onBytes(bytesOf(output.data));
		}
	};
	let subscription: EventSubscription | undefined;
	const start = async () => {
		subscription = await live.output?.on(({ value }) => piece(value), context);
		const backlog = await live.backlog?.({ terminal }, context);
		if (backlog === undefined || stopped) return;
		after = backlog.seq;
		onBytes(bytesOf(backlog.data));
		for (const output of held.splice(0)) piece(output);
	};
	// A failure leaves the screen as it was; the pane shows the reference's state.
	start().catch(() => {});
	return () => {
		stopped = true;
		cancel();
		subscription?.stop();
	};
}

/** Base64 `data` as bytes. */
function bytesOf(data: string): Uint8Array {
	return Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
}

// The checklist kind's view of one checklist: its name and items; a caller granted Tick ticks them, one granted Add
// adds them, anyone else let in reads. The view follows the admission live: a tick taken back removes its control at
// once, on the same hold.

import { Button, Checkbox, Input, SelectionControlAndLabel } from "@earendil-works/elanor-react";
import {
	BACKGROUND_CONTEXT,
	type Context,
	isChordError,
	type MessageData,
	type MessagesOf,
	type Translator,
} from "@earendil-works/p3/v1";
import { type ThingViewProps, useHold, useLive, useMessages, useRefState, useWatch } from "@earendil-works/p3/v1/web";
import { useState } from "react";
import styles from "./checklist-view.module.css";
import { Checklist } from "./kind.ts";
import { messages } from "./messages.ts";

/** Checklist `thing`, as the viewer's admission allows: Tick ticks items, Add adds them. */
export function ChecklistView(props: ThingViewProps) {
	// Until sessions are workspaces (slice 5) a checklist is held in the workspace named by the session's id.
	const ref = useHold(Checklist, { workspace: props.session, thing: props.thing });
	const live = useLive(ref);
	const state = useRefState(ref);
	const name = useWatch(live?.name);
	const items = useWatch(live?.items);
	const { t } = useMessages(messages);
	const [text, setText] = useState("");
	const action = useAction();
	if (state?.kind === "failed" && state.cause.kind === "denied") return <p className={styles.note}>{t("denied")}</p>;
	if (state?.kind === "failed" || state?.kind === "ended") return <p className={styles.note}>{t("unavailable")}</p>;
	const addItem = live?.addItem;
	const setDone = live?.setDone;
	const add = () => {
		const item = text.trim();
		if (addItem === undefined || item === "") return;
		action.run(async (ctx) => {
			await addItem({ text: item }, ctx);
			setText("");
		});
	};
	return (
		<section
			aria-label={name || t("untitled")}
			className={styles.checklist}
			data-checklist={[addItem && "add", setDone && "tick"].filter(Boolean).join(" ") || "reader"}
		>
			<p className={styles.title} data-checklist-name="">
				{name || t("untitled")}
			</p>
			{items === undefined ? (
				<p className={styles.note}>{t("loading")}</p>
			) : items.length === 0 ? (
				<p className={styles.note}>{t("empty")}</p>
			) : (
				<ul className={styles.items}>
					{items.map((item) => (
						<li data-item={item.id} key={item.id}>
							<SelectionControlAndLabel
								className={item.done ? styles.done : undefined}
								control={
									<Checkbox.Root
										checked={item.done}
										disabled={setDone === undefined}
										onCheckedChange={(done: boolean) =>
											setDone && action.run((ctx) => setDone({ id: item.id, done }, ctx))
										}
									>
										<Checkbox.Indicator />
									</Checkbox.Root>
								}
							>
								{item.text}
							</SelectionControlAndLabel>
						</li>
					))}
				</ul>
			)}
			{addItem === undefined ? null : (
				<form
					className={styles.add}
					onSubmit={(event) => {
						event.preventDefault();
						add();
					}}
				>
					<Input
						aria-label={t("newItem")}
						className={styles.field}
						data-item-new=""
						onValueChange={setText}
						placeholder={t("newItemPlaceholder")}
						value={text}
					/>
					<Button
						data-item-add=""
						disabled={text.trim() === ""}
						hierarchy="secondary"
						pending={action.pending}
						type="submit"
					>
						{t("add")}
					</Button>
				</form>
			)}
			{action.error === undefined ? null : <p className={styles.error}>{action.error}</p>}
		</section>
	);
}

/** A change the view makes (an add, a tick): whether one runs and why the last one failed. */
type Action = {
	readonly pending: boolean;
	readonly error: string | undefined;
	/** Runs `call` unless one runs already; its failure is kept as `error`, never thrown. */
	run(call: (context: Context) => Promise<unknown>): void;
};

/**
 * The view's change state and its `run`: a failure is kept as the text a person reads (`failureText`). Local until
 * the web API has the shared hook and `refusalText`.
 */
function useAction(): Action {
	const { t } = useMessages(messages);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	return {
		pending,
		error,
		run: (call) => {
			if (pending) return;
			setPending(true);
			setError(undefined);
			call(BACKGROUND_CONTEXT).then(
				() => setPending(false),
				(failure: unknown) => {
					setPending(false);
					setError(failureText(failure, t));
				},
			);
		},
	};
}

/**
 * What a failed change says to a person: the refusal's message (`details.message`, as the checklist plugin refuses) in
 * their language, else the error's own text.
 */
function failureText(failure: unknown, t: Translator<"checklist", MessagesOf<typeof messages>>): string {
	// A trust boundary: the details came over the link; `t.render` checks the message itself and shows the key of one
	// it does not know.
	const details: unknown = isChordError(failure) ? failure.details : undefined;
	if (typeof details === "object" && details !== null && "message" in details) {
		return t.render(details.message as MessageData);
	}
	return failure instanceof Error ? failure.message : String(failure);
}

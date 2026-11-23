// The checklist on the page: its view of one checklist (`ThingViews`' `View`: its items, ticked and added by a
// checker, shown to a reader) and its options form in the session sheet (one switch, "May tick").

import { Button, Checkbox, Input, SelectionControlAndLabel, Switch } from "@earendil-works/elanor-react";
import { BACKGROUND_CONTEXT, type Context, defineFacet, type OptionsOf } from "@earendil-works/p3/v1";
import {
	CheckIcon,
	type ThingOptionsProps,
	type ThingViewProps,
	ThingViews,
	useHold,
	useRefState,
	useVariant,
	useWatch,
} from "@earendil-works/p3/v1/web";
import { useState } from "react";
import { Checklist, ChecklistKind } from "./contract.ts";
import styles from "./web.module.css";

export default defineFacet((_host, self) =>
	self.contribute(ThingViews, {
		kind: ChecklistKind.name,
		Icon: CheckIcon,
		View: ChecklistView,
		Options: ChecklistOptions,
	}),
);

/** Checklist `thing` of session `session`, as the viewer's admission allows: a checker ticks and adds. */
function ChecklistView(props: ThingViewProps) {
	const ref = useHold(Checklist, { session: props.session, thing: props.thing });
	const checker = useVariant(ref, "checker");
	const reader = useVariant(ref, "reader");
	const state = useRefState(ref);
	const items = useWatch((checker ?? reader)?.items);
	const [text, setText] = useState("");
	const [error, setError] = useState<string | undefined>(undefined);
	/** Runs `call`, keeping its failure to show. */
	const run = (call: (context: Context) => Promise<unknown>) => {
		setError(undefined);
		call(BACKGROUND_CONTEXT).catch((failure: unknown) =>
			setError(failure instanceof Error ? failure.message : String(failure)),
		);
	};
	if (state?.kind === "failed" && state.cause.kind === "denied") {
		return <p className={styles.note}>You may not read this checklist.</p>;
	}
	if (state?.kind === "failed" || state?.kind === "ended") {
		return <p className={styles.note}>This checklist cannot be shown now.</p>;
	}
	const add = () => {
		const item = text.trim();
		if (checker === undefined || item === "") return;
		run(async (ctx) => {
			await checker.add({ text: item }, ctx);
			setText("");
		});
	};
	return (
		<section aria-label="Checklist" className={styles.checklist} data-checklist={checker ? "checker" : "reader"}>
			{items === undefined ? (
				<p className={styles.note}>Loading…</p>
			) : items.length === 0 ? (
				<p className={styles.note}>No items yet.</p>
			) : (
				<ul className={styles.items}>
					{items.map((item) => (
						<li data-item={item.id} key={item.id}>
							<SelectionControlAndLabel
								className={item.done ? styles.done : undefined}
								control={
									<Checkbox.Root
										checked={item.done}
										disabled={checker === undefined}
										onCheckedChange={(done: boolean) =>
											checker && run((ctx) => checker.tick({ id: item.id, done }, ctx))
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
			{checker === undefined ? null : (
				<form
					className={styles.add}
					onSubmit={(event) => {
						event.preventDefault();
						add();
					}}
				>
					<Input
						aria-label="New item"
						className={styles.field}
						data-item-new=""
						onValueChange={setText}
						placeholder="A new item"
						value={text}
					/>
					<Button data-item-add="" disabled={text.trim() === ""} hierarchy="secondary" type="submit">
						Add
					</Button>
				</form>
			)}
			{error === undefined ? null : <p className={styles.error}>{error}</p>}
		</section>
	);
}

/** The options form over `props.options` (none readable: the kind's initial), saved for `props.for`. */
function ChecklistOptions(props: ThingOptionsProps) {
	// The options the sessions plugin gives a form are its kind's, checked against its schema when written.
	const stored = (props.options ?? ChecklistKind.initial) as OptionsOf<typeof ChecklistKind>;
	const [check, setCheck] = useState(stored.check);
	return (
		<div className={styles.options} data-checklist-options="">
			<SelectionControlAndLabel
				control={
					<Switch.Root checked={check} data-option="check" onCheckedChange={setCheck}>
						<Switch.Thumb />
					</Switch.Root>
				}
			>
				May tick
			</SelectionControlAndLabel>
			<Button
				data-options-save=""
				disabled={check === stored.check}
				hierarchy="secondary"
				onClick={() => props.onSave(props.for, { check })}
			>
				Save
			</Button>
		</div>
	);
}

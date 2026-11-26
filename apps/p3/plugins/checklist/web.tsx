// The checklist on the page: its view of one checklist (`ThingViews`): its items, ticked and added by a writer (granted
// Write), shown to anyone else let in. Who may write is the things plugin's grants, edited in its Settings view.

import { Button, Checkbox, Input, SelectionControlAndLabel } from "@earendil-works/elanor-react";
import { BACKGROUND_CONTEXT, type Context, defineFacet, withGranted } from "@earendil-works/p3/v1";
import {
	CheckIcon,
	type ThingViewProps,
	ThingViews,
	useHold,
	useLive,
	useRefState,
	useWatch,
} from "@earendil-works/p3/v1/web";
import { useState } from "react";
import { CHECKLIST_WRITES, Checklist, ChecklistKind } from "./contract.ts";
import styles from "./web.module.css";

export default defineFacet((_host, self) =>
	self.contribute(ThingViews, {
		kind: ChecklistKind.name,
		Icon: CheckIcon,
		View: ChecklistView,
	}),
);

/** Checklist `thing` of session `session`, as the viewer's admission allows: a writer ticks and adds. */
function ChecklistView(props: ThingViewProps) {
	// Until sessions are workspaces (slice 5) a checklist is held in the workspace named by the session's id.
	const ref = useHold(Checklist, { workspace: props.session, thing: props.thing });
	const live = useLive(ref);
	const writer = withGranted(live, ...CHECKLIST_WRITES);
	const state = useRefState(ref);
	const items = useWatch(live?.items);
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
		if (writer === undefined || item === "") return;
		run(async (ctx) => {
			await writer.add({ text: item }, ctx);
			setText("");
		});
	};
	return (
		<section aria-label="Checklist" className={styles.checklist} data-checklist={writer ? "writer" : "reader"}>
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
										disabled={writer === undefined}
										onCheckedChange={(done: boolean) =>
											writer && run((ctx) => writer.tick({ id: item.id, done }, ctx))
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
			{writer === undefined ? null : (
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

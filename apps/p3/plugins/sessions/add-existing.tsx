// "One of mine…" from the session sheet's "+": a small dialog where a writer links a thing they manage (their own, their
// groups', the Pi's for the owner) into the session, found by the start of its name (`MyThings` with a prefix: one
// list per opened dialog, its next page on request). Things the session has already are left out; a pick links it
// and closes the dialog.

import { Button, Field, IconButton, Input, Modal, Stack } from "@earendil-works/elanor-react";
import { MyThings } from "@earendil-works/p3/v1";
import { CloseIcon, useHold, useVariant, useWatch } from "@earendil-works/p3/v1/web";
import { useState } from "react";
import type { Action } from "./action.ts";
import { choiceName, ownerKey } from "./give-thing.tsx";
import { useViewId } from "./session-list.tsx";
import styles from "./session-things.module.css";
import { ThingRow } from "./thing-row.tsx";

/** The dialog, open while `open`; `present` are the things the session has, `onAdd` links one. */
export function AddExistingDialog(props: {
	readonly open: boolean;
	readonly present: ReadonlySet<string>;
	readonly onAdd: (thing: string) => void;
	readonly onClose: () => void;
	readonly action: Action;
}) {
	return (
		<Modal.Root
			onOpenChange={(open) => {
				if (!open) props.onClose();
			}}
			open={props.open}
		>
			<Modal.Portal>
				<Modal.Backdrop />
				<Modal.Viewport>
					<Modal.Popup className={styles.dialog} data-add-existing="">
						<Stack align="start" direction="row" gap="auto">
							<Modal.Title>One of mine</Modal.Title>
							<Modal.Close render={<IconButton aria-label="Close" />}>
								<CloseIcon />
							</Modal.Close>
						</Stack>
						{props.open ? (
							<Search
								action={props.action}
								onAdd={(thing) => {
									props.onAdd(thing);
									props.onClose();
								}}
								present={props.present}
							/>
						) : null}
					</Modal.Popup>
				</Modal.Viewport>
			</Modal.Portal>
		</Modal.Root>
	);
}

/** The search and its results, each a row that links the thing when tapped. */
function Search(props: {
	readonly present: ReadonlySet<string>;
	readonly onAdd: (thing: string) => void;
	readonly action: Action;
}) {
	const [prefix, setPrefix] = useState("");
	const mine = useVariant(useHold(MyThings, { view: useViewId(), prefix: prefix.trim() }), "mine");
	const list = useWatch(mine?.list);
	const owners = useWatch(mine?.owners) ?? [];
	const names = new Map(owners.map((choice) => [ownerKey(choice.owner), choiceName(choice)] as const));
	const shown = (list?.rows ?? []).filter((thing) => !props.present.has(thing.id));
	return (
		<div className={styles.things}>
			<Field.Root>
				<Field.Label>Search</Field.Label>
				<Input data-field="search" onValueChange={setPrefix} placeholder="Name starts with…" value={prefix} />
			</Field.Root>
			{list !== undefined && shown.length === 0 ? <p className={styles.note}>Nothing else of yours.</p> : null}
			<ul className={styles.items}>
				{shown.map((thing) => (
					<ThingRow
						actions={[]}
						data={{ "data-existing": thing.id }}
						key={thing.id}
						kind={thing.kind}
						line={`${thing.title} · ${names.get(ownerKey(thing.owner)) ?? ""}`}
						name={thing.name === "" ? thing.title : thing.name}
						onOpen={() => props.onAdd(thing.id)}
					/>
				))}
			</ul>
			{list?.moreAfter === true && mine !== undefined ? (
				<Button density="compact" hierarchy="tertiary" onClick={() => props.action.run((ctx) => mine.more(ctx))}>
					More
				</Button>
			) : null}
		</div>
	);
}

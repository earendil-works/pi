// "Add existing" in the session sheet: a writer links a thing they manage (their own, their groups', the Pi's for
// the owner) into the session, found by the start of its name (`MyThings` with a prefix: one list per mounted search,
// its next page on request). Things the session has already are left out.

import { Button, Field, Heading, Input } from "@earendil-works/elanor-react";
import { MyThings, type Thing } from "@earendil-works/p3/v1";
import { useHold, useVariant, useWatch } from "@earendil-works/p3/v1/web";
import { useState } from "react";
import type { Action } from "./action.ts";
import { ownerKey } from "./give-thing.tsx";
import { useViewId } from "./session-list.tsx";
import styles from "./session-things.module.css";

/** The search and its results; `present` are the things the session has, `onAdd` links one. */
export function AddExisting(props: {
	readonly present: ReadonlySet<string>;
	readonly titles: ReadonlyMap<string, string>;
	readonly onAdd: (thing: string) => void;
	readonly action: Action;
}) {
	const [prefix, setPrefix] = useState("");
	const mine = useVariant(useHold(MyThings, { view: useViewId(), prefix: prefix.trim() }), "mine");
	const list = useWatch(mine?.list);
	const owners = useWatch(mine?.owners) ?? [];
	const names = new Map(owners.map(({ owner, name }) => [ownerKey(owner), name] as const));
	const shown = (list?.rows ?? []).filter((thing) => !props.present.has(thing.id));
	return (
		<section aria-label="Add existing" className={styles.section} data-add-existing="">
			<Heading level={3} size={6}>
				Add existing
			</Heading>
			<Field.Root>
				<Field.Label>Search</Field.Label>
				<Input data-field="search" onValueChange={setPrefix} placeholder="Name starts with…" value={prefix} />
			</Field.Root>
			{list !== undefined && shown.length === 0 ? <p className={styles.note}>Nothing else of yours.</p> : null}
			<ul className={styles.items}>
				{shown.map((thing) => (
					<li className={styles.item} data-existing={thing.id} key={thing.id}>
						<span className={styles.grow}>
							<span className={styles.title}>{nameOf(thing, props.titles)}</span>
							<span className={styles.whose}>{names.get(ownerKey(thing.owner)) ?? ""}</span>
						</span>
						<Button
							data-add-existing-thing={thing.id}
							density="compact"
							onClick={() => props.onAdd(thing.id)}
							pending={props.action.pending}
						>
							Add
						</Button>
					</li>
				))}
			</ul>
			{list?.moreAfter === true && mine !== undefined ? (
				<Button density="compact" hierarchy="tertiary" onClick={() => props.action.run((ctx) => mine.more(ctx))}>
					More
				</Button>
			) : null}
		</section>
	);
}

/** How a thing reads in a list: its name, else its kind's title (`titles`), else its kind. */
export function nameOf(thing: Pick<Thing, "name" | "kind">, titles: ReadonlyMap<string, string>): string {
	return thing.name !== "" ? thing.name : (titles.get(thing.kind) ?? thing.kind);
}

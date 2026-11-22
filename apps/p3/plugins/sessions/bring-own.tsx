// "Bring your own": what a writer of a session (a person or the owner) may bring into it of their own, the records
// their kinds' plugins say are theirs (`BringThings.kinds`), picked and added in one step. Records the caller brought
// already are left out.

import { Button, Heading } from "@earendil-works/elanor-react";
import { BACKGROUND_CONTEXT, type Context, type ThingRecord } from "@earendil-works/p3/v1";
import { useEffect, useState } from "react";
import type { Action } from "./action.ts";
import { Choice } from "./choice.tsx";
import styles from "./session-things.module.css";

/** A kind whose records the caller may bring, with those records (`BringThings.kinds`' answer). */
export type BringableKind = { readonly kind: string; readonly title: string; readonly records: readonly ThingRecord[] };

/** What `BringThings`' writer answers to `kinds`. */
export type KindsOf = (args: Record<string, never>, context: Context) => Promise<readonly BringableKind[]>;

/**
 * The kinds the caller may bring, asked once per `kinds` (a new writer reference asks again): `undefined` while asked,
 * or when the caller cannot bring (a reader). A failure leaves the list empty and is kept as `error`.
 */
export function useBringable(kinds: KindsOf | undefined): {
	readonly kinds: readonly BringableKind[] | undefined;
	readonly error: string | undefined;
} {
	const [answer, setAnswer] = useState<{ readonly kinds: readonly BringableKind[]; readonly error?: string }>();
	useEffect(() => {
		if (kinds === undefined) return;
		let current = true;
		kinds({}, BACKGROUND_CONTEXT).then(
			(found) => current && setAnswer({ kinds: found }),
			(error: unknown) =>
				current && setAnswer({ kinds: [], error: error instanceof Error ? error.message : String(error) }),
		);
		return () => {
			current = false;
		};
	}, [kinds]);
	return { kinds: kinds === undefined ? undefined : answer?.kinds, error: answer?.error };
}

/**
 * The pick of one of the caller's records not brought yet (`brought`: `<kind> <ref>` of what they brought), and its
 * button; `onBring` gets the kind and the record. Nothing while the caller has no kind to bring.
 */
export function BringOwn(props: {
	readonly kinds: readonly BringableKind[];
	readonly brought: ReadonlySet<string>;
	readonly onBring: (kind: string, ref: string) => void;
	readonly action: Action;
}) {
	const [chosen, setChosen] = useState<string | undefined>(undefined);
	if (props.kinds.length === 0) return null;
	const items = props.kinds.flatMap((kind) =>
		kind.records
			.filter((record) => !props.brought.has(broughtKey(kind.kind, record.ref)))
			.map((record) => ({ value: broughtKey(kind.kind, record.ref), label: `${kind.title}: ${record.title}` })),
	);
	const picked = items.find((item) => item.value === chosen)?.value ?? items[0]?.value;
	return (
		<section aria-label="Bring your own" className={styles.section} data-bring-own="">
			<Heading level={3} size={6}>
				Bring your own
			</Heading>
			{items.length === 0 ? (
				<p className={styles.note}>Everything of yours is here.</p>
			) : (
				<div className={styles.add}>
					<Choice items={items} label="Yours" name="record" onChange={setChosen} value={picked ?? null} />
					<Button
						data-bring=""
						disabled={picked === undefined}
						onClick={() => {
							if (picked === undefined) return;
							const at = picked.indexOf(SEPARATOR);
							props.onBring(picked.slice(0, at), picked.slice(at + 1));
						}}
						pending={props.action.pending}
					>
						Bring
					</Button>
				</div>
			)}
		</section>
	);
}

/** Between a kind and a record in a pick's value: a kind's name (`<plugin>.<kind>`) holds none, a record may. */
const SEPARATOR = " ";

/** A brought record as `BringOwn` tells them apart: its kind and its record. */
export function broughtKey(kind: string, ref: string): string {
	return `${kind}${SEPARATOR}${ref}`;
}

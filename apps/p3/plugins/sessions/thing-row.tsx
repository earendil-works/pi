// A thing as a row of the session sheet and My things: its kind's icon (`ThingViews`' `Icon`), its name and one muted
// line, the whole row a button that opens the thing when it can be opened, anything the list puts beside it (a
// switch), and its actions behind one "⋯" menu (only those the caller may take; none: no menu). An action that needs
// more (a name, a pick of options) opens its panel under the row.

import { IconButton, Menu } from "@earendil-works/elanor-react";
import { DescriptionIcon, MoreHorizIcon, useRegistry } from "@earendil-works/p3/v1/web";
import type { ReactNode } from "react";
import { ThingViews } from "./contract.web.tsx";
import styles from "./session-things.module.css";

/** One action of a row's menu: its key (`data-menu-item`), its label and what it does. */
export type RowAction = { readonly key: string; readonly label: string; readonly run: () => void };

/** The row: `data` are its `data-*` attributes (for the tests), `panel` what an action opened under it. */
export function ThingRow(props: {
	readonly kind: string;
	readonly name: string;
	readonly line: string;
	readonly onOpen: (() => void) | undefined;
	readonly beside?: ReactNode;
	readonly actions: readonly RowAction[];
	readonly panel?: ReactNode;
	readonly data: Readonly<Record<`data-${string}`, string>>;
}) {
	const Icon = useRegistry(ThingViews)?.get(props.kind)?.value.Icon ?? DescriptionIcon;
	const content = (
		<>
			<span aria-hidden="true" className={styles.icon}>
				<Icon />
			</span>
			<span className={styles.rowText}>
				<span className={styles.rowTitle} data-thing-name="">
					{props.name}
				</span>
				<span className={styles.rowLine} data-whose="">
					{props.line}
				</span>
			</span>
		</>
	);
	return (
		<li className={styles.row} {...props.data}>
			<div className={styles.rowTop}>
				{props.onOpen === undefined ? (
					<div className={styles.rowMain}>{content}</div>
				) : (
					<button className={styles.rowMain} data-row-open="" onClick={props.onOpen} type="button">
						{content}
					</button>
				)}
				{props.beside}
				<RowMenu actions={props.actions} name={props.name} />
			</div>
			{props.panel === undefined || props.panel === null ? null : <div className={styles.panel}>{props.panel}</div>}
		</li>
	);
}

/** The "⋯" menu of `actions` (none: no button). */
function RowMenu(props: { readonly name: string; readonly actions: readonly RowAction[] }) {
	if (props.actions.length === 0) return null;
	return (
		<Menu.Root>
			<Menu.Trigger data-row-menu="" render={<IconButton aria-label={`More for ${props.name}`} />}>
				<MoreHorizIcon />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner align="end" sideOffset={4}>
					<Menu.Popup data-row-popup="">
						{props.actions.map((action) => (
							<Menu.Item data-menu-item={action.key} key={action.key} onClick={action.run}>
								{action.label}
							</Menu.Item>
						))}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}

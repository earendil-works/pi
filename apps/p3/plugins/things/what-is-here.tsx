// What is here (the Settings view's second part): things linked here, then things from above with a switch each
// (shown or hidden here, with Hide), and the default for those without one (decision 80); each opens its own Settings
// view, and "Add a thing" opens the picker. The default's switch (`FromAboveSwitch`) serves who is here too.

import { Button, SelectionControlAndLabel, Switch } from "@earendil-works/elanor-react";
import { BACKGROUND_CONTEXT, withGranted } from "@earendil-works/p3/v1";
import {
	AddIcon,
	ChevronRightIcon,
	DescriptionIcon,
	navigate,
	targetPath,
	useComponent,
	useHold,
	useLive,
	useMessages,
	usePageState,
	useRegistry,
	useWatch,
} from "@earendil-works/p3/v1/web";
import { useState } from "react";
import { AddThing, ThingParts, useErrorText, useNames, useScreenId } from "./contract.web.tsx";
import { page } from "./page-messages.ts";
import styles from "./things.module.css";
import { useFromText } from "./use-page.ts";
import { Workspace, WorkspaceContents } from "./workspace.ts";

/** What is here in `workspace`, with its switches and the picker. */
export function WhatIsHere(props: { readonly workspace: string }) {
	const { t } = useMessages(page);
	const contents = useWatch(
		useLive(useHold(WorkspaceContents, { workspace: props.workspace, view: useScreenId() }))?.list,
	);
	const ref = useLive(useHold(Workspace, { workspace: props.workspace }));
	const info = useWatch(ref?.info);
	const hider = withGranted(ref, "hide");
	const defaulter = withGranted(ref, "setShowsThings");
	const mayAdd = withGranted(ref, "make") !== undefined || withGranted(ref, "link") !== undefined;
	const parts = useRegistry(ThingParts);
	const fromText = useFromText();
	const names = useNames();
	const errorText = useErrorText();
	const [failure, setFailure] = useState<string | undefined>(undefined);
	const Picker = useComponent(AddThing);
	// Kept in page state: a reload of this plugin keeps the picker open.
	const [adding, setAdding] = usePageState(`things.adding.${props.workspace}`, false);
	return (
		<section className={styles.part} data-what-is-here="">
			<div className={styles.partHead}>
				<h2 className={styles.partTitle}>{t("whatIsHere")}</h2>
				{mayAdd ? (
					<Button data-add-thing="" hierarchy="secondary" iconStart={<AddIcon />} onClick={() => setAdding(true)}>
						{t("addThing")}
					</Button>
				) : null}
			</div>
			{failure === undefined ? null : <p className={styles.error}>{t("failed", failure)}</p>}
			{info === undefined || !(contents?.rows ?? []).some((row) => row.from.kind !== "here") ? null : (
				<FromAboveSwitch
					label={t("showsThings")}
					marker="things"
					onChange={
						defaulter === undefined
							? undefined
							: (shown) =>
									defaulter
										.setShowsThings({ shown }, BACKGROUND_CONTEXT)
										.catch((error: unknown) => setFailure(errorText(error)))
					}
					shown={info.showsThings}
				/>
			)}
			<ul className={styles.rows}>
				{(contents?.rows ?? []).map((row) => {
					const Icon = parts?.get(row.kind)?.value.Icon ?? DescriptionIcon;
					const from = fromText(row.from);
					const settings = targetPath(
						{ kind: "thing", workspace: props.workspace, thing: row.thing },
						{ settings: true },
					);
					return (
						<li className={styles.row} data-here-thing={row.thing} data-hidden={row.hidden} key={row.thing}>
							<Icon />
							<span className={row.hidden ? styles.struck : styles.rowName}>
								{names.thing(row.kind, row.name)}
							</span>
							<span className={styles.from}>{from ?? t("linkedHere")}</span>
							{from === undefined ? null : (
								<SelectionControlAndLabel
									control={
										<Switch.Root
											checked={!row.hidden}
											data-switch={row.thing}
											disabled={hider === undefined}
											onCheckedChange={(shown) =>
												hider
													?.hide({ thing: row.thing, shown }, BACKGROUND_CONTEXT)
													.catch((error: unknown) => setFailure(errorText(error)))
											}
										>
											<Switch.Thumb />
										</Switch.Root>
									}
								>
									{row.hidden ? t("hiddenHere") : t("shown")}
								</SelectionControlAndLabel>
							)}
							<Button
								aria-label={t("settingsOf", names.thing(row.kind, row.name))}
								density="compact"
								hierarchy="tertiary"
								iconStart={<ChevronRightIcon />}
								onClick={() => navigate(settings)}
							/>
						</li>
					);
				})}
			</ul>
			{adding && Picker !== undefined ? (
				<Picker onAdded={() => setAdding(false)} onClose={() => setAdding(false)} workspace={props.workspace} />
			) : null}
		</section>
	);
}

/**
 * The default of a workspace for things or people from above that have no switch here (decision 80): shown or hidden;
 * read only without `onChange` (Hide for things, Manage people for people).
 */
export function FromAboveSwitch(props: {
	readonly label: string;
	readonly marker: "things" | "people";
	readonly shown: boolean;
	readonly onChange: ((shown: boolean) => void) | undefined;
}) {
	return (
		<SelectionControlAndLabel
			control={
				<Switch.Root
					checked={props.shown}
					data-shows-from-above={props.marker}
					disabled={props.onChange === undefined}
					onCheckedChange={(shown) => props.onChange?.(shown)}
				>
					<Switch.Thumb />
				</Switch.Root>
			}
		>
			{props.label}
		</SelectionControlAndLabel>
	);
}

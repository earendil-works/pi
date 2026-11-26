// Who is here (the Settings view's first part): the parties put in here, then those from above with a switch each
// (shown or hidden here, with Manage people); a person or group here may be removed, and "Invite" adds people.

import { Button, SelectionControlAndLabel, Switch } from "@earendil-works/elanor-react";
import { BACKGROUND_CONTEXT, withGranted } from "@earendil-works/p3/v1";
import {
	GroupIcon,
	PersonAddIcon,
	PersonIcon,
	PersonRemoveIcon,
	useHold,
	useLive,
	useMessages,
	useWatch,
} from "@earendil-works/p3/v1/web";
import { useState } from "react";
import { partyKey } from "./contract.ts";
import { page } from "./page-messages.ts";
import styles from "./things.module.css";
import { useErrorText, useFromText, usePartyName, useScreenId } from "./use-page.ts";
import { Workspace, WorkspacePeople } from "./workspace.ts";

/** Who is here in `workspace`, with its switches; `onInvite` opens the invite dialog (none: no Manage people). */
export function WhoIsHere(props: { readonly workspace: string; readonly onInvite: (() => void) | undefined }) {
	const { t } = useMessages(page);
	const people = useWatch(
		useLive(useHold(WorkspacePeople, { workspace: props.workspace, view: useScreenId() }))?.list,
	);
	const ref = useLive(useHold(Workspace, { workspace: props.workspace }));
	const hider = withGranted(ref, "hideParty");
	const remover = withGranted(ref, "removeParty");
	const fromText = useFromText();
	const nameOf = usePartyName();
	const errorText = useErrorText();
	const [failure, setFailure] = useState<string | undefined>(undefined);
	const report = (error: unknown) => setFailure(errorText(error));
	return (
		<section className={styles.part} data-who-is-here="">
			<div className={styles.partHead}>
				<h2 className={styles.partTitle}>{t("whoIsHere")}</h2>
				{props.onInvite === undefined ? null : (
					<Button hierarchy="secondary" iconStart={<PersonAddIcon />} onClick={props.onInvite}>
						{t("invite")}
					</Button>
				)}
			</div>
			{failure === undefined ? null : <p className={styles.error}>{t("failed", failure)}</p>}
			<ul className={styles.rows}>
				{(people?.rows ?? []).map((row) => {
					const key = partyKey(row.party);
					const from = fromText(row.from);
					const Icon = row.party.kind === "group" ? GroupIcon : PersonIcon;
					return (
						<li className={styles.row} data-here-party={key} data-hidden={row.hidden} key={key}>
							<Icon />
							<span className={row.hidden ? styles.struck : styles.rowName}>{nameOf(row.party, row.name)}</span>
							<span className={styles.from}>{from ?? ""}</span>
							{from === undefined ? (
								remover === undefined ? null : (
									<Button
										aria-label={t("remove")}
										density="compact"
										hierarchy="tertiary"
										iconStart={<PersonRemoveIcon />}
										onClick={() =>
											remover.removeParty({ party: row.party }, BACKGROUND_CONTEXT).catch(report)
										}
									/>
								)
							) : (
								<SelectionControlAndLabel
									control={
										<Switch.Root
											checked={!row.hidden}
											disabled={hider === undefined}
											onCheckedChange={(shown) =>
												hider?.hideParty({ party: row.party, shown }, BACKGROUND_CONTEXT).catch(report)
											}
										>
											<Switch.Thumb />
										</Switch.Root>
									}
								>
									{row.hidden ? t("hiddenHere") : t("shown")}
								</SelectionControlAndLabel>
							)}
						</li>
					);
				})}
			</ul>
		</section>
	);
}

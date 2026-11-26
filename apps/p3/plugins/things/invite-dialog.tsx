// The invite dialog of a workspace (mockup 5): someone already on this Pi, from the people and groups present here
// (`Workspace.picker`), put in as a member; or someone new by a link (`Workspace.inviteLink`): as a member or a guest,
// how long it lasts and how often it may be used.

import {
	Button,
	CopyButton,
	IconButton,
	Input,
	Modal,
	Radio,
	SegmentedControl,
	SelectionControlAndLabel,
	Stack,
} from "@earendil-works/elanor-react";
import { BACKGROUND_CONTEXT, withGranted } from "@earendil-works/p3/v1";
import { CloseIcon, useHold, useLive, useMessages, useWatch } from "@earendil-works/p3/v1/web";
import { useState } from "react";
import { partyKey } from "./contract.ts";
import { page } from "./page-messages.ts";
import styles from "./things.module.css";
import { useErrorText, usePartyName } from "./use-page.ts";
import { type PartyInfo, Workspace } from "./workspace.ts";

/** A day in milliseconds: how `expires` counts. */
const DAY = 24 * 60 * 60 * 1000;

/** How long a new link lasts, in days, as the dialog offers it. */
const EXPIRIES = [1, 7, 30] as const;

/** The invite dialog of `workspace`; `onClose` closes it. */
export function InviteDialog(props: { readonly workspace: string; readonly onClose: () => void }) {
	const { t } = useMessages(page);
	const ref = useLive(useHold(Workspace, { workspace: props.workspace }));
	const info = useWatch(ref?.info);
	const name = info?.name ?? "";
	return (
		<Modal.Root onOpenChange={(open) => (open ? undefined : props.onClose())} open>
			<Modal.Portal>
				<Modal.Backdrop />
				<Modal.Viewport>
					<Modal.Popup className={styles.dialog} data-invite-dialog="">
						<Stack align="start" direction="row" gap="auto">
							<Modal.Title>{t("inviteTitle", name)}</Modal.Title>
							<Modal.Close render={<IconButton aria-label={t("close")} />}>
								<CloseIcon />
							</Modal.Close>
						</Stack>
						{withGranted(ref, "picker", "putParty") === undefined ? null : (
							<Existing name={name} workspace={props.workspace} />
						)}
						{withGranted(ref, "inviteLink") === undefined ? null : <ByLink workspace={props.workspace} />}
						<p className={styles.hint}>{t("inviteFootnote")}</p>
					</Modal.Popup>
				</Modal.Viewport>
			</Modal.Portal>
		</Modal.Root>
	);
}

/** Someone already on this Pi: search the people and groups present here, put the chosen one in. */
function Existing(props: { readonly workspace: string; readonly name: string }) {
	const { t } = useMessages(page);
	const ref = withGranted(useLive(useHold(Workspace, { workspace: props.workspace })), "picker", "putParty");
	const [query, setQuery] = useState("");
	const [found, setFound] = useState<readonly PartyInfo[] | undefined>(undefined);
	const [chosen, setChosen] = useState<PartyInfo | undefined>(undefined);
	const [failure, setFailure] = useState<string | undefined>(undefined);
	const errorText = useErrorText();
	const nameOf = usePartyName();
	const failed = (error: unknown) => setFailure(errorText(error));
	const search = (next: string) => {
		setQuery(next);
		setFailure(undefined);
		ref?.picker({ query: next.trim() }, BACKGROUND_CONTEXT).then(setFound, failed);
	};
	const put = () =>
		chosen === undefined
			? undefined
			: ref?.putParty({ party: chosen.party }, BACKGROUND_CONTEXT).then(() => setChosen(undefined), failed);
	return (
		<section className={styles.invitePart} data-invite-existing="">
			<h3 className={styles.pickerTitle}>{t("inviteExisting")}</h3>
			<Input data-invite-search="" onValueChange={search} placeholder={t("search")} value={query} />
			<ul className={styles.rows}>
				{(found ?? []).map((party) => (
					<li key={partyKey(party.party)}>
						<Button
							className={styles.offer}
							data-invite-candidate={partyKey(party.party)}
							hierarchy={chosen?.party === party.party ? "secondary" : "tertiary"}
							onClick={() => setChosen(party)}
						>
							{nameOf(party.party, party.name)}
						</Button>
					</li>
				))}
				{found !== undefined && found.length === 0 ? <li className={styles.hint}>{t("nobodyFound")}</li> : null}
			</ul>
			<p className={styles.hint}>{t("inviteExistingHint", props.name)}</p>
			{failure === undefined ? null : <p className={styles.error}>{t("failed", failure)}</p>}
			<Stack align="center" direction="row" gap="auto">
				<span>{t("putIn", props.name)}</span>
				<Button data-invite-add="" disabled={chosen === undefined} hierarchy="primary" onClick={put}>
					{t("add")}
				</Button>
			</Stack>
		</section>
	);
}

/** Someone new, or anyone by link: member or guest, its expiry and uses; the link to copy once made. */
function ByLink(props: { readonly workspace: string }) {
	const { t } = useMessages(page);
	const ref = withGranted(useLive(useHold(Workspace, { workspace: props.workspace })), "inviteLink");
	const [as, setAs] = useState<"member" | "guest">("member");
	const [days, setDays] = useState<(typeof EXPIRIES)[number]>(7);
	const [uses, setUses] = useState<"one" | "several">("one");
	const [link, setLink] = useState<string | undefined>(undefined);
	const [failure, setFailure] = useState<string | undefined>(undefined);
	const errorText = useErrorText();
	const make = () => {
		setFailure(undefined);
		ref?.inviteLink({ name: "", as, expires: days * DAY, uses }, BACKGROUND_CONTEXT).then(
			({ url }) => setLink(new URL(url, location.origin).href),
			(error: unknown) => setFailure(errorText(error)),
		);
	};
	return (
		<section className={styles.invitePart} data-invite-link-part="">
			<h3 className={styles.pickerTitle}>{t("inviteNew")}</h3>
			{/* The group reports the value of one of its two radios, typed `unknown` by Elanor. */}
			<Radio.Group onValueChange={(value) => setAs(value as "member" | "guest")} value={as}>
				<SelectionControlAndLabel
					control={
						<Radio.Root data-invite-as="member" value="member">
							<Radio.Indicator />
						</Radio.Root>
					}
				>
					<strong>{t("member")}</strong> {t("memberHint")}
				</SelectionControlAndLabel>
				<SelectionControlAndLabel
					control={
						<Radio.Root data-invite-as="guest" value="guest">
							<Radio.Indicator />
						</Radio.Root>
					}
				>
					<strong>{t("guest")}</strong> {t("guestHint")}
				</SelectionControlAndLabel>
			</Radio.Group>
			<Stack align="center" direction="row" gap="small">
				<span>{t("expires")}</span>
				{/* The control reports one of the values it was given, the `EXPIRIES` as text. */}
				<SegmentedControl.Root
					onValueChange={(value) => setDays(Number(value[0] ?? 7) as (typeof EXPIRIES)[number])}
					value={[String(days)]}
				>
					{EXPIRIES.map((each) => (
						<SegmentedControl.Item key={each} value={String(each)}>
							{t("inDays", each)}
						</SegmentedControl.Item>
					))}
				</SegmentedControl.Root>
			</Stack>
			<Stack align="center" direction="row" gap="small">
				<span>{t("usedBy")}</span>
				<SegmentedControl.Root
					onValueChange={(value) => setUses(value[0] === "several" ? "several" : "one")}
					value={[uses]}
				>
					<SegmentedControl.Item value="one">{t("onePerson")}</SegmentedControl.Item>
					<SegmentedControl.Item value="several">{t("several")}</SegmentedControl.Item>
				</SegmentedControl.Root>
			</Stack>
			<Button data-invite-create="" hierarchy="secondary" onClick={make}>
				{t("createLink")}
			</Button>
			{failure === undefined ? null : (
				<p className={styles.error} data-invite-failure="">
					{t("failed", failure)}
				</p>
			)}
			{link === undefined ? null : (
				<Stack align="center" direction="row" gap="small">
					<Input className={styles.grow} data-invite-url="" readOnly value={link} />
					<CopyButton aria-label={t("copy")} value={link} />
				</Stack>
			)}
		</section>
	);
}

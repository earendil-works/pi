// The Settings view (decisions 59, 60; the things plugin's, no other view draws configuration): for a workspace its
// name and place, then three parts as tabs: who is here, what is here, who may do what (the workspace's own ticks);
// for a thing its name, kind and where it is linked, who may do what with it, its kind's `Settings` form, and
// "Remove from here". Whoever lacks a tick sees its part read-only.

import { Button, PageHeader, Tabs } from "@earendil-works/elanor-react";
import { BACKGROUND_CONTEXT, withGranted } from "@earendil-works/p3/v1";
import {
	DeleteIcon,
	navigate,
	PersonAddIcon,
	type Target,
	targetPath,
	useComponent,
	useHold,
	useLive,
	useMessages,
	useRegistry,
	useWatch,
} from "@earendil-works/p3/v1/web";
import { useState } from "react";
import { Invite, ThingParts } from "./contract.web.tsx";
import { page } from "./page-messages.ts";
import styles from "./things.module.css";
import { useFromText } from "./use-page.ts";
import { WhatIsHere } from "./what-is-here.tsx";
import { WhoIsHere } from "./who-is-here.tsx";
import { WhoMayTable } from "./who-may.tsx";
import { ThingInfo, Workspace } from "./workspace.ts";

/** The Settings view of `target`: a workspace's or a thing's; a person or a group has none yet. */
export function SettingsView(props: { readonly target: Target }) {
	const { target } = props;
	switch (target.kind) {
		case "workspace":
			return <WorkspaceSettings workspace={target.workspace} />;
		case "thing":
			return <ThingSettings thing={target.thing} workspace={target.workspace} />;
		default:
			return null;
	}
}

/** The parts of a workspace's Settings view, as its tabs name them. */
type Part = "who" | "what" | "may";

/** A workspace's Settings view: its header, then who is here, what is here and who may, as tabs. */
function WorkspaceSettings(props: { readonly workspace: string }) {
	const { t } = useMessages(page);
	const ref = useLive(useHold(Workspace, { workspace: props.workspace }));
	const info = useWatch(ref?.info);
	const [part, setPart] = useState<Part>("may");
	const [inviting, setInviting] = useState(false);
	const InviteDialog = useComponent(Invite);
	const mayInvite = withGranted(ref, "putParty") !== undefined || withGranted(ref, "inviteLink") !== undefined;
	if (info === undefined) return null;
	const place = info.parent === undefined ? t("workspace") : t("workspaceIn", info.parent.name);
	return (
		<div className={styles.settings} data-settings={props.workspace}>
			<PageHeader.Root>
				<PageHeader.Row>
					<PageHeader.Title data-settings-title="" level={1}>
						{info.name}
					</PageHeader.Title>
					{mayInvite ? (
						<PageHeader.Actions>
							<Button
								data-invite-open=""
								hierarchy="primary"
								iconStart={<PersonAddIcon />}
								onClick={() => setInviting(true)}
							>
								{t("invite")}
							</Button>
						</PageHeader.Actions>
					) : null}
				</PageHeader.Row>
				<PageHeader.Description>{`${t("settings")} · ${place}`}</PageHeader.Description>
			</PageHeader.Root>
			<Tabs.Root onValueChange={(value) => setPart(value as Part)} value={part}>
				<Tabs.List className={styles.tabs}>
					<Tabs.Tab data-settings-tab="who" value="who">
						{t("whoIsHere")}
					</Tabs.Tab>
					<Tabs.Tab data-settings-tab="what" value="what">
						{t("whatIsHere")}
					</Tabs.Tab>
					<Tabs.Tab data-settings-tab="may" value="may">
						{t("whoMay")}
					</Tabs.Tab>
					<Tabs.Indicator />
				</Tabs.List>
				<Tabs.Panel value="who">
					<WhoIsHere onInvite={mayInvite ? () => setInviting(true) : undefined} workspace={props.workspace} />
				</Tabs.Panel>
				<Tabs.Panel value="what">
					<WhatIsHere workspace={props.workspace} />
				</Tabs.Panel>
				<Tabs.Panel value="may">
					<WhoMayTable name={info.name} thing={props.workspace} workspace={props.workspace} />
				</Tabs.Panel>
			</Tabs.Root>
			{inviting && InviteDialog !== undefined ? (
				<InviteDialog onClose={() => setInviting(false)} workspace={props.workspace} />
			) : null}
		</div>
	);
}

/** A thing's Settings view: name, kind and where it is linked; who may; its kind's form; remove from here. */
function ThingSettings(props: { readonly workspace: string; readonly thing: string }) {
	const { t } = useMessages(page);
	const info = useWatch(useLive(useHold(ThingInfo, props))?.info);
	const workspace = useLive(useHold(Workspace, { workspace: props.workspace }));
	const Form = useRegistry(ThingParts)?.get(info?.kind ?? "")?.value.Settings;
	const fromText = useFromText();
	if (info === undefined || info.kind === "") return null;
	const linker = info.from.kind === "here" ? withGranted(workspace, "unlink") : undefined;
	const remove = () =>
		linker?.unlink({ thing: props.thing }, BACKGROUND_CONTEXT).then(
			() => navigate(targetPath({ kind: "workspace", workspace: props.workspace }, { settings: true })),
			() => undefined,
		);
	return (
		<div className={styles.settings} data-settings={props.thing}>
			<PageHeader.Root>
				<PageHeader.Row>
					<PageHeader.Title data-settings-title="" level={1}>
						{info.name}
					</PageHeader.Title>
					{linker === undefined ? null : (
						<PageHeader.Actions>
							<Button data-unlink="" hierarchy="secondary" iconStart={<DeleteIcon />} onClick={remove}>
								{t("remove")}
							</Button>
						</PageHeader.Actions>
					)}
				</PageHeader.Row>
				<PageHeader.Description>
					{t("thingIn", info.kind, fromText(info.from) ?? t("linkedHere"))}
				</PageHeader.Description>
			</PageHeader.Root>
			<WhoMayTable name={info.name} thing={props.thing} workspace={props.workspace} />
			{Form === undefined ? null : <Form thing={props.thing} workspace={props.workspace} />}
		</div>
	);
}

// The top bar, as Inkling's app header: Elanor's `Layout.Header` with `TopNavigation`. On the left the wordmark and
// where the page is (the workspace, the thing, Settings), on the right the connection and the person menu (who is
// signed in, their own page).

import { Button, Layout, Menu, TopNavigation } from "@earendil-works/elanor-react";
import {
	ChevronRightIcon,
	KeyboardArrowDownIcon,
	navigate,
	PersonIcon,
	type Target,
	targetPath,
	useHold,
	useLive,
	useMessages,
	useWatch,
} from "@earendil-works/p3/v1/web";
// Other plugins' web contracts by path, never through `/v1/web` (see `frame.tsx`).
import { ThingInfo, Workspace } from "../things/workspace.ts";
import { ConnectionStatus } from "./connection.tsx";
import styles from "./frame.module.css";
import type { ChromeProps } from "./frame.tsx";
import { messages } from "./messages.ts";

/** The bar: where the page is, the connection, and the person's menu. */
export function TopBar(props: ChromeProps) {
	return (
		<Layout.Header className={styles.masthead} data-top-bar="" render={<TopNavigation.Root />}>
			<TopNavigation.Identity className={styles.identity}>
				<span className={styles.wordmark}>Pi</span>
				{props.target === undefined ? null : <Crumbs settings={props.settings} target={props.target} />}
			</TopNavigation.Identity>
			<TopNavigation.Actions className={styles.actions}>
				<ConnectionStatus state={props.connection} />
				{props.person === undefined ? null : <PersonMenu name={props.person} />}
			</TopNavigation.Actions>
		</Layout.Header>
	);
}

/** Where the page is: its workspace, the thing shown there, and "Settings" on a Settings view. */
function Crumbs(props: { readonly target: Target; readonly settings: boolean }) {
	const { t } = useMessages(messages);
	const { target } = props;
	const workspace = useWatch(useLive(useHold(Workspace, { workspace: target.workspace }))?.info);
	return (
		<nav className={styles.crumbs} data-crumbs="">
			<Button
				density="compact"
				hierarchy="tertiary"
				onClick={() => navigate(targetPath({ kind: "workspace", workspace: target.workspace }))}
			>
				{workspace?.name ?? ""}
			</Button>
			{target.kind === "thing" ? <ThingCrumb thing={target.thing} workspace={target.workspace} /> : null}
			{props.settings ? (
				<>
					<ChevronRightIcon />
					<span className={styles.crumb}>{t("settings")}</span>
				</>
			) : null}
		</nav>
	);
}

/** The thing's name in the crumbs. */
function ThingCrumb(props: { readonly workspace: string; readonly thing: string }) {
	const info = useWatch(useLive(useHold(ThingInfo, props))?.info);
	return (
		<>
			<ChevronRightIcon />
			<span className={styles.crumb}>{info?.name ?? ""}</span>
		</>
	);
}

/** The person's menu: who is signed in, and their own page. */
function PersonMenu(props: { readonly name: string }) {
	const { t } = useMessages(messages);
	const { name } = props;
	return (
		<Menu.Root>
			<Menu.Trigger
				className={styles.person}
				data-person-menu=""
				render={<Button hierarchy="tertiary" iconEnd={<KeyboardArrowDownIcon />} />}
			>
				<span className={styles.personName}>{name}</span>
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner align="end" sideOffset={4}>
					<Menu.Popup data-person-popup="">
						<Menu.Group>
							<Menu.GroupLabel>{t("signedInAs", name)}</Menu.GroupLabel>
						</Menu.Group>
						<Menu.Item data-me-open="" icon={<PersonIcon />} onClick={() => navigate("/me")}>
							{t("me")}
						</Menu.Item>
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}

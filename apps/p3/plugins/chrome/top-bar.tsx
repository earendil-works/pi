// The top bar, as Inkling's app header: Elanor's `Layout.Header` with `TopNavigation`. On the left the app switcher
// (the apps the caller may enter), on the right the connection and the person menu (My things; for the owner: "Invite a
// person").

import { Button, Layout, Menu, ProjectSwitcher, TopNavigation } from "@earendil-works/elanor-react";
import type { AppInfo } from "@earendil-works/p3/v1";
import { FolderIcon, KeyboardArrowDownIcon, navigate, PersonAddIcon } from "@earendil-works/p3/v1/web";
import { ConnectionStatus } from "./connection.tsx";
import styles from "./frame.module.css";
import type { Caller, ChromeProps } from "./frame.tsx";

/** The bar: `apps` to switch to (`current` shown), the connection's `state`, and the caller's menu. */
export function TopBar(props: ChromeProps) {
	return (
		<Layout.Header className={styles.masthead} data-top-bar="" render={<TopNavigation.Root />}>
			<TopNavigation.Identity className={styles.identity}>
				<span className={styles.wordmark}>Pi</span>
				<AppSwitcher apps={props.apps} current={props.current} />
			</TopNavigation.Identity>
			<TopNavigation.Actions className={styles.actions}>
				<ConnectionStatus state={props.connection} />
				{props.caller === undefined ? null : (
					<PersonMenu caller={props.caller} onInvite={props.onInvite} onMyThings={props.onMyThings} />
				)}
			</TopNavigation.Actions>
		</Layout.Header>
	);
}

/** The app switcher: the current app's title, a menu of the apps the caller may enter. */
function AppSwitcher(props: { readonly apps: readonly AppInfo[]; readonly current: AppInfo | undefined }) {
	return (
		<ProjectSwitcher.Root>
			<ProjectSwitcher.Trigger className={styles.switcher} data-app-switcher="">
				{props.current?.title ?? "Apps"}
			</ProjectSwitcher.Trigger>
			<ProjectSwitcher.Portal>
				<ProjectSwitcher.Positioner align="start" sideOffset={4}>
					<ProjectSwitcher.Popup data-app-menu="">
						{props.apps.map((app) => (
							<ProjectSwitcher.Item data-app={app.id} key={app.id} onClick={() => navigate(`/${app.id}`)}>
								{app.title}
							</ProjectSwitcher.Item>
						))}
					</ProjectSwitcher.Popup>
				</ProjectSwitcher.Positioner>
			</ProjectSwitcher.Portal>
		</ProjectSwitcher.Root>
	);
}

/** The caller's menu: who is signed in, their things, and for the owner the invite. */
function PersonMenu(props: {
	readonly caller: Caller;
	readonly onInvite: () => void;
	readonly onMyThings: () => void;
}) {
	const name = callerName(props.caller);
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
							<Menu.GroupLabel>Signed in as {name}</Menu.GroupLabel>
						</Menu.Group>
						{props.caller.kind === "person" ? (
							<Menu.Item data-my-things-open="" icon={<FolderIcon />} onClick={props.onMyThings}>
								My things
							</Menu.Item>
						) : null}
						{props.caller.kind === "person" && props.caller.owner ? (
							<Menu.Item data-invite-open="" icon={<PersonAddIcon />} onClick={props.onInvite}>
								Invite a person
							</Menu.Item>
						) : null}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}

/** How the chrome names the caller: a person (the owner too) by their name; a session's agent as "Agent". */
export function callerName(caller: Caller): string {
	return caller.kind === "person" ? caller.name : "Agent";
}

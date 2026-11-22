// The chrome of an app that shows no bar (`chrome: "button"`, an app for a child): one button in the corner over the
// app's page, opening a menu with what the bar holds (the apps, who is signed in, the connection, the invite).

import { IconButton, Menu } from "@earendil-works/elanor-react";
import { MenuIcon, navigate, PersonAddIcon } from "@earendil-works/p3/v1/web";
import { CONNECTION_LABELS } from "./connection.tsx";
import styles from "./frame.module.css";
import type { ChromeProps } from "./frame.tsx";
import { callerName } from "./top-bar.tsx";

/** The corner button and its menu, as `TopBar` takes them. */
export function CornerMenu(props: ChromeProps) {
	return (
		<Menu.Root>
			<Menu.Trigger
				className={styles.corner}
				data-corner-menu=""
				data-connection={props.connection}
				render={<IconButton aria-label="Menu" />}
			>
				<MenuIcon />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner align="end" sideOffset={4}>
					<Menu.Popup data-corner-popup="">
						<Menu.Group>
							<Menu.GroupLabel>Apps</Menu.GroupLabel>
							{props.apps.map((app) => (
								<Menu.Item
									data-app={app.id}
									disabled={app.id === props.current?.id}
									key={app.id}
									onClick={() => navigate(`/${app.id}`)}
								>
									{app.title}
								</Menu.Item>
							))}
						</Menu.Group>
						<Menu.Separator />
						<Menu.Group>
							<Menu.GroupLabel>
								{props.caller === undefined ? "" : `Signed in as ${callerName(props.caller)}. `}
								{CONNECTION_LABELS[props.connection]}
							</Menu.GroupLabel>
							{props.caller?.kind === "person" && props.caller.owner ? (
								<Menu.Item data-invite-open="" icon={<PersonAddIcon />} onClick={props.onInvite}>
									Invite a person
								</Menu.Item>
							) : null}
						</Menu.Group>
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}

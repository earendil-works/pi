// The corner button of a view that takes the whole page (decision 64): the one thing the chrome guarantees there, which
// no view can cover. It opens the navigator in a drawer and the target's Settings view (the gear).

import { Drawer, IconButton, Menu } from "@earendil-works/elanor-react";
import {
	MenuIcon,
	navigate,
	SettingsIcon,
	type Target,
	targetPath,
	useComponent,
	useMessages,
} from "@earendil-works/p3/v1/web";
import { useState } from "react";
// Other plugins' web contracts by path, never through `/v1/web` (see `frame.tsx`).
import { Navigator } from "../things/contract.web.tsx";
import styles from "./frame.module.css";
import { messages } from "./messages.ts";

/** The corner button: the navigator (in a drawer) and the gear of `target`, which keeps the chosen `view`. */
export function CornerMenu(props: { readonly target: Target | undefined; readonly view: string | undefined }) {
	const { t } = useMessages(messages);
	const NavigatorView = useComponent(Navigator);
	const [open, setOpen] = useState(false);
	const { target } = props;
	return (
		<>
			<Menu.Root>
				<Menu.Trigger
					aria-label={t("menu")}
					className={styles.corner}
					data-corner-menu=""
					render={<IconButton aria-label={t("menu")} />}
				>
					<MenuIcon />
				</Menu.Trigger>
				<Menu.Portal>
					<Menu.Positioner align="end" sideOffset={4}>
						<Menu.Popup data-corner-popup="">
							<Menu.Item data-corner-navigator="" icon={<MenuIcon />} onClick={() => setOpen(true)}>
								{t("navigator")}
							</Menu.Item>
							{target === undefined ? null : (
								<Menu.Item
									data-corner-settings=""
									icon={<SettingsIcon />}
									onClick={() => navigate(targetPath(target, { settings: true, view: props.view }))}
								>
									{t("settings")}
								</Menu.Item>
							)}
						</Menu.Popup>
					</Menu.Positioner>
				</Menu.Portal>
			</Menu.Root>
			<Drawer.Root onOpenChange={setOpen} open={open}>
				<Drawer.Portal>
					<Drawer.Backdrop />
					<Drawer.Viewport>
						<Drawer.Popup className={styles.drawer} data-corner-drawer="">
							<Drawer.Title>{t("navigator")}</Drawer.Title>
							{NavigatorView === undefined || !open ? null : (
								<NavigatorView
									onMe={() => navigate("/me")}
									onOpen={(next) => {
										setOpen(false);
										navigate(targetPath(next));
									}}
									target={target}
								/>
							)}
						</Drawer.Popup>
					</Drawer.Viewport>
				</Drawer.Portal>
			</Drawer.Root>
		</>
	);
}

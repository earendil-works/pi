// The chrome's "My things": the person menu opens the sessions plugin's view of the things the caller manages
// (`MyThingsView`) in a dialog, from any app.

import { IconButton, Modal, Stack } from "@earendil-works/elanor-react";
import { CloseIcon, useComponent } from "@earendil-works/p3/v1/web";
// Other plugins' web contracts by path, never through `/v1/web`: a plugin applied to a running server meets the base
// its page started with, whose `/v1/web` may not have a newer contract yet (a view token would be `undefined`).
import { MyThingsView } from "../sessions/contract.web.tsx";
import styles from "./frame.module.css";

/** The dialog, open while `open` (its view, and so its objects, only then); `onClose` closes it. */
export function MyThingsDialog(props: { readonly open: boolean; readonly onClose: () => void }) {
	const MyThings = useComponent(MyThingsView);
	return (
		<Modal.Root
			onOpenChange={(open) => {
				if (!open) props.onClose();
			}}
			open={props.open}
		>
			<Modal.Portal>
				<Modal.Backdrop />
				<Modal.Viewport>
					<Modal.Popup className={styles.dialog} data-my-things-dialog="">
						<Stack align="start" direction="row" gap="auto">
							<Modal.Title>My things</Modal.Title>
							<Modal.Close render={<IconButton aria-label="Close" />}>
								<CloseIcon />
							</Modal.Close>
						</Stack>
						{props.open && MyThings !== undefined ? <MyThings /> : null}
					</Modal.Popup>
				</Modal.Viewport>
			</Modal.Portal>
		</Modal.Root>
	);
}

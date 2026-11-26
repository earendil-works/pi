// The owner's invite: a dialog that makes a person (`People.invite`) and shows their one-time link to copy and send.
// The link signs the first browser that opens it in as the person, within 10 minutes.

import { Button, CopyButton, Field, IconButton, Input, Modal, Stack } from "@earendil-works/elanor-react";
import { BACKGROUND_CONTEXT, People } from "@earendil-works/p3/v1";
import { CloseIcon, useHold, useVariant } from "@earendil-works/p3/v1/web";
import { useState } from "react";
import styles from "./frame.module.css";

/** The invite dialog, open while `open`; `onClose` closes it. */
export function InviteDialog(props: { readonly open: boolean; readonly onClose: () => void }) {
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
					<Modal.Popup className={styles.dialog} data-invite="">
						<Stack align="start" direction="row" gap="auto">
							<Modal.Title>Invite a person</Modal.Title>
							<Modal.Close render={<IconButton aria-label="Close" />}>
								<CloseIcon />
							</Modal.Close>
						</Stack>
						{props.open ? <InviteForm /> : null}
					</Modal.Popup>
				</Modal.Viewport>
			</Modal.Portal>
		</Modal.Root>
	);
}

/** What the invite is at: the name being typed, the call under way, or the link made. */
type Invite =
	| { readonly kind: "editing"; readonly error: string | undefined }
	| { readonly kind: "inviting" }
	| { readonly kind: "invited"; readonly link: string };

/** The form: a name, then the person's link. Holds `People` while the dialog is open. */
function InviteForm() {
	const people = useVariant(useHold(People, {}), "owner");
	const [name, setName] = useState("");
	const [invite, setInvite] = useState<Invite>({ kind: "editing", error: undefined });
	if (invite.kind === "invited") {
		return (
			<div className={styles.inviteLink}>
				<Modal.Description>Send this link to {name.trim()}. It works once, for 10 minutes.</Modal.Description>
				<Stack align="center" direction="row" gap="small">
					<Input className={styles.linkField} data-invite-link="" readOnly value={invite.link} />
					<CopyButton aria-label="Copy the link" value={invite.link} />
				</Stack>
			</div>
		);
	}
	const send = () => {
		if (people === undefined || name.trim() === "") return;
		setInvite({ kind: "inviting" });
		people.invite({ name: name.trim() }, BACKGROUND_CONTEXT).then(
			({ link }) => setInvite({ kind: "invited", link: `${location.origin}${link}` }),
			(error: unknown) =>
				setInvite({ kind: "editing", error: error instanceof Error ? error.message : String(error) }),
		);
	};
	return (
		<form
			className={styles.inviteForm}
			onSubmit={(event) => {
				event.preventDefault();
				send();
			}}
		>
			<Field.Root>
				<Field.Label>Name</Field.Label>
				<Input autoFocus data-invite-name="" onValueChange={setName} value={name} />
			</Field.Root>
			{invite.kind === "editing" && invite.error !== undefined ? (
				<p className={styles.error}>{invite.error}</p>
			) : null}
			<Modal.Actions>
				<Button
					disabled={people === undefined || name.trim() === ""}
					hierarchy="primary"
					pending={invite.kind === "inviting"}
					type="submit"
				>
					Invite
				</Button>
			</Modal.Actions>
		</form>
	);
}

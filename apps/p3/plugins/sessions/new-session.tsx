// The view `NewSessionView`: the owner's form that makes a session of an app, with a title (optional), a location
// (an environment of `Environments` and a folder on it) and the things the app gives every new session.

import { Button, Field, Form, Heading, Input } from "@earendil-works/elanor-react";
import { Environments, Sessions, THIS_DEVICE, type ThingUse } from "@earendil-works/p3/v1";
import { useHold, useLive, useRefState, useWatch } from "@earendil-works/p3/v1/web";
import { useState } from "react";
import { useAction } from "./action.ts";
import { Choice } from "./choice.tsx";
import styles from "./new-session.module.css";

/** The form; `onCreated` gets the new session's id. A caller who is not the owner is told so. */
export function NewSession(props: {
	readonly app: string;
	readonly things?: readonly ThingUse[];
	readonly onCreated: (session: string) => void;
}) {
	const sessionsRef = useHold(Sessions, {});
	const sessions = useLive(sessionsRef);
	const refused = useRefState(sessionsRef)?.kind === "failed";
	const environments = useWatch(useLive(useHold(Environments, {}))?.environments);
	const [title, setTitle] = useState("");
	const [folder, setFolder] = useState("");
	const [chosen, setChosen] = useState<string | undefined>(undefined);
	const create = useAction();
	if (refused) return <p className={styles.note}>Only the owner makes sessions here.</p>;
	const items = (environments ?? []).map((environment) => ({ value: environment.id, label: environment.name }));
	// This device by default, else the first environment: a Pi has a few.
	const environment = chosen ?? items.find((item) => item.value === THIS_DEVICE)?.value ?? items[0]?.value;
	const submit = () => {
		if (sessions === undefined || environment === undefined || folder.trim() === "") return;
		create.run(async (ctx) => {
			const location = { environment, folder: folder.trim() };
			const things = props.things === undefined ? {} : { things: [...props.things] };
			const id = await sessions.create({ app: props.app, title: title.trim(), location, ...things }, ctx);
			props.onCreated(id);
		});
	};
	return (
		<Form
			className={styles.form}
			data-new-session=""
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<Heading level={2} size={4}>
				New session
			</Heading>
			<Field.Root>
				<Field.Label>Title</Field.Label>
				<Input data-field="title" onValueChange={setTitle} placeholder="New session" value={title} />
			</Field.Root>
			<Choice
				items={items}
				label="Environment"
				name="environment"
				onChange={setChosen}
				value={environment ?? null}
			/>
			<Field.Root>
				<Field.Label>Folder</Field.Label>
				<Input
					data-field="folder"
					onValueChange={setFolder}
					placeholder="/home/me/project"
					required
					value={folder}
				/>
				<Field.Description>Where the agent works on that environment.</Field.Description>
			</Field.Root>
			{create.error === undefined ? null : <p className={styles.error}>{create.error}</p>}
			<div className={styles.actions}>
				<Button
					disabled={sessions === undefined || environment === undefined || folder.trim() === ""}
					hierarchy="primary"
					pending={create.pending}
					type="submit"
				>
					Create
				</Button>
			</div>
		</Form>
	);
}

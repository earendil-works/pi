// The session kind's create step (`SessionCreate`, a kind's `Create` in `ThingParts`): where the new session works, a
// machine of `Environments` and a folder there; none given, this device in a folder of the session's own. It hands
// the session kind's make input to the page's add dialog (`onReady`), which makes the session with `Workspace.make`.

import { Dropdown, Field, Input } from "@earendil-works/elanor-react";
import { Environments, THIS_DEVICE } from "@earendil-works/p3/v1";
import { CodeIcon, useHold, useLive, useMessages, useWatch } from "@earendil-works/p3/v1/web";
import { useEffect, useState } from "react";
// Other plugins' web contracts by path, never through `/v1/web` (see `web.tsx`).
import type { ThingCreateProps } from "../things/contract.web.tsx";
import { messages } from "./messages.ts";
import styles from "./new-session.module.css";

/** The session kind's icon. */
export const SessionIcon = CodeIcon;

/**
 * The create step: a machine (this device first) and a folder; `onReady` gets `{}` while the folder is empty (the
 * session's own folder) and `{ location }` once one is given.
 */
export function SessionCreate(props: ThingCreateProps) {
	const { t } = useMessages(messages);
	const environments = useWatch(useLive(useHold(Environments, {}))?.environments);
	const [folder, setFolder] = useState("");
	const [chosen, setChosen] = useState<string | null>(null);
	const items = (environments ?? []).map((environment) => ({ value: environment.id, label: environment.name }));
	const machine = chosen ?? items.find((item) => item.value === THIS_DEVICE)?.value ?? items[0]?.value ?? null;
	const { onReady } = props;
	useEffect(() => {
		const trimmed = folder.trim();
		onReady(trimmed === "" || machine === null ? {} : { location: { environment: machine, folder: trimmed } });
	}, [folder, machine, onReady]);
	return (
		<div className={styles.form} data-new-session="">
			<Dropdown.Root items={items} onValueChange={(value: string | null) => setChosen(value)} value={machine}>
				<Dropdown.Label>{t("machine")}</Dropdown.Label>
				<Dropdown.Trigger data-field="machine">
					<Dropdown.Value />
					<Dropdown.Icon />
				</Dropdown.Trigger>
				<Dropdown.Portal>
					<Dropdown.Positioner>
						<Dropdown.Popup>
							<Dropdown.List>
								{items.map((item) => (
									<Dropdown.Item data-choice={item.value} key={item.value} value={item.value}>
										<Dropdown.ItemText>{item.label}</Dropdown.ItemText>
										<Dropdown.ItemIndicator />
									</Dropdown.Item>
								))}
							</Dropdown.List>
						</Dropdown.Popup>
					</Dropdown.Positioner>
				</Dropdown.Portal>
			</Dropdown.Root>
			<Field.Root>
				<Field.Label>{t("folder")}</Field.Label>
				<Input data-field="folder" onValueChange={setFolder} placeholder="/home/me/project" value={folder} />
				<Field.Description>{t("folderHint")}</Field.Description>
			</Field.Root>
		</div>
	);
}

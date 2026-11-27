// The session kind's create step (`SessionCreate`, a kind's `Create` in `ThingParts`): where the new session works, a
// machine of `Environments` and a folder there; none given, this device in a folder of the session's own. It hands the
// session kind's make input to the page's add dialog (`onReady`), which makes the session with `Workspace.make`, and
// starts from the input it last handed (`input`: a live apply keeps the machine and folder chosen; a machine without a
// folder is no input, as it makes no difference to the session, so it is not kept).

import { Dropdown, Field, Input } from "@earendil-works/elanor-react";
import { Environments, type JsonValue } from "@earendil-works/p3/v1";
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
	const last = locationOf(props.input);
	const [folder, setFolder] = useState(last?.folder ?? "");
	const [chosen, setChosen] = useState<string | null>(last?.machine ?? null);
	const items = (environments ?? []).map((environment) => ({ value: environment.id, label: environment.name }));
	// This device's machine is the list's first.
	const machine = chosen ?? items[0]?.value ?? null;
	const { onReady } = props;
	useEffect(() => {
		const trimmed = folder.trim();
		onReady(trimmed === "" || machine === null ? {} : { location: { machine, folder: trimmed } });
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

/**
 * The location in an input this step handed before (`{ location }`), if any. The dialog keeps it as `JsonValue`, so
 * its shape is read again here.
 */
function locationOf(input: JsonValue | undefined): { readonly machine: string; readonly folder: string } | undefined {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
	const location = input.location;
	if (typeof location !== "object" || location === null || Array.isArray(location)) return undefined;
	const { machine, folder } = location;
	return typeof machine === "string" && typeof folder === "string" ? { machine, folder } : undefined;
}

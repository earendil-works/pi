// The session kind's create step (`SessionCreate`, a kind's `Create` in `ThingParts`): where the new session works, a
// machine of `Environments` and a folder there, pre-filled from the nearest session defaults (`SessionDefaultsHere`)
// and following them until the person changes either (then both stay as shown); no folder, this device in a folder of
// the session's own. It hands the session kind's make input to the page's add dialog (`onReady`), which makes the
// session with `Workspace.make`, and starts from the input it last handed (`input`: a live apply keeps the choice:
// following the defaults, the own folder, or a machine and folder). With no folder, it says when this device is not
// available to the person where the session is made: the session then starts on no machine (R41).

import { Dropdown, Field, Input } from "@earendil-works/elanor-react";
import { Environments, type JsonValue, Me, MyAnswer, SessionDefaultsHere, ThisDevice } from "@earendil-works/p3/v1";
import { CodeIcon, useHold, useLive, useMessages, useWatch } from "@earendil-works/p3/v1/web";
import { useEffect, useState } from "react";
// Other plugins' web contracts by path, never through `/v1/web` (see `web.tsx`).
import type { ThingCreateProps } from "../things/contract.web.tsx";
import { messages } from "./messages.ts";
import styles from "./new-session.module.css";

/** The session kind's icon. */
export const SessionIcon = CodeIcon;

/**
 * The create step: a machine (the defaults', else this device first) and a folder (the defaults'). Untouched, both
 * follow the defaults live and its input is `{}` (the make reads the defaults then, as they are then). The first edit
 * of either field pins both as shown (Astra, push 5: a folder edited alone kept the machine following a defaults
 * change), and the input is `{ location }`, or `{ location: null }` while the folder is empty (the session's own).
 * A remount starts from the input it last handed.
 */
export function SessionCreate(props: ThingCreateProps) {
	const { t } = useMessages(messages);
	const environments = useWatch(useLive(useHold(Environments, {}))?.environments);
	const [draft, setDraft] = useState<Draft>(() => draftOf(props.input));
	const preset = useWatch(useLive(useHold(SessionDefaultsHere, { workspace: props.workspace }))?.defaults)?.location;
	const me = useWatch(useLive(useHold(Me, {}))?.me);
	const device = useWatch(useLive(useHold(ThisDevice, {}))?.machine);
	const items = (environments ?? []).map((environment) => ({ value: environment.id, label: environment.name }));
	// This device's machine is the list's first.
	const machine = (draft.kind === "edited" ? draft.machine : preset?.machine) ?? items[0]?.value ?? null;
	const folder = draft.kind === "edited" ? draft.folder : (preset?.folder ?? "");
	const { onReady } = props;
	useEffect(() => {
		const trimmed = folder.trim();
		if (draft.kind === "follows") onReady({});
		else
			onReady(trimmed === "" || machine === null ? { location: null } : { location: { machine, folder: trimmed } });
	}, [draft.kind, folder, machine, onReady]);
	return (
		<div className={styles.form} data-new-session="">
			<Dropdown.Root
				items={items}
				onValueChange={(value: string | null) => setDraft({ kind: "edited", machine: value, folder })}
				value={machine}
			>
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
				<Input
					data-field="folder"
					onValueChange={(value: string) => setDraft({ kind: "edited", machine, folder: value })}
					placeholder="/home/me/project"
					value={folder}
				/>
				<Field.Description>{t("folderHint")}</Field.Description>
				{folder.trim() === "" && me?.kind === "person" && device !== undefined && device !== "" ? (
					<DeviceNote workspace={props.workspace} caller={`person:${me.id}`} device={device} />
				) : null}
			</Field.Root>
		</div>
	);
}

/**
 * Says that a session made in `workspace` with no folder starts on no machine, when this device (`device`) is not
 * available to `caller` there (their answer on it: none; the store decides the same at the make).
 */
function DeviceNote(props: { readonly workspace: string; readonly caller: string; readonly device: string }) {
	const { t } = useMessages(messages);
	const params = { workspace: props.workspace, thing: props.device, caller: props.caller };
	const answer = useWatch(useLive(useHold(MyAnswer, params))?.answer);
	return answer === null ? <Field.Description data-no-machine="">{t("noMachineHere")}</Field.Description> : null;
}

/**
 * The step's choice: following the defaults, or edited (a machine, `null` for the list's first, and a folder, `""` for
 * the session's own).
 */
type Draft =
	| { readonly kind: "follows" }
	| { readonly kind: "edited"; readonly machine: string | null; readonly folder: string };

const FOLLOWS: Draft = { kind: "follows" };

/** The choice in an input this step handed before. The dialog keeps it as `JsonValue`, so its shape is read again. */
function draftOf(input: JsonValue | undefined): Draft {
	if (typeof input !== "object" || input === null || Array.isArray(input) || !("location" in input)) return FOLLOWS;
	const location = input.location;
	if (location === null) return { kind: "edited", machine: null, folder: "" };
	if (typeof location !== "object" || Array.isArray(location)) return FOLLOWS;
	const { machine, folder } = location;
	return typeof machine === "string" && typeof folder === "string" ? { kind: "edited", machine, folder } : FOLLOWS;
}

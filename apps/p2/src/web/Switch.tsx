// p2's switch: a setting that applies the moment it is flipped (a checkbox is for a choice a form submits later).
import { Switch as ElanorSwitch } from "@earendil-works/elanor-react";
import type { ReactNode } from "react";

/** A row with `label` and a switch at its end; `onChange` gets the new state as soon as it is flipped. */
export function Switch({
	label,
	checked,
	disabled = false,
	onChange,
}: {
	label: ReactNode;
	checked: boolean;
	disabled?: boolean;
	onChange: (checked: boolean) => void;
}) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: the switch inside is Elanor's (a button with role "switch").
		<label className="switch-row">
			<span className="switch-label">{label}</span>
			<ElanorSwitch.Root checked={checked} disabled={disabled} onCheckedChange={(next) => onChange(next)}>
				<ElanorSwitch.Thumb />
			</ElanorSwitch.Root>
		</label>
	);
}
